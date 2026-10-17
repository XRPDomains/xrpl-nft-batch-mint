# 01 — Overview

## Problem

Minting an XRPL NFT and offering it for sale normally takes **two
transactions in sequence**: `NFTokenMint`, then
`NFTokenCreateOffer` that references the just-minted `NFTokenID`.
You can't skip the sequencing because the mint hasn't produced
the ID yet when you're building the offer.

That means:

- **~8s latency** on mainnet (two ledger closes).
- **Race window** — between the mint landing and the offer landing,
  the NFT exists without a sell offer.  If the second tx fails
  (network, fee bump, timeout), the issuer is left with an
  orphaned NFT and has to burn or re-offer it.
- **Two signatures**, two round-trips, two retry loops to maintain.

## What `Batch` solves

XLS-56 `BatchV1_1` (enabled on mainnet) packages up to 8 inner
transactions into one outer `Batch` tx, executed atomically with
one of four modes.  For dependent mint+offer flow the right mode
is **`tfAllOrNothing`**: both inners succeed together, or both
roll back together.

| | Sequential | Batch (`tfAllOrNothing`) |
|---|---|---|
| Latency | 2 ledger closes (~8s) | 1 ledger close (~4s) |
| Signatures | 2 | 1 (outer) |
| Fee | base × 2 (per inner) | base × (2 + inners) ≈ same |
| Race window | yes — mint without offer | **none** |
| Rollback on failure | manual (burn orphan NFT) | **automatic** |

## The one trick that trips everyone up

The inner `NFTokenCreateOffer` has to reference the `NFTokenID` of
the inner `NFTokenMint` — but at build time, that NFT doesn't exist
on-chain yet.  You have to **predict** the ID using XLS-20's
deterministic formula.

Get the prediction wrong by even one, and:

1. The predicted NFTokenID doesn't match the one the engine will
   assign.
2. Inner `CreateOffer` preclaims against a non-existent NFT →
   `tecNO_ENTRY`.
3. In `tfAllOrNothing`, that rolls back the whole batch.
4. The outer tx still returns `tesSUCCESS` (the wrapper succeeded;
   the inners "atomically did nothing").
5. `meta.BatchExecutions` doesn't exist on the outer — the docs
   explicitly say you must query each inner by its own hash to
   see whether it ran.

The combination of "outer tesSUCCESS" + "inner tx not findable"
is the classic silent fail that eats a day of debugging if you
don't know to look for it.  Pitfall #1 and Pitfall #2 in
`02-gotchas.md`.

## The 5-step flow

Every function in `src/` maps to one step:

```
1. Build          ← src/buildBatch.js
2. Predict ID     ← src/predictNftId.js
3. Autofill       ← src/mintBatch.js (strips opportunistic
                                      TicketSequence)
4. Submit         ← src/mintBatch.js (client.submitAndWait)
5. Verify inner   ← src/verifyInner.js (hashSignedTx + tx command)
```

A safety net wraps everything: on any Batch failure, fall back to
the proven sequential path.  Users always get a mint.

## When Batch is NOT the right tool

- **Independent operations** (e.g. two unrelated Payments to
  different recipients that don't need atomicity): use
  `tfIndependent`, or just submit them separately.
- **Non-dependent mint + offer** (minting many unrelated NFTs,
  each with its own offer): sequential is simpler and the latency
  isn't a user-facing problem.
- **> 8 inner txs**: Batch caps at 8.  Loop and run multiple
  Batches sequentially.
- **Need per-inner retry logic**: Batch rolls back as a unit.

## Next

→ Read `02-gotchas.md` before writing any code.
→ Then run `scripts/verify-nftid-formula.js` against YOUR
  treasury account to confirm the prediction formula matches
  what the ledger produces for your account.
→ Then `npm run mint` on testnet.
→ Only then flip `USE_BATCH_MINT=true` on mainnet.
