# 03 — Production checklist

Before you flip `USE_BATCH_MINT=true` on mainnet.

## Pre-flight

- [ ] `npm run check-amendment` reports `enabled: true` on your
      target node (currently xrplcluster.com for mainnet).
- [ ] `npm run probe` reports `✅ yes` (xrpl.js ≥ 4.3; 5.0+ preferred).
- [ ] `ACCOUNT=<treasury> npm run verify-formula` returns
      `✅ formula matches ledger state`.  If it doesn't, the
      prediction will be wrong on EVERY mint — do not proceed.
- [ ] Testnet smoke mint via `npm run mint` succeeds (both the
      Batch path AND the legacy fallback — toggle `USE_BATCH_MINT`
      to test both).

## Deploy sequence

1. Deploy code **with `USE_BATCH_MINT=false`** first.  Verify
   legacy mint path still works end-to-end in prod.  The mutex
   added for the Batch path also benefits legacy — confirm there's
   no regression from serializing wallet access.
2. Set `USE_BATCH_MINT=true`.  Restart.
3. Mint ONE test domain / NFT.  Verify on explorer:
   - Outer Batch tx `tesSUCCESS`
   - MintedNFTokens incremented
   - Inner Mint tx found by hash, `tesSUCCESS`
   - Inner CreateOffer tx found by hash, `tesSUCCESS`
   - New NFTokenOffer in account state
4. Watch logs for 10 minutes.  Pattern you want to see:
   ```
   [mint] <item> → batch OK · mint_tx XX · nft XX
   ```
   Pattern that's acceptable (fallback):
   ```
   [mint] batch failed → falling back to legacy: <reason>
   ```
   Pattern that's NOT acceptable (silent data drop):
   ```
   outer tesSUCCESS, no fallback, no recovery → investigate NOW
   ```

## Rollback

Flip `USE_BATCH_MINT=false`, restart.  Legacy path 100%
unchanged.  Nothing on-chain to clean up.

## Monitoring (recommended metrics)

| Metric | What it tells you |
|---|---|
| `mint.batch.success` counter | Batch is doing its job |
| `mint.batch.fallback` counter | Batch path hit the safety net |
| `mint.batch.fallback_reason` by error | Which failure dominates (prediction? autofill? inner tec?) |
| `mint.legacy.success` counter | Baseline — should drop as Batch takes over |
| `mint.latency_ms` histogram | Should drop ~50% when Batch rate approaches 100% |
| `treasury.minted_nftokens` gauge | Sanity — only one process mints on this wallet |

If `mint.batch.fallback` rate stays > ~5% for an hour, something
is systemically broken.  Investigate before it becomes 100%.

## Operational notes

- **One process per treasury wallet.** The in-process mutex only
  protects against races *within* a single Node process.  Running
  two BE replicas against the same treasury wallet reintroduces
  the race — use a leader election (Redis / etcd / database row
  lock) or a dedicated mint worker queue.
- **Fee buffer.**  `maxFeeXRP` in the xrpl.js Client defaults to
  `'2'` XRP.  Batch fees are tiny (~48 drops) so this is fine.
  Lower it to `'0.001'` if you want a tight fee cap in prod.
- **xrpl.js version.**  Pin a known-good minor (e.g. `"xrpl": "~5.3.0"`)
  so a `^` floating version doesn't silently break your Batch
  autofill between deploys.
- **Treasury wallet state.**  If someone creates Tickets on the
  treasury wallet, autofill may try to assign them to Batch outer.
  We strip them defensively (see `src/mintBatch.ts`), but prefer
  to never create tickets on the mint wallet in the first place.
- **Webhook idempotency.**  If your pipeline posts webhooks after
  the mint lands, make sure they're keyed on the NFTokenID or
  mint tx hash — a fallback that succeeded via legacy must not
  double-fire the webhook from an earlier failed Batch attempt.

## When to re-evaluate

- xrpl.js ships a Batch helper that fixes autofill quirks → drop
  the TicketSequence strip.
- Rippled adds a `BatchExecutions` metadata field → drop the
  per-inner `tx` lookup.
- You start minting with multiple inner tx types in the same Batch
  (e.g. Mint + CreateOffer + Memo-logging tx) → check inner Fee
  sum and TokenSequence formula still match.

## When NOT to use this in production

- You can't accept the ~48-drop wasted outer fee on every failed
  Batch attempt (unlikely to matter at mainnet base fee).
- Your use case doesn't actually need atomicity (the sequential
  path works fine for independent operations).
- Your treasury wallet is co-signed by multiple actors who each
  mint independently — the shared-process mutex won't help.  Use
  a queue + leader instead.
