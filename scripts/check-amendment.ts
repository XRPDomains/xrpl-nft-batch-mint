/**
 * Query the connected node for BatchV1_1 amendment status.
 *
 *   npm run check-amendment
 */
import 'dotenv/config';
import { Client } from 'xrpl';

(async () => {
    const wss = process.env.XRPL_WSS ?? 'wss://xrplcluster.com';
    const client = new Client(wss);
    await client.connect();
    try {
        const r = await client.request({
            command: 'feature',
            feature: 'BatchV1_1',
        } as never) as unknown as { result: Record<string, { name: string; enabled: boolean; supported: boolean }> };

        const entries = Object.values(r.result ?? {});
        const feat = entries.find((f) => f && f.name === 'BatchV1_1');
        if (!feat) {
            console.log('BatchV1_1: not known on this node.');
            return;
        }
        console.log('BatchV1_1');
        console.log('  enabled:   ', feat.enabled);
        console.log('  supported: ', feat.supported);
        console.log('  node:      ', wss);
    } finally {
        await client.disconnect();
    }
})();
