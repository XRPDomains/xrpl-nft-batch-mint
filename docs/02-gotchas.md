# XRPL Batch + NFToken Mint — A Developer's Field Guide

*Lessons from shipping NFTokenMint + NFTokenCreateOffer in a single
atomic `Batch` transaction on XRPL Mainnet.*

**Audience:** devs integrating the `BatchV1_1` amendment for any flow
where an inner tx depends on another inner tx's output (mint-and-offer,
mint-and-escrow, mint-and-transfer, etc.).

**Why this exists:** the public docs are accurate but spread across 4
pages. The failure modes are silent — the outer tx returns `tesSUCCESS`
even when every inner is dropped. We spent ~a day burning fees chasing
ghosts. This is the write-up we wish existed when we started.

---

## TL;DR

If you're building NFT mint + sell-offer in one `Batch`:

1. **Predict the right `NFTokenID`.** XLS-20 v2 formula is
   `TokenSequence = FirstNFTokenSequence + MintedNFTokens`, **not**
   `MintedNFTokens` alone. If your issuer's `AccountRoot` has
   `FirstNFTokenSequence` set, forgetting it will shift your predicted
   ID by tens of millions — every inner `NFTokenCreateOffer` dies with
   `tecNO_ENTRY`, every `tfAllOrNothing` outer silently rolls back,
   outer still returns `tesSUCCESS`, your webhooks never fire, and you
   waste 48 drops per attempt wondering what's wrong.

2. **Don't trust `outer tesSUCCESS` alone.** It only confirms the
   outer wrapper processed. You MUST query each inner tx hash via `tx`
   command to know whether inners actually executed.

3. **Don't set `inner.Sequence = 0`.** Rippled treats this as
   `temSEQ_AND_TICKET` ("sets neither"). Let xrpl.js autofill handle
   inner Sequences (it assigns `outer.Sequence + i + 1`).

4. **Use `tfIndependent` for debugging only.** It's the only mode that
   shows per-inner failure codes. In production use `tfAllOrNothing`
   with a legacy sequential fallback.

5. **Lock the signing wallet.** XLS-20 token-sequence prediction races
   if two concurrent requests mint on the same account. Mutex per
   wallet.

---

## The flow we were building

XRPDomains issues each domain as an NFT on XRPL and ships it to the
buyer as a Sell Offer. Legacy flow was two sequential tx:

```
submit NFTokenMint → wait ledger close → read actual NFTokenID from meta
submit NFTokenCreateOffer (uses that NFTokenID) → wait ledger close
```

Two round-trips, ~8s on mainnet. Not great UX, especially under load.

With `BatchV1_1` enabled on mainnet we wanted:

```
submit Batch { Mint, CreateOffer(predicted NFTokenID) } → ~4s
```

Atomic, one signature, one network round-trip. Perfect — in theory.

---

## Pitfall #1 — The NFTokenID formula is NOT what you think

### The wrong code

```js
// WRONG — produces the ID you'd get on an account WITHOUT
// FirstNFTokenSequence (older accounts, or test wallets).
function predictNFTokenID(account, flags, transferFee, taxon, mintedNFTokens) {
  const tokenSequence = mintedNFTokens;      // ← WRONG
  // ... pack Flags | TransferFee | AccountID | obfuscatedTaxon | tokenSequence
}
```

### Why it silently fails

Mint actually succeeds — but with a **different** `NFTokenID` than
you predicted. The inner `CreateOffer` references the predicted ID,
which doesn't exist on the ledger yet (and never will) → `tecNO_ENTRY`.

In `tfAllOrNothing` mode: inner fail → whole batch rolled back → outer
`tesSUCCESS` with no committed inners → `MintedNFTokens` doesn't change
→ nothing visible on-chain to tell you *what* happened.

### How we found it

We looked at **legacy** mint txs on our treasury wallet. For sequence
78422668 (just before our batch attempts), the actual NFTokenID tail
bytes were `04ACA648` = decimal 78,423,624. But our predicted ID had
tail `000025A0` (= decimal 9632 = our `MintedNFTokens` reading).

78,423,624 − 9,632 = **78,413,992** ≈ our `FirstNFTokenSequence:
78413991`. Off-by-one from `MintedNFTokens` sampling, exact match on
the base.

### The right code

```js
function predictNFTokenID(account, flags, transferFee, taxon,
                           firstNFTokenSequence, mintedNFTokens) {
  // XLS-20 v2 — accounts that have ever enabled the NFToken amendments
  // carry a FirstNFTokenSequence base. Add it; don't just use the
  // raw MintedNFTokens counter.
  const tokenSequence = (firstNFTokenSequence || 0) + mintedNFTokens;
  // ... same packing as before
}

async function getNextTokenSequence(client, wallet) {
  const info = await client.request({
    command: 'account_info',
    account: wallet.classicAddress,
    ledger_index: 'current',     // 'current' not 'validated' — see pitfall #5
  });
  const acct = info.result.account_data;
  const minted = parseInt(acct.MintedNFTokens || 0, 10);
  const first  = parseInt(acct.FirstNFTokenSequence || 0, 10);
  return first + minted;         // the TokenSequence the NEXT mint will carry
}
```

### How to verify your prediction

Before trusting your implementation, grab ONE legacy mint tx from your
treasury wallet. Read `AccountRoot.FirstNFTokenSequence` and
`AccountRoot.MintedNFTokens` **as of the ledger right before that mint**.
Compute `first + minted`, convert to 8-char hex, and compare with the
last 8 chars of the actual `nftoken_id`. They must match exactly.

If they don't match, you have another spec bug — figure it out before
submitting a single Batch.

---

## Pitfall #2 — `outer tesSUCCESS` tells you nothing about inners

### The doc quote everyone misses

> Each outer transaction contains the metadata for its sequence and fee
> processing, **not** for the inner transaction processing. Any error
> code is only based on the outer transaction processing (for example,
> sequence and fee), and **it returns a `tesSUCCESS` result even if
> inner transaction processing fails**.
>
> — xrpl.org/docs/concepts/transactions/batch-transactions

Also:

> Only the inner transactions that are **actually committed** to the
> ledger are included.

Translation: in `tfAllOrNothing`, if any inner fails:
- all inners are rolled back
- **none** are committed to the ledger
- the outer still returns `tesSUCCESS`
- `meta.BatchExecutions` does **not** exist on the outer tx

So you cannot inspect inner results from the outer meta. You must:

```js
import { hashes } from 'xrpl';

// AFTER submitAndWait resolves
for (const rt of result.result.tx_json.RawTransactions) {
  const innerHash = hashes.hashSignedTx(rt.RawTransaction);
  try {
    const innerResult = await client.request({
      command: 'tx',
      transaction: innerHash,
    });
    const code = innerResult.result.meta?.TransactionResult;
    console.log('inner', rt.RawTransaction.TransactionType, '→', code);
  } catch (e) {
    // txnNotFound → inner was rolled back (tfAllOrNothing + any failure)
    //            → OR inner failed at tem/tef level (never committed)
  }
}
```

**Important**: `txnNotFound` is NOT the same as `tecXXX`. A `tec` result
means the inner was validated and committed on-chain with a failure
code. A `txnNotFound` means the inner was never committed — either
because `tfAllOrNothing` rolled it back, or because it failed at
`tem*`/`tef*`/`ter*` preflight/preclaim/retry.

---

## Pitfall #3 — Debug with `tfIndependent`, ship with `tfAllOrNothing`

In `tfAllOrNothing`, a failing inner tears down everything and leaves
no on-chain trace. You cannot debug this directly.

Switch temporarily to `tfIndependent` (`0x00080000`). This mode commits
each inner independently with its own `tec` result code, so you can
see exactly which inner failed and why.

```
BATCH_MODE=independent  // in your env for debugging
```

Our logs went from this (useless):

```
[batch] outer tesSUCCESS but BatchExecutions missing/incomplete
```

To this (actionable):

```
[batch] inner lookup results · mint: tesSUCCESS · offer: tecNO_ENTRY
```

Instantly clear: Mint works, Offer references something that doesn't
exist → prediction bug (pitfall #1).

**Never run `tfIndependent` in production** unless you genuinely want
partial-success semantics. For mint+offer flow it would leave the user
with an NFT but no sell offer — your webhook pipeline would miss the
`offer_id` and the UX would hang.

---

## Pitfall #4 — Inner `Sequence` rules

The spec says:

> Must include either a `TicketSequence` or `Sequence` value **greater
> than zero**.

And in the error-code table:

> `temSEQ_AND_TICKET`: One of the inner transactions sets both
> `TicketSequence` and a non-zero `Sequence`, **or sets neither**.

So you have exactly three valid options for an inner:

1. `Sequence > 0`, no `TicketSequence` → normal path
2. `TicketSequence` set, no `Sequence` or `Sequence = 0` → ticket path
3. Both unset / `Sequence = 0` with no `TicketSequence` → **rejected**

Easiest answer: don't set these on the inner at all. xrpl.js
`client.autofill()` for Batch does the right thing:

```ts
if (inner.Sequence == null && inner.TicketSequence == null) {
  // For inner.Account === outer.Account:
  inner.Sequence = outer.Sequence + i + 1  // 1-indexed per inner position
}
```

If you pre-fill `inner.Sequence = 0` thinking rippled will treat it as
"use ticket from outer" — it won't. You'll get `temSEQ_AND_TICKET`
pre-submit and your tx never reaches the ledger.

---

## Pitfall #5 — Concurrency on the signing wallet

`NFTokenID` prediction depends on `MintedNFTokens` at mint time. If two
concurrent requests both read `MintedNFTokens = N`, they'll both predict
NFTokens with `TokenSequence = N`, but only one actually gets `N` —
the other mints at `N+1` and its predicted ID is wrong → `tecNO_ENTRY`
on CreateOffer.

Fix: serialize all mint operations on a given wallet with an in-process
mutex. Simple promise chain works:

```js
const walletLocks = Object.create(null);

async function withWalletLock(wallet, fn) {
  const key = wallet.classicAddress;
  const prev = walletLocks[key] || Promise.resolve();
  const next = prev.then(fn, fn);
  walletLocks[key] = next.catch(() => {});
  return next;
}

// Usage
return withWalletLock(treasuryWallet, async () => {
  return mintBatch(item, treasuryWallet, client);
});
```

Also use `ledger_index: 'current'` not `'validated'` on your
`account_info` lookup, so you see any mint that's in the current open
ledger but not yet validated:

```js
const info = await client.request({
  command: 'account_info',
  account: wallet.classicAddress,
  ledger_index: 'current',   // 'validated' lags by a ledger
});
```

---

## Pitfall #6 — `client.autofill()` can add `TicketSequence` to outer

If your signing account has unused tickets, xrpl.js autofill will
opportunistically assign one. For a Batch outer this collides with the
Sequence autofill also sets, producing `temSEQ_AND_TICKET`.

Defensive strip after autofill:

```js
const autofilled = await client.autofill(outer);
if (autofilled.TicketSequence !== undefined) {
  console.log('[batch] stripping outer TicketSequence (xrpl.js opportunistic fill)');
  delete autofilled.TicketSequence;
}
// Same strip on inner just in case:
autofilled.RawTransactions.forEach(rt => {
  if (rt.RawTransaction.TicketSequence !== undefined) {
    delete rt.RawTransaction.TicketSequence;
  }
});
```

If you don't have tickets on the account, this won't fire — but it's a
cheap safety net.

---

## Pitfall #7 — xrpl.js version matters

- `xrpl.js < 4.3`: no Batch tx type at all. `encode()` throws.
- `xrpl.js 4.x`: Batch autofill present but with rough edges.
- `xrpl.js 5.0+`: full Batch support, including `signMultiBatch` for
  multi-account batches, correct autofill of inner Sequence.

Probe at startup instead of guessing:

```js
let batchSupportCache = null;
function hasBatchSupport() {
  if (batchSupportCache !== null) return batchSupportCache;
  try {
    xrpl.encodeForSigning({
      TransactionType: 'Batch',
      Account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
      Flags: 0x00010000,
      Sequence: 1,
      Fee: '100',
      SigningPubKey: '',
      RawTransactions: [{ RawTransaction: {
        TransactionType: 'AccountSet',
        Account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
        Flags: 0x40000000,
        Sequence: 1,
        Fee: '0',
        SigningPubKey: '',
      }}],
    });
    batchSupportCache = true;
  } catch (_) {
    batchSupportCache = false;
  }
  return batchSupportCache;
}
```

If `false`, skip the batched path entirely and run your legacy
sequential flow. Don't wait for the first real request to find out.

---

## Pitfall #8 — Fee computation

Batch outer `Fee` is:

```
Fee = baseFee × (2 + numSignersOnOuter) + sum(innerBaseFees)
```

For 2 inner NFToken ops on mainnet (base fee = 10 drops × 1.2 cushion
= 12), with 1 outer signer:
`Fee = 12 × (2 + 1) + 12 + 12 = 60` drops? Not quite — xrpl.js uses:

```
Fee = baseFee × 2 + sum(innerBaseFees)   // for single signer
    = 12 × 2 + 24
    = 48 drops
```

xrpl.js `client.autofill()` handles this correctly. **Do not set
`outer.Fee` manually** — you'll either overpay or get `tecINSUF_FEE`.

If you absolutely must know the formula, read
`xrpl.js/src/sugar/autofill.ts` under
`calculateFeePerTransactionType` → the `tx.TransactionType === 'Batch'`
branch. It calls itself recursively for each inner and sums.

---

## The complete pattern (minted & shipping on mainnet)

```js
const BATCH_FLAG_ALL_OR_NOTHING = 0x00010000;
const BATCH_FLAG_INNER_TXN      = 0x40000000;

async function mintViaBatch(item, wallet, client) {
  return withWalletLock(wallet, async () => {
    // 1. Snapshot MintedNFTokens + FirstNFTokenSequence atomically.
    const tokenSeq = await getNextTokenSequence(client, wallet);
    const predictedId = predictNFTokenID(
      wallet.classicAddress, 8 /* tfTransferable */, 0, 0, tokenSeq,
    );

    // 2. Build inner txs — minimal fields, let autofill handle Fee/
    //    SigningPubKey/Sequence.
    const innerMint = {
      TransactionType: 'NFTokenMint',
      Account:         wallet.classicAddress,
      URI:             xrpl.convertStringToHex(item.url),
      Flags:           8 | BATCH_FLAG_INNER_TXN,
      TransferFee:     0,
      NFTokenTaxon:    0,
    };
    const innerOffer = {
      TransactionType: 'NFTokenCreateOffer',
      Account:         wallet.classicAddress,
      NFTokenID:       predictedId,
      Amount:          '0',
      Flags:           1 | BATCH_FLAG_INNER_TXN,  // tfSellOffer
      Destination:     item.owner,
      Expiration:      xrpl.isoTimeToRippleTime(oneYearFromNow()),
    };

    // 3. Outer Batch.
    const outer = {
      TransactionType: 'Batch',
      Account:         wallet.classicAddress,
      Flags:           BATCH_FLAG_ALL_OR_NOTHING,
      RawTransactions: [
        { RawTransaction: innerMint  },
        { RawTransaction: innerOffer },
      ],
    };

    // 4. Autofill + strip opportunistic TicketSequence + submit.
    const autofilled = await client.autofill(outer);
    delete autofilled.TicketSequence;
    autofilled.RawTransactions.forEach(rt => {
      delete rt.RawTransaction.TicketSequence;
    });
    const result = await client.submitAndWait(autofilled, {
      wallet, autofill: false,
    });

    // 5. outer tesSUCCESS alone is NOT proof — query each inner.
    if (result.result.meta.TransactionResult !== 'tesSUCCESS') {
      throw new Error('[batch] outer failed: ' +
        result.result.meta.TransactionResult);
    }

    const mintHash  = xrpl.hashes.hashSignedTx(
      result.result.tx_json.RawTransactions[0].RawTransaction);
    const offerHash = xrpl.hashes.hashSignedTx(
      result.result.tx_json.RawTransactions[1].RawTransaction);

    const [mintRes, offerRes] = await Promise.all([
      queryInnerWithRetry(client, mintHash),
      queryInnerWithRetry(client, offerHash),
    ]);

    if (!mintRes || mintRes.meta.TransactionResult !== 'tesSUCCESS') {
      throw new Error('[batch] inner Mint failed');
    }
    if (!offerRes || offerRes.meta.TransactionResult !== 'tesSUCCESS') {
      throw new Error('[batch] inner CreateOffer failed');
    }

    // 6. Prefer actual NFTokenID from inner Mint meta over prediction.
    const realId = xrpl.getNFTokenID(mintRes.meta) || predictedId;

    return { nftokenId: realId, mintTx: mintHash, offerTx: offerHash };
  });
}

async function queryInnerWithRetry(client, hash, maxAttempts = 6) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await client.request({ command: 'tx', transaction: hash });
      if (r?.result) return r.result;
    } catch (e) {
      if (!/txnNotFound/i.test(e?.message || '')) throw e;
    }
    await new Promise(res => setTimeout(res, 500));
  }
  return null;
}
```

---

## Keep a safety net

Even with everything right, keep your legacy sequential path and
automatically fall back to it on any batch failure:

```js
async function mintOneItem(item, wallet, client) {
  if (process.env.USE_BATCH_MINT === 'true' && hasBatchSupport()) {
    try {
      return await mintViaBatch(item, wallet, client);
    } catch (err) {
      console.warn('[mint] batch failed, falling back to sequential:',
        err.message);
      // fall through
    }
  }
  return mintSequential(item, wallet, client);
}
```

Our users never see a dropped mint. Every batch failure gets caught,
logged, and the proven 2-tx path takes over. A failed batch costs 48
drops (basically free) and buys us a working mint.

---

## Verification checklist before you flip the flag in production

- [ ] A legacy sequential mint on your treasury: capture the actual
      `nftoken_id`, confirm `(FirstNFTokenSequence + MintedNFTokens)`
      formula matches the last 8 hex chars.
- [ ] A batch mint in `tfIndependent` mode: both inners should report
      `tesSUCCESS` individually.
- [ ] A batch mint in `tfAllOrNothing` mode: both inners should report
      `tesSUCCESS`, `MintedNFTokens` should increment, a new
      NFTokenOffer should appear in account state.
- [ ] A concurrent-request stress test (two mints fired simultaneously):
      both should complete without `tefPAST_SEQ` or wrong-NFTokenID
      failures. The mutex is doing its job.
- [ ] `/health` endpoint reports `batch.active: true` and `kit_supports:
      true`.
- [ ] Rollback plan tested: set `USE_BATCH_MINT=false`, restart,
      confirm legacy still works end-to-end.

---

## Proof of concept — mainnet tx

Real atomic Mint + CreateOffer in a single Batch tx on XRPL Mainnet:

<https://bithomp.com/tx/97BF5AA9A0A7A41C89AE7CF31ACE352B92B46664D88BCA8AFB41BDD28F394D9C>

Inner 1 (`NFTokenMint`) and inner 2 (`NFTokenCreateOffer`) both have
their own `tesSUCCESS` and own on-ledger metadata, linked back to the
outer via `ParentBatchID`.

---

## References

- [XRPL Batch (reference)](https://xrpl.org/docs/references/protocol/transactions/types/batch)
- [Batch Transactions (concept)](https://xrpl.org/docs/concepts/transactions/batch-transactions)
- [Send a Single Account Batch (tutorial)](https://xrpl.org/docs/tutorials/best-practices/transaction-sending/send-a-single-account-batch-transaction)
- [XLS-56 (Batch spec)](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0056d-batch)
- [XLS-20 (NFToken spec, for the NFTokenID formula)](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0020d-non-fungible-tokens)
- xrpl.js source: `packages/xrpl/src/sugar/autofill.ts` → `autofillBatchTxn`
- xrpl.js source: `packages/xrpl/src/Wallet/batchSigner.ts` → multi-account signing

---

*Written after shipping XRPDomains v3 mint flow on BatchV1_1 mainnet,
October 2026. Questions / corrections welcome — tag us on X at
[@xrpdomain](https://twitter.com/xrpdomain).*
