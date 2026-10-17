/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  xrpl-nft-batch-mint — all mint logic in one file                 ║
 * ║                                                                   ║
 * ║  Read top-to-bottom.  Each section is self-contained and the      ║
 * ║  public entry point (`mintNftWithOffer`) is at the bottom.        ║
 * ║                                                                   ║
 * ║  Section map                                                      ║
 * ║    1. Constants           — Batch + NFToken flag numbers           ║
 * ║    2. Types               — public argument / result shapes        ║
 * ║    3. Wallet mutex        — serialize mints per signing wallet     ║
 * ║    4. xrpl.js probe       — does this xrpl.js know Batch?          ║
 * ║    5. NFTokenID predict   — XLS-20 formula (⚠ FirstNFTokenSequence)║
 * ║    6. Build Batch outer   — assemble unsigned tx                   ║
 * ║    7. Verify inner exec   — look up inner tx hashes (critical!)    ║
 * ║    8. Mint — batch path   — the fast atomic path                   ║
 * ║    9. Mint — legacy path  — fallback sequential mint               ║
 * ║   10. Public entry        — mintNftWithOffer()                     ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 */

import {
    Client, Wallet,
    convertStringToHex, decodeAccountID, encodeForSigning,
    getNFTokenID, hashes, isoTimeToRippleTime, xrpToDrops,
    type TxResponse,
} from 'xrpl';

/* ═══════════════════════════════════════════════════════════════════
   1. CONSTANTS
   ─── Flag numbers from XLS-56 (Batch) and XLS-20 (NFToken).
   ═══════════════════════════════════════════════════════════════════ */

/** XLS-56 Batch mode flags — exactly one must be set on the outer. */
export const BATCH_FLAG_ALL_OR_NOTHING = 0x00010000;
export const BATCH_FLAG_ONLY_ONE       = 0x00020000;
export const BATCH_FLAG_UNTIL_FAILURE  = 0x00040000;
export const BATCH_FLAG_INDEPENDENT    = 0x00080000;

/** REQUIRED on every inner tx in a Batch, OR'd with the inner's own flags. */
export const BATCH_FLAG_INNER_TXN = 0x40000000;

/** NFTokenMint flags. */
export const NFT_FLAG_BURNABLE     = 0x00000001;
export const NFT_FLAG_ONLY_XRP     = 0x00000002;
export const NFT_FLAG_TRANSFERABLE = 0x00000008;

/** NFTokenCreateOffer flags. */
export const NFT_OFFER_FLAG_SELL = 0x00000001;


/* ═══════════════════════════════════════════════════════════════════
   2. TYPES
   ═══════════════════════════════════════════════════════════════════ */

export interface MintArgs {
    client: Client;
    wallet: Wallet;
    /** r-address of the sell-offer destination. */
    buyer:  string;
    /** Metadata URI stored in NFTokenMint (plain string, ≤256 bytes). */
    uri:    string;
    /** Optional overrides. */
    taxon?:       number;   // default 0
    transferFee?: number;   // default 0
    expireDays?:  number;   // default 365
}

export interface MintResult {
    via:       'batch' | 'legacy';
    nftokenId: string;
    mintTx:    string;
    offerTx:   string;
}


/* ═══════════════════════════════════════════════════════════════════
   3. WALLET MUTEX
   ─── Serialize all mint operations that touch the same signing
       wallet so Sequence + MintedNFTokens stay monotonic across
       concurrent requests.
   ═══════════════════════════════════════════════════════════════════ */

const _walletLocks: Record<string, Promise<unknown>> = Object.create(null);

export async function withWalletLock<T>(
    wallet: { classicAddress: string },
    fn: () => Promise<T>,
): Promise<T> {
    const key = wallet.classicAddress;
    const prev = _walletLocks[key] ?? Promise.resolve();
    const next = prev.then(fn, fn) as Promise<T>;
    _walletLocks[key] = next.catch(() => {});
    try {
        return await next;
    } finally {
        if (_walletLocks[key] === next.catch(() => {})) {
            delete _walletLocks[key];
        }
    }
}


/* ═══════════════════════════════════════════════════════════════════
   4. xrpl.js PROBE
   ─── Does the installed xrpl.js know about the Batch tx type?
       Cached on first call; fallback-friendly if the build is old.
   ═══════════════════════════════════════════════════════════════════ */

let _batchSupportCache: boolean | null = null;

export function hasBatchSupport(): boolean {
    if (_batchSupportCache !== null) return _batchSupportCache;
    try {
        encodeForSigning({
            TransactionType: 'Batch',
            Account:         'rrrrrrrrrrrrrrrrrrrrrhoLvTp',   // account zero
            Flags:           BATCH_FLAG_ALL_OR_NOTHING,
            Sequence:        1,
            Fee:             '100',
            SigningPubKey:   '',
            RawTransactions: [{
                RawTransaction: {
                    TransactionType: 'AccountSet',
                    Account:         'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
                    Flags:           BATCH_FLAG_INNER_TXN,
                    Sequence:        2,
                    Fee:             '0',
                    SigningPubKey:   '',
                },
            }],
        } as never);
        _batchSupportCache = true;
    } catch (e) {
        _batchSupportCache = false;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[batch] xrpl.js cannot encode Batch — falling back to sequential. Error:', msg);
    }
    return _batchSupportCache;
}


/* ═══════════════════════════════════════════════════════════════════
   5. XLS-20 NFTokenID PREDICTION
   ─── ⚠️ The common pitfall: using plain MintedNFTokens as the
       TokenSequence.  Accounts with NFToken v2 state carry a
       FirstNFTokenSequence base, and the real formula is:
           TokenSequence = FirstNFTokenSequence + MintedNFTokens
       Miss the base and your predicted ID shifts by tens of millions,
       inner CreateOffer dies with tecNO_ENTRY, the whole batch
       rolls back silently.  See docs/02-gotchas.md § #1.
   ═══════════════════════════════════════════════════════════════════ */

const TAXON_MULT = 384160001n;
const TAXON_ADD  = 2459n;
const MOD_32     = 0x100000000n;

export async function getNextTokenSequence(client: Client, wallet: Wallet): Promise<number> {
    const info = await client.request({
        command:      'account_info',
        account:      wallet.classicAddress,
        ledger_index: 'current',   // 'current', not 'validated' — see pitfalls doc
    });
    const acct   = info.result.account_data as Record<string, unknown>;
    const minted = parseInt(String(acct.MintedNFTokens      ?? 0), 10);
    const first  = parseInt(String(acct.FirstNFTokenSequence ?? 0), 10);
    return first + minted;
}

export function predictNFTokenID(args: {
    account:       string;
    flags?:        number;
    transferFee?:  number;
    taxon?:        number;
    tokenSequence: number;
}): string {
    const { account, flags = 0, transferFee = 0, taxon = 0, tokenSequence } = args;

    // Taxon XOR obfuscation.  BigInt arithmetic because
    // tokenSequence * 384_160_001 overflows int32 quickly.
    const seqMul = (BigInt(tokenSequence) * TAXON_MULT + TAXON_ADD) % MOD_32;
    const obfuscatedTaxon = Number((BigInt(taxon) ^ seqMul) % MOD_32);

    const accountIdHex = Buffer.from(decodeAccountID(account)).toString('hex');

    // Pack: Flags(2B) | TransferFee(2B) | AccountID(20B) | Taxon(4B) | TokenSeq(4B)
    const hex =
          flags.toString(16).padStart(4, '0')
        + transferFee.toString(16).padStart(4, '0')
        + accountIdHex
        + obfuscatedTaxon.toString(16).padStart(8, '0')
        + tokenSequence.toString(16).padStart(8, '0');

    return hex.toUpperCase();
}


/* ═══════════════════════════════════════════════════════════════════
   6. BUILD BATCH OUTER
   ─── Assemble the unsigned Batch outer with two inner txs:
       NFTokenMint + NFTokenCreateOffer referencing the predicted ID.
       Keep inner fields MINIMAL — autofill handles Fee / SigningPubKey
       / Sequence on all three (outer + both inners).
   ═══════════════════════════════════════════════════════════════════ */

async function buildMintOfferBatch(args: MintArgs): Promise<{
    outer:       Record<string, unknown>;
    predictedId: string;
}> {
    const {
        client, wallet, buyer, uri,
        taxon = 0, transferFee = 0, expireDays = 365,
    } = args;

    const mintFlags = NFT_FLAG_TRANSFERABLE;

    // Predict the NFTokenID the inner mint will produce.
    const tokenSeq    = await getNextTokenSequence(client, wallet);
    const predictedId = predictNFTokenID({
        account:       wallet.classicAddress,
        flags:         mintFlags,
        transferFee,
        taxon,
        tokenSequence: tokenSeq,
    });

    // Sell-offer expiration — Ripple epoch seconds (not Unix epoch).
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + expireDays);
    const expiration = isoTimeToRippleTime(expireDate);

    // Inner 1 — NFTokenMint.  Only business fields; autofill does the rest.
    const innerMint = {
        TransactionType: 'NFTokenMint',
        Account:         wallet.classicAddress,
        URI:             convertStringToHex(uri),
        Flags:           mintFlags | BATCH_FLAG_INNER_TXN,
        TransferFee:     transferFee,
        NFTokenTaxon:    taxon,
    };

    // Inner 2 — NFTokenCreateOffer (sell-offer to `buyer`).
    const innerOffer = {
        TransactionType: 'NFTokenCreateOffer',
        Account:         wallet.classicAddress,
        NFTokenID:       predictedId,
        Amount:          xrpToDrops('0'),
        Flags:           NFT_OFFER_FLAG_SELL | BATCH_FLAG_INNER_TXN,
        Expiration:      expiration,
        Destination:     buyer,
        Memos:           [{ Memo: { MemoData: convertStringToHex(uri) } }],
    };

    const outer = {
        TransactionType: 'Batch',
        Account:         wallet.classicAddress,
        Flags:           BATCH_FLAG_ALL_OR_NOTHING,
        RawTransactions: [
            { RawTransaction: innerMint  },
            { RawTransaction: innerOffer },
        ],
    };

    return { outer, predictedId };
}


/* ═══════════════════════════════════════════════════════════════════
   7. VERIFY INNER EXECUTION
   ─── ⚠️ Critical, often-skipped step.  Per xrpl.org:
       "The outer transaction returns tesSUCCESS even if some or all
        inner transactions fail.  Only inner transactions actually
        committed to the ledger are included.  There is no
        BatchExecutions field in outer meta — look up each inner
        transaction by its hash."
   ═══════════════════════════════════════════════════════════════════ */

async function verifyInnerExecution(
    client: Client,
    outerResult: Record<string, any>,
    autofilled: Record<string, any>,
): Promise<{
    mintHash:    string;
    mintResult:  Record<string, any> | null;
    offerHash:   string;
    offerResult: Record<string, any> | null;
}> {
    const outerCode = outerResult.result?.meta?.TransactionResult;
    if (outerCode !== 'tesSUCCESS') {
        throw new Error('[batch] outer tx failed: ' + outerCode);
    }

    const rawTxs = (
          outerResult.result?.tx_json?.RawTransactions
       ?? outerResult.result?.RawTransactions
       ?? autofilled?.RawTransactions
       ?? []
    ) as Array<{ RawTransaction: Record<string, unknown> }>;

    if (rawTxs.length < 2) {
        throw new Error('[batch] cannot read RawTransactions from submit result (got ' + rawTxs.length + ')');
    }

    const mintTx   = (rawTxs[0].RawTransaction ?? rawTxs[0]) as never;
    const offerTx  = (rawTxs[1].RawTransaction ?? rawTxs[1]) as never;
    const mintHash  = hashes.hashSignedTx(mintTx);
    const offerHash = hashes.hashSignedTx(offerTx);

    const [mintResult, offerResult] = await Promise.all([
        queryInnerWithRetry(client, mintHash),
        queryInnerWithRetry(client, offerHash),
    ]);

    return { mintHash, mintResult, offerHash, offerResult };
}

async function queryInnerWithRetry(
    client: Client, hash: string, maxAttempts = 6, delayMs = 500,
): Promise<Record<string, any> | null> {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const res = await client.request({ command: 'tx', transaction: hash });
            if (res?.result) return res.result as Record<string, any>;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/txnNotFound/i.test(msg)) throw e;
        }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
}


/* ═══════════════════════════════════════════════════════════════════
   8. MINT — BATCH PATH
   ─── The 5 steps of a successful Batch mint, in order.
   ═══════════════════════════════════════════════════════════════════ */

async function mintViaBatch(opts: MintArgs): Promise<MintResult> {
    // Step 1 — build the unsigned outer + remember the predicted ID.
    const { outer, predictedId } = await buildMintOfferBatch(opts);

    // Step 2 — autofill fills Sequence/Fee/LastLedgerSeq on outer AND
    // on each inner.  Strip any opportunistic TicketSequence autofill
    // may attach when the account has unused Tickets (would collide
    // with Sequence → temSEQ_AND_TICKET).
    const autofilled = await opts.client.autofill(outer as never) as Record<string, any>;
    if (autofilled.TicketSequence !== undefined) delete autofilled.TicketSequence;
    for (const rt of (autofilled.RawTransactions ?? []) as Array<{ RawTransaction: Record<string, unknown> }>) {
        const inner = rt.RawTransaction as Record<string, unknown> | undefined;
        if (inner && inner.TicketSequence !== undefined) delete inner.TicketSequence;
    }

    // Step 3 — sign + submit via submitAndWait with autofill:false
    // (we already autofilled above).
    const result = await opts.client.submitAndWait(autofilled as never, {
        wallet:   opts.wallet,
        autofill: false,
    }) as TxResponse;

    // Step 4 — verify inner execution.  outer tesSUCCESS alone is
    // NOT proof — this is the step every tutorial forgets.
    const { mintHash, mintResult, offerHash, offerResult } =
        await verifyInnerExecution(opts.client, result as unknown as Record<string, any>, autofilled);

    if (!mintResult)  throw new Error('[batch] inner Mint tx not found on ledger · hash: '  + mintHash);
    if (!offerResult) throw new Error('[batch] inner CreateOffer tx not found on ledger · hash: ' + offerHash);

    const mintCode  = mintResult.meta?.TransactionResult;
    const offerCode = offerResult.meta?.TransactionResult;
    if (mintCode  !== 'tesSUCCESS') throw new Error('[batch] inner Mint failed: '        + mintCode);
    if (offerCode !== 'tesSUCCESS') throw new Error('[batch] inner CreateOffer failed: ' + offerCode);

    // Step 5 — prefer the real NFTokenID from meta over the prediction
    // (defense-in-depth; they will match if we got here).
    const realId = getNFTokenID(mintResult.meta) ?? predictedId;

    return { via: 'batch', nftokenId: realId, mintTx: mintHash, offerTx: offerHash };
}


/* ═══════════════════════════════════════════════════════════════════
   9. MINT — LEGACY SEQUENTIAL FALLBACK
   ─── The proven two-tx path.  Used when:
         - USE_BATCH_MINT env flag is false
         - xrpl.js build doesn't know Batch
         - Batch attempt threw for any reason
   ═══════════════════════════════════════════════════════════════════ */

async function mintViaLegacy(opts: MintArgs): Promise<MintResult> {
    const { client, wallet, buyer, uri } = opts;

    // Step A — mint the NFT.
    const mintTx = await client.submitAndWait({
        TransactionType: 'NFTokenMint',
        Account:         wallet.classicAddress,
        URI:             convertStringToHex(uri),
        Flags:           NFT_FLAG_TRANSFERABLE,
        TransferFee:     0,
        NFTokenTaxon:    0,
    } as never, { wallet }) as TxResponse;

    const mintMeta = (mintTx.result as any).meta ?? {};
    if (mintMeta.TransactionResult !== 'tesSUCCESS') {
        throw new Error('[legacy] mint failed: ' + mintMeta.TransactionResult);
    }
    const nftokenId = getNFTokenID(mintMeta);
    if (!nftokenId) throw new Error('[legacy] could not read nftoken_id from mint meta');

    // Step B — create the sell-offer referencing the real NFTokenID.
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + 365);
    const offerTx = await client.submitAndWait({
        TransactionType: 'NFTokenCreateOffer',
        Account:         wallet.classicAddress,
        NFTokenID:       nftokenId,
        Amount:          xrpToDrops('0'),
        Flags:           NFT_OFFER_FLAG_SELL,
        Expiration:      isoTimeToRippleTime(expireDate),
        Destination:     buyer,
    } as never, { wallet }) as TxResponse;

    const offerMeta = (offerTx.result as any).meta ?? {};
    if (offerMeta.TransactionResult !== 'tesSUCCESS') {
        throw new Error('[legacy] offer failed: ' + offerMeta.TransactionResult);
    }

    return {
        via:       'legacy',
        nftokenId,
        mintTx:    (mintTx.result as any).hash,
        offerTx:   (offerTx.result as any).hash,
    };
}


/* ═══════════════════════════════════════════════════════════════════
   10. PUBLIC ENTRY
   ─── Chooses between the Batch path and the legacy fallback,
       guarded by the per-wallet mutex, env flag, and xrpl.js probe.
       Users always get a mint — Batch failures silently drop back
       to legacy.
   ═══════════════════════════════════════════════════════════════════ */

export async function mintNftWithOffer(opts: MintArgs): Promise<MintResult> {
    return withWalletLock(opts.wallet, async () => {
        const canBatch = String(process.env.USE_BATCH_MINT ?? '').toLowerCase() === 'true'
                      && hasBatchSupport();
        if (canBatch) {
            try {
                return await mintViaBatch(opts);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn('[mint] batch failed → falling back to legacy:', msg);
            }
        }
        return mintViaLegacy(opts);
    });
}
