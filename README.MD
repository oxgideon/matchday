# MATCHDAY

Live World Cup match odds and points-based predictions, powered by TxLINE, with sign-up via a Solana (devnet) wallet.

Points, not real money or SOL, are wagered — this keeps the submission simple and avoids gambling/securities complications while still exercising TxLINE as a live data input.

## What's here

- `generateWallet.js` — creates the one devnet wallet the backend uses to subscribe + activate TxLINE's free World Cup tier
- `txline.js` — TxLINE auth/subscribe/activate + fixtures/odds/scores fetchers
- `server.js` — Express API: wallet-signature login, match list, bet placement, settlement
- `public/index.html` — frontend: connect Phantom, see matches/odds, place bets

## Setup (do this in order)

1. **Install deps**
   ```
   npm install
   ```

2. **Generate the backend's devnet wallet**
   ```
   node generateWallet.js
   ```
   Copy the printed public key, fund it at https://faucet.solana.com (select Devnet). Copy the printed secret key array — you'll need it for Railway.

3. **Get the TxLINE devnet IDL** (I couldn't fetch this automatically — GitHub blocks it)
   - Open https://github.com/txodds/tx-on-chain
   - Go to `examples/devnet/idl/txoracle.json`
   - Click "Raw", save the file as `idl/txoracle.json` in this project

4. **Firebase**
   - Use your existing Firebase project
   - Project Settings → Service Accounts → Generate new private key
   - You'll paste the whole JSON as one Railway env var

5. **Railway env vars**
   ```
   TXLINE_WALLET_SECRET_KEY = [the array from step 2]
   FIREBASE_SERVICE_ACCOUNT_KEY = {the whole service account JSON, one line}
   ```

6. **Deploy** — push to your GitHub repo, connect it in Railway, deploy. Watch the logs for:
   - `Subscribed: <txSig>` — on-chain subscribe worked
   - `TxLINE API token activated.` — ready to fetch data
   - `Sync complete.` — first match sync ran

## Things to double check once it's live (I couldn't test against the real API)

- The exact JSON shape of `/api/odds/snapshot/:fixtureId` and `/api/scores/snapshot/:fixtureId` — `txline.js`'s odds/score parsing has reasonable assumptions baked in (`price1`/`priceX`/`price2` for odds, `Stats["1"]`/`Stats["2"]` for goals) but you should `console.log` one raw response and adjust field names in `syncMarkets()` in `server.js` if they don't match.
- The World Cup `FixtureId` list in `server.js` is hardcoded from TxLINE's published schedule — the final is TODAY, July 19, 19:00 UTC, so for your demo video lean on **already-completed matches** (quarterfinals/semis have real scores) rather than waiting on the final.

## Demo video checklist (per the hackathon requirements)

- Show the problem (fans want live odds + a lightweight prediction game)
- Walk through: connect wallet → see live odds → place a bet with points → match settles → payout lands
- Point out where TxLINE data is powering the screen (odds panel, live score, settlement)
- List the TxLINE endpoints used: `/auth/guest/start`, `/api/token/activate`, `/api/fixtures/snapshot`, `/api/odds/snapshot/:id`, `/api/scores/snapshot/:id`

