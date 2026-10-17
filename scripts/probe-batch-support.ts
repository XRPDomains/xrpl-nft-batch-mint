/**
 * Quick: does the installed xrpl.js know about the Batch tx type?
 *
 *   npm run probe
 */
import { createRequire } from 'module';
import { hasBatchSupport } from '../src/mint.js';

const require = createRequire(import.meta.url);
const xrplPkg = require('xrpl/package.json') as { version: string };

console.log('xrpl.js version:', xrplPkg.version);
console.log('Batch supported:', hasBatchSupport() ? '✅ yes' : '❌ no — upgrade to xrpl@^5');
