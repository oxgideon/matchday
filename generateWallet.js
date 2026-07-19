// generateWallet.js
//
// Creates a throwaway Solana keypair for DEVNET only. This wallet is used
// server-side (never exposed to users) to:
//   1. Submit the one-time on-chain `subscribe` transaction to TxLINE's
//      free World Cup tier
//   2. Sign the activation message that turns that subscription into a
//      usable API token
//
// Run once:
//   node generateWallet.js
//
// Then:
//   1. Fund the printed public key with devnet SOL:
//      solana airdrop 2 <PUBLIC_KEY> --url https://api.devnet.solana.com
//      (or use https://faucet.solana.com and select Devnet)
//   2. Copy the secret key array into Railway as TXLINE_WALLET_SECRET_KEY
//   3. Never commit the printed secret key to git or share it publicly.

const { Keypair } = require("@solana/web3.js");

const wallet = Keypair.generate();

console.log("=== MATCHDAY devnet activation wallet ===");
console.log("Public Key (fund this with devnet SOL):");
console.log(wallet.publicKey.toBase58());
console.log("");
console.log("Secret Key (set this as TXLINE_WALLET_SECRET_KEY in Railway):");
console.log(JSON.stringify(Array.from(wallet.secretKey)));
console.log("");
console.log("This wallet only ever touches devnet. Do not send it real funds.");

