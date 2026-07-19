// subscribeAndActivate.js — one-time script: subscribes on-chain (devnet free tier)
// and activates your TxLINE API token. Run once, copy the printed apiToken into
// Railway as TXLINE_API_TOKEN, then switch the Start Command back to "node server.js".

const anchor = require("@coral-xyz/anchor");
const txoracleIdl = require("./idl/txoracle.json");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const axios = require("axios");
const nacl = require("tweetnacl");

const RPC_URL = "https://api.devnet.solana.com";
const API_ORIGIN = "https://txline-dev.txodds.com";
const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");

const SERVICE_LEVEL_ID = 1; // free tier
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = []; // empty = standard bundle (includes World Cup free tier)

async function main() {
  const secretKeyArray = JSON.parse(process.env.WALLET_SECRET_KEY);
  const payer = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
  console.log("Using wallet:", payer.publicKey.toBase58());

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const program = new anchor.Program(txoracleIdl, provider);

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log("Subscribing on-chain...");
  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: payer.publicKey,
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
  console.log("Subscribed. txSig:", txSig);

  console.log("Activating API token...");
  const authResponse = await axios.post(`${API_ORIGIN}/auth/guest/start`);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, payer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activationResponse = await axios.post(
    `${API_ORIGIN}/api/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;

  console.log("========================================");
  console.log("SUCCESS — copy this into Railway as TXLINE_API_TOKEN:");
  console.log(apiToken);
  console.log("========================================");
}

main().catch((err) => {
  console.error("subscribeAndActivate failed:", err.response?.data || err.message);
  process.exit(1);
});
