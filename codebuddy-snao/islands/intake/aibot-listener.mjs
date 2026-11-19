// 岛 03 的采集器：企微 AIBot 长连接 → 收媒体 → 交给岛 03
// 这条路不需要备案域名、不需要可信IP（只有机器人长连接）
//
// 用法：node islands/intake/aibot-listener.mjs
// 指令：给 SNAO 发文件/图片即入库；发「/del 文件名」即标记删除

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '..', 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const ISLAND = process.env.SNAO_INTAKE ?? 'http://127.0.0.1:7400';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ws = new AiBot.WSClient({ botId: env.WECOM_AIBOT_ID, secret: env.WECOM_AIBOT_SECRET });

ws.on('authenticated', () => log('✓ 长连接已建立，等文件/图片…'));
ws.on('error', (e) => log('✗ error:', e?.message ?? e));
ws.on('disconnected', (r) => log('… 断开，SDK 退避重连', r ?? ''));

const ack = (frame, text) => {
  try {
    ws.replyStream(frame, `s-${Date.now()}`, text, true);
  } catch (e) {
    log('回执失败', e?.message ?? e);
  }
};

/** 按魔数猜类型（图片/文件消息不总带文件名） */
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0x47 && buf[1] === 0x49) return { ext: 'gif', mime: 'image/gif' };
  if (buf.subarray(0, 4).toString() === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf[0] === 0x50 && buf[1] === 0x4b) return { ext: 'zip', mime: 'application/zip' };
  return { ext: 'bin', mime: 'application/octet-stream' };
}

/** 媒体消息统一入口：企微给的都是 url + aeskey，下载后交给岛 03 */
async function handleMedia(frame, kind) {
  const b = frame?.body ?? {};
  const m = b[kind] ?? {};
  const owner = b.from?.userid ?? 'unknown';
  const spaceId = b.chattype === 'group' ? b.chatid : owner;
  log(`── 收到 ${kind} ── 来自 ${owner}（${b.chattype}）msgid=${b.msgid ?? '-'}`);

  try {
    const { buffer, filename } = await ws.downloadFile(m.url, m.aeskey);
    const guess = sniff(buffer);
    const name = filename ?? m.filename ?? `${kind}-${b.msgid ?? Date.now()}.${guess.ext}`;

    const res = await fetch(`${ISLAND}/v1/ingest/file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_kind: 'wecom-aibot',
        source_doc_id: b.msgid ?? `${owner}-${Date.now()}`,
        space_id: spaceId,
        space_kind: b.chattype === 'group' ? 'group' : 'single',
        owner_subject: owner,
        name,
        mime: m.content_type ?? guess.mime,
        size: buffer.length,
        content_base64: buffer.toString('base64'),
      }),
    }).then((r) => r.json());

    if (res.ok) {
      log(`  ✓ 已入库 #${res.id}，sha ${String(res.sha256).slice(0, 12)}`);
      ack(frame, `已收下《${name}》（${(buffer.length / 1024).toFixed(1)} KB），归属 ${owner}。`);
    } else {
      log('  ✗ 入库失败', JSON.stringify(res));
      ack(frame, '入库失败，看日志。');
    }
  } catch (e) {
    log('  ✗ 下载失败', e?.message ?? e);
    ack(frame, '下载失败，看日志。');
  }
}

for (const kind of ['file', 'image', 'video', 'voice']) {
  ws.on(`message.${kind}`, (frame) => handleMedia(frame, kind));
}

/** 文本指令：/del 文件名 */
ws.on('message.text', async (frame) => {
  const b = frame?.body ?? {};
  const text = (b.text?.content ?? '').trim();
  log(`── 收到文本 ── ${b.from?.userid}: ${text}`);

  if (text.startsWith('/del ')) {
    const name = text.slice(5).trim();
    const res = await fetch(`${ISLAND}/v1/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
    log('  删除结果', JSON.stringify(res));
    ack(frame, res.ok ? `已标记删除《${name}》` : `没找到《${name}》`);
    return;
  }
  ack(frame, '把文件或图片发给我就会入库；发「/del 文件名」可标记删除。');
});

ws.connect();
process.on('SIGINT', () => { ws.disconnect(); process.exit(0); });
log('岛 03 采集器启动（AIBot 长连接）');
