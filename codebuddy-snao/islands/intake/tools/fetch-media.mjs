import { readFileSync, writeFileSync } from 'node:fs';
import AiBot from '@wecom/aibot-node-sdk';

const env = Object.fromEntries(
  readFileSync('/Users/luhoupang/Downloads/cobuddy-anc/codebuddy-snao/deploy/.env', 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const url = process.argv[2];
const aeskey = process.argv[3];
const ws = new AiBot.WSClient({ botId: env.WECOM_AIBOT_ID, secret: env.WECOM_AIBOT_SECRET });
const out = await ws.downloadFile(url, aeskey);
writeFileSync('/tmp/wecom-image-raw.bin', out.buffer);
console.log('downloaded', out.buffer.length, 'bytes; filename=', out.filename);
console.log('magic', out.buffer.subarray(0, 8).toString('hex'));
