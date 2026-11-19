// SNAO P0 探针 v2：企微 AIBot 长连接（官方 SDK）
// 目的（实现方案 P0 第 9 步）：
//   ① 能否收到私聊/群消息，并拿到发送人
//   ② 能否主动发消息（决定审批怎么通知人）
//
// v1 手写客户端的问题：把服务端错误帧误判成 subscribe ack，且无退避 → 触发 45009 限流。
// v2 改用官方 SDK（@wecom/aibot-node-sdk 1.0.7），它内置认证 / 心跳 / 指数退避重连。
//
// 用法：node probe-aibot.mjs
//       --push <秒>  收到过消息后，N 秒时主动推一条（验 ②）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import AiBot from '@wecom/aibot-node-sdk';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', 'deploy', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const BOT_ID = env.WECOM_AIBOT_ID;
const SECRET = env.WECOM_AIBOT_SECRET;
if (!BOT_ID || !SECRET) {
  console.error('缺少 WECOM_AIBOT_ID / WECOM_AIBOT_SECRET');
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pushAfter = Number(process.argv.includes('--push') ? process.argv[process.argv.indexOf('--push') + 1] : 0);

const ws = new AiBot.WSClient({ botId: BOT_ID, secret: SECRET });
let lastChatId = null;

ws.on('authenticated', () => log('✓ 认证成功（长连接已建立）'));
ws.on('error', (e) => log('✗ error:', e?.message ?? e));
ws.on('disconnected', (r) => log('… 断开，SDK 将退避重连：', r ?? ''));

const onMessage = (tag) => (frame) => {
  const b = frame?.body ?? {};
  const isGroup = b.chattype === 'group';
  if (isGroup && b.chatid) lastChatId = b.chatid;
  else if (b.from?.userid) lastChatId = b.from.userid;

  log(`── 收到 ${tag} 消息 ──`);
  log('  chattype :', b.chattype);
  log('  chatid   :', b.chatid ?? '(单聊无)');
  log('  from     :', b.from?.userid);
  log('  msgtype  :', b.msgtype);
  log('  content  :', b.text?.content ?? b.voice?.content ?? '(非文本)');
  log('  msgid    :', b.msgid);
  log('  → 发送人可得 =', Boolean(b.from?.userid), '/ 会话 id =', isGroup ? b.chatid : b.from?.userid);

  try {
    ws.replyStream(frame, `s-${Date.now()}`, `收到（${tag}），SNAO 探针在线。`, true);
    log('  → 已回执（replyStream）');
  } catch (e) {
    log('  → 回执失败：', e?.message ?? e);
  }
};

for (const t of ['text', 'image', 'voice', 'file', 'mixed', 'video']) ws.on(`message.${t}`, onMessage(t));
ws.on('event.enter_chat', (frame) => log('事件：进入会话', JSON.stringify(frame?.body ?? {}).slice(0, 160)));

ws.connect();

if (pushAfter > 0) {
  setTimeout(() => {
    if (!lastChatId) {
      log('⚠ 还没收到过消息，无法验主动推送');
      return;
    }
    ws.sendMessage(lastChatId, { msgtype: 'markdown', markdown: { content: '**SNAO 主动推送测试**：审批通知会走这条路。' } })
      .then(() => log('✓ 主动推送已发出 →', lastChatId))
      .catch((e) => log('✗ 主动推送失败：', e?.message ?? e));
  }, pushAfter * 1000);
}

process.on('SIGINT', () => {
  ws.disconnect();
  process.exit(0);
});
log('探针 v2 启动（官方 SDK），等待消息…');
