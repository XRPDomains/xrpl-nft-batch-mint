/**
 * Independent check — does our predictNFTokenID() output match the
 * real NFTokenID the ledger would assign the NEXT mint on this
 * account?  Compare against the most recent historical mint.
 *
 *   XRPL_WSS=wss://xrplcluster.com \
 *   ACCOUNT=rXXX... npm run verify-formula
 */
import 'dotenv/config';
import { Client, getNFTokenID } from 'xrpl';
import { getNextTokenSequence, predictNFTokenID } from '../src/mint.js';

(async () => {
    const wss     = process.env.XRPL_WSS ?? 'wss://xrplcluster.com';
    const account = process.env.ACCOUNT ?? process.argv[2];
    if (!account) {
        console.error('Pass an account:  ACCOUNT=rXXX... npm run verify-formula');
        process.exit(1);
    }

    const client = new Client(wss);
    await client.connect();
    try {
        // Pretend `account` is a wallet for the helper's purposes.
        const wallet = { classicAddress: account } as never;

        const info = await client.request({
            command:      'account_info',
            account,
            ledger_index: 'validated',
        });
        const acct   = info.result.account_data as Record<string, unknown>;
        const first  = parseInt(String(acct.FirstNFTokenSequence ?? 0), 10);
        const minted = parseInt(String(acct.MintedNFTokens      ?? 0), 10);
        console.log('AccountRoot');
        console.log('  FirstNFTokenSequence:', first);
        console.log('  MintedNFTokens:      ', minted);
        console.log(`  TokenSequence next = first + minted = ${first + minted} ` +
            `(hex: ${(first + minted).toString(16).padStart(8, '0').toUpperCase()})`);
        console.log('');

        // Predict with default params (tfTransferable, taxon 0, fee 0).
        const seq = await getNextTokenSequence(client, wallet);
        const predicted = predictNFTokenID({
            account,
            flags:         8,
            transferFee:   0,
            taxon:         0,
            tokenSequence: seq,
        });
        console.log('Predicted NFTokenID for NEXT mint:');
        console.log('  ' + predicted);
        console.log('');

        // Pull the most recent NFTokenMint tx from this account.
        const txs = await client.request({
            command: 'account_tx',
            account,
            limit:   50,
        });
        const list = txs.result.transactions ?? [];
        const mint = list.find((t: any) => {
            const type = t?.tx_json?.TransactionType ?? t?.tx?.TransactionType;
            return type === 'NFTokenMint';
        }) as any;

        if (!mint) {
            console.log('No historical NFTokenMint found — nothing to cross-check.');
            return;
        }
        const meta = mint.meta ?? {};
        const nftId = meta.nftoken_id ?? getNFTokenID(meta);
        console.log('Most recent historical mint');
        console.log('  hash:      ', mint.hash ?? mint.tx?.hash);
        console.log('  nftoken_id:', nftId);
        if (nftId) {
            const histSeq = parseInt((nftId as string).slice(-8), 16);
            const expected = histSeq + 1;
            console.log('  TokenSequence of that mint:', histSeq);
            console.log('  Next expected:              ', expected);
            console.log(expected === (first + minted)
                ? '  ✅ formula matches ledger state'
                : '  ❌ formula drift — check FirstNFTokenSequence handling');
        }
    } finally {
        await client.disconnect();
    }
})();
