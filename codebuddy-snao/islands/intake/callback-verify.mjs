// 企微「接收消息」URL 验证服务（临时用途：只为解锁"企业可信IP"）
// 实现企微 AES 解密：AES-256-CBC，key = base64decode(EncodingAESKey + "=")，IV = key 前 16 字节
// 明文 = random(16) + msg_len(4, 网络字节序) + msg + receiveid
import { createServer } from 'node:http';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '..', 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const PORT = Number(process.env.PORT ?? 7800);
const AES_KEY_B64 = (env.WECOM_CALLBACK_AESKEY ?? '').trim();
const TOKEN = (env.WECOM_CALLBACK_TOKEN ?? '').trim();
console.log('AESKEY 长度', AES_KEY_B64.length, 'TOKEN 长度', TOKEN.length);

function decrypt(encrypted) {
  const key = Buffer.from(AES_KEY_B64 + '=', 'base64');
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const pad = buf[buf.length - 1];
  const content = buf.subarray(0, buf.length - pad);
  const msgLen = content.readUInt32BE(16);
  return content.subarray(20, 20 + msgLen).toString('utf8');
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const echostr = url.searchParams.get('echostr');
  console.log(new Date().toISOString().slice(11, 19), req.method, url.pathname, echostr ? '(带 echostr)' : '');

  if (req.method === 'GET' && echostr) {
    try {
      const plain = decrypt(echostr);
      console.log('  → 解密成功，回显:', plain);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(plain);
      return;
    } catch (e) {
      console.log('  ✗ 解密失败', String(e));
      res.writeHead(500); res.end('decrypt failed'); return;
    }
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}).listen(PORT, '127.0.0.1', () => console.log(`回调验证服务 http://127.0.0.1:${PORT}`));
