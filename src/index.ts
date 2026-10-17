/**
 * CLI entry — mints one NFT and creates its sell-offer in a single
 * Batch tx (falling back to sequential if Batch is unavailable).
 *
 *   npm run mint
 */

import 'dotenv/config';
import { Client, Wallet } from 'xrpl';
import { mintNftWithOffer } from './mint.js';

async function main(): Promise<void> {
    const wss   = process.env.XRPL_WSS;
    const seed  = process.env.TREASURY_SEED;
    const buyer = process.env.BUYER_ADDRESS;
    const uri   = process.env.NFT_URI ?? 'https://example.com/metadata/sample-nft.json';

    if (!wss || !seed || !buyer) {
        console.error('Missing env — copy .env.example to .env and fill '
            + 'XRPL_WSS, TREASURY_SEED, BUYER_ADDRESS.');
        process.exit(1);
    }

    const client = new Client(wss);
    await client.connect();
    const wallet = Wallet.fromSeed(seed);

    console.log('Treasury:', wallet.classicAddress);
    console.log('Buyer:   ', buyer);
    console.log('URI:     ', uri);
    console.log('Mode:    ', process.env.USE_BATCH_MINT === 'true'
        ? 'Batch (preferred)'
        : 'Legacy sequential');
    console.log('');

    const t0 = Date.now();
    try {
        const r = await mintNftWithOffer({ client, wallet, buyer, uri });
        const ms = Date.now() - t0;
        console.log(`✅ Minted via ${r.via} in ${ms} ms`);
        console.log(`   NFTokenID: ${r.nftokenId}`);
        console.log(`   Mint tx:   ${r.mintTx}`);
        console.log(`   Offer tx:  ${r.offerTx}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('❌', msg);
        process.exitCode = 1;
    } finally {
        await client.disconnect();
    }
}

main().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
});
