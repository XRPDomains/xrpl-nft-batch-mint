# xrpl-nft-batch-mint

> Mint an XRPL NFT and create its sell-offer in a **single atomic
> `Batch` transaction**.  Runnable TypeScript example + developer
> field guide extracted from the production XRPDomains mint flow.

[![xrpl.js](https://img.shields.io/badge/xrpl.js-%5E5.3-blue)](https://github.com/XRPLF/xrpl.js)
[![typescript](https://img.shields.io/badge/typescript-%5E5.5-blue)](https://www.typescriptlang.org/)
[![amendment](https://img.shields.io/badge/BatchV1__1-mainnet%20enabled-brightgreen)](https://xrpl.org/resources/known-amendments#batchv1_1)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

---

## What this does

XLS-56 `Batch` lets you atomically execute up to 8 transactions
from one or more accounts.  This example packs two inner txs —
`NFTokenMint` and `NFTokenCreateOffer` — into one `Batch` outer
with `tfAllOrNothing`:

```
Before (2 round-trips, ~8s)        After (1 round-trip, ~4s)
───────────────────────            ───────────────────────
submit NFTokenMint          ───▶   submit Batch {
await ledger close                      NFTokenMint,
read actual NFTokenID                   NFTokenCreateOffer
submit NFTokenCreateOffer           }   ◀─── atomic, both-or-neither
await ledger close                 await ledger close
```

Same cost (sum of inner fees + outer wrapper fee ≈ identical to
sequential).  Zero race window between the mint and the offer.
Automatic fallback to the sequential path if anything goes wrong.

### Field proof — a real mainnet tx produced by this pattern

<https://bithomp.com/tx/97BF5AA9A0A7A41C89AE7CF31ACE352B92B46664D88BCA8AFB41BDD28F394D9C>

The outer tx is `tesSUCCESS`; look up each `RawTransaction` by its
own hash to see the inner `tesSUCCESS` with linked `ParentBatchID`.

---

## Why this exists

The docs are accurate but spread across four pages, and the Batch
failure modes are **silent**: the outer tx returns `tesSUCCESS`
even when every inner is rolled back.  Our team burned a day
chasing ghosts before we found the one-line bug (XLS-20 formula
missing `FirstNFTokenSequence`).

This project exists so you don't have to.

👉 **Read `docs/02-gotchas.md` before writing any code.**  It's the
field guide we wish existed when we started — eight pitfalls, each
with the wrong code, why it silently fails, and the fix.

---

## Quick start

```bash
# 1. Clone + install
git clone <this-repo>
cd xrpl-nft-batch-mint
npm install

# 2. Configure
cp .env.example .env
#    edit .env:
#      XRPL_WSS=wss://s.altnet.rippletest.net:51233   (testnet first)
#      TREASURY_SEED=sEd...                           (test wallet seed)
#      BUYER_ADDRESS=rXXX...                          (recipient)
#      USE_BATCH_MINT=true

# 3. Sanity checks before you spend fees
npm run check-amendment       # is BatchV1_1 enabled on your node?
npm run probe                 # does your xrpl.js know Batch?
ACCOUNT=rYourTreasury node scripts/verify-nftid-formula.js
                              # does your NFTokenID prediction match?

# 4. Mint
npm run mint
```

Example output:

```
Treasury: rExampleTreasuryAddrOfThisTestWallet
Buyer:    rExampleBuyerAddrOfYourTestWallet
URI:      https://example.com/metadata/sample-nft.json
Mode:     Batch (preferred)

✅ Minted via batch in 3842 ms
   NFTokenID: 00080000...04ACA64C
   Mint tx:   B02E84ED...9F3A1
   Offer tx:  55AEA715...1F7D2
```

---

## Project layout

```
xrpl-nft-batch-mint/
├── README.md
├── package.json
├── .env.example
├── tsconfig.json             strict TS, NodeNext module resolution
├── src/
│   ├── mint.ts               ⭐ ALL mint logic in one file, 10 clearly
│   │                           labelled sections — read top-to-bottom
│   └── index.ts              CLI entry — ~50 lines, loads env + runs mint
├── scripts/
│   ├── probe-batch-support.ts
│   ├── check-amendment.ts
│   └── verify-nftid-formula.ts
└── docs/
    ├── 01-overview.md        Architecture + the 5-step flow
    ├── 02-gotchas.md         ⭐ The field guide — read this first
    └── 03-production.md      Pre-production checklist + monitoring
```

Runs via `tsx` with zero build step.  `npm run build` emits a
compiled `dist/` if you want plain Node consumption.

**Why one `mint.ts` instead of 7 split files?** For a learning
example, one file you can read top-to-bottom beats hopping across
modules.  The 10 labelled sections in `mint.ts` map 1:1 to the
flow described below.  Forking it into separate modules is a
one-command refactor if your production codebase prefers that.

---

## The 5-step flow

The `mintViaBatch()` function in `src/mint.ts` (section 8) is
literally these five steps.  Each maps to a section in `mint.ts`
AND a pitfall in `docs/02-gotchas.md`:

1. **Build** (`mint.ts` §6) — assemble the outer with two inner
   txs.  Inner fields kept MINIMAL — `TransactionType`, `Account`,
   business fields, and `Flags` with `tfInnerBatchTxn` set.
   Autofill handles `Fee`, `SigningPubKey`, `Sequence`.
2. **Predict** (`mint.ts` §5) — compute the NFTokenID the inner
   mint will produce, so the inner offer can reference it before
   the ledger assigns it for real.  Uses
   `FirstNFTokenSequence + MintedNFTokens` (⚠️ not just `MintedNFTokens`).
3. **Autofill + strip TicketSequence** (`mint.ts` §8 step 2) —
   `client.autofill(outer)` fills Sequence/Fee/LastLedgerSeq.  If
   the account has unused Tickets, autofill may opportunistically
   assign one; strip it or hit `temSEQ_AND_TICKET`.
4. **Submit** (`mint.ts` §8 step 3) — `submitAndWait(autofilled,
   { wallet, autofill: false })`.
5. **Verify inner execution** (`mint.ts` §7) — compute each inner's
   hash with `xrpl.hashes.hashSignedTx` and query the `tx` command.
   **This is the step every tutorial forgets.**  Outer `tesSUCCESS`
   says nothing about the inners.  In `tfAllOrNothing`, if any
   inner failed, the lookups return `txnNotFound` and the caller
   must fall back to legacy.

---

## Safety net

The public entry (`mint.ts` §10) always falls back to a proven
sequential mint on any Batch failure.  Users don't see dropped
mints:

```ts
if (process.env.USE_BATCH_MINT === 'true' && hasBatchSupport()) {
    try {
        return await mintViaBatch(opts);
    } catch (err) {
        console.warn('[mint] batch failed → fallback:', err.message);
    }
}
return mintViaLegacy(opts);
```

Flipping `USE_BATCH_MINT=false` reverts to the legacy path with
one env flag — perfect rollback in production.

---

## When you should NOT use this

- You can't tolerate a 48-drop wasted outer fee on failed
  Batch attempts (unlikely to matter — mainnet base fee is 10 drops).
- Your inner tx types aren't dependent on each other — in that
  case use `tfIndependent` and let each commit separately.
- You need more than 8 inner txs — Batch caps at 8.  Split or
  loop.
- You're on an XRPL fork where `BatchV1_1` isn't enabled yet.
  Run `npm run check-amendment` to confirm.

---

## Related reading

- [XLS-56 Batch Transaction spec](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0056d-batch)
- [XLS-20 NFToken spec](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0020d-non-fungible-tokens) (for the NFTokenID formula)
- [Official xrpl.org Batch concept](https://xrpl.org/docs/concepts/transactions/batch-transactions)
- [Official single-account Batch tutorial](https://xrpl.org/docs/tutorials/best-practices/transaction-sending/send-a-single-account-batch-transaction)
- [Known amendments — BatchV1_1](https://xrpl.org/resources/known-amendments#batchv1_1)

---

## Contributing

Spotted a pitfall we missed?  Have a working pattern for a
different inner tx combination (Mint + Escrow? Mint + Trust set?)?
Open a PR against `docs/02-gotchas.md` or add a sibling script
under `scripts/`.

MIT licensed.  Credit back to [XRPDomains](https://xrpdomains.xyz) is
appreciated but not required.
