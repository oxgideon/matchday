// txline.js — TxLINE devnet client for MATCHDAY
//
// SETUP REQUIRED BEFORE THIS WILL WORK:
//   1. Run `node generateWallet.js` and fund the printed public key with
//      devnet SOL (https://faucet.solana.com, select Devnet).
//   2. Set TXLINE_WALLET_SECRET_KEY in your environment to the printed array.
//   3. Grab the devnet IDL from TxODDS's repo and save it next to this file
//      as idl/txoracle.json:
//        https://github.com/txodds/tx-on-chain
//        -> examples/devnet/idl/txoracle.json
//      (GitHub blocks automated fetching, so this one file has to be pulled
//      by hand — open the link, click "Raw", save as idl/txoracle.json here.)
//
// Everything else below runs automatically on server start: it subscribes
// this wallet to TxLINE's free World Cup tier on devnet (one-time on-chain
// tx), activates an API token, and exposes getFixtures/getOdds/getScores.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const nacl = require("tweetnacl");
const anchor = require("@coral-xyz/anchor");
const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
} = require("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");

const RPC_URL = "https://api.devnet.solana.com";
const API_ORIGIN = "https://txline-dev.txodds.com";
const API_BASE = `${API_ORIGIN}/api`;
const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const SERVICE_LEVEL_ID = 1; // free World Cup tier
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = []; // standard free bundle

let jwt = null;
let apiToken = null;
let httpClient = null;

function loadWallet() {
  const raw = process.env.TXLINE_WALLET_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "TXLINE_WALLET_SECRET_KEY not set. Run `node generateWallet.js`, fund the wallet with devnet SOL, then set this env var."
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function loadIdl() {
  const idlPath = path.join(__dirname, "idl", "txoracle.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      "Missing idl/txoracle.json. Pull it from https://github.com/txodds/tx-on-chain (examples/devnet/idl/txoracle.json) and save it at that path."
    );
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

async function getGuestJwt() {
  const res = await axios.post(`${API_ORIGIN}/auth/guest/start`);
  return res.data.token;
}

/**
 * One-time on-chain subscribe to the free World Cup tier, then activate an
 * API token. Safe to call on every boot — if you want to avoid resubscribing
 * every restart, cache the txSig you get back and skip the subscribe step
 * on future runs (left simple here given the time crunch).
 */
async function subscribeAndActivate() {
  const wallet = loadWallet();
  const connection = new Connection(RPC_URL, "confirmed");
  const anchorWallet = new anchor.Wallet(wallet);
  const provider = new anchor.AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new anchor.Program(idl, provider);

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_MINT,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("Submitting devnet subscribe transaction...");
  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: TXL_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("Subscribed:", txSig);

  const guestJwt = await getGuestJwt();
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${guestJwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, wallet.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activationRes = await axios.post(
    `${API_BASE}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${guestJwt}` } }
  );

  jwt = guestJwt;
  apiToken = activationRes.data.token || activationRes.data;
  console.log("TxLINE API token activated.");
  buildHttpClient();
}

function buildHttpClient() {
  httpClient = axios.create({
    timeout: 30000,
    baseURL: API_ORIGIN,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
    },
  });
}

async function renewJwt() {
  jwt = await getGuestJwt();
  buildHttpClient();
}

async function withJwtRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await renewJwt();
      return await fn();
    }
    throw err;
  }
}

async function getFixtures() {
  return withJwtRetry(async () => {
    const res = await httpClient.get("/api/fixtures/snapshot");
    return res.data;
  });
}

async function getOdds(fixtureId) {
  return withJwtRetry(async () => {
    const res = await httpClient.get(`/api/odds/snapshot/${fixtureId}`);
    return res.data;
  });
}

async function getScores(fixtureId) {
  return withJwtRetry(async () => {
    const res = await httpClient.get(`/api/scores/snapshot/${fixtureId}`);
    return res.data;
  });
}

module.exports = { subscribeAndActivate, getFixtures, getOdds, getScores };

