// P0 第 9 步 ②：验 AIBot 主动推送（不依赖任何回调帧）
// 用法：node push-test.mjs <chatid>
//   单聊的 chatid 就是对方 userid（例如 guoshuai）；群聊是群 chatid。
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

const target = process.argv[2] || 'guoshuai';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ws = new AiBot.WSClient({ botId: env.WECOM_AIBOT_ID, secret: env.WECOM_AIBOT_SECRET });
ws.on('error', (e) => log('✗ error:', e?.message ?? e));
ws.on('authenticated', async () => {
  log('✓ 认证成功，准备主动推送 →', target);
  try {
    await ws.sendMessage(target, {
      msgtype: 'markdown',
      markdown: { content: `**SNAO 主动推送测试**\n\n如果审批能在没人问 bot 的情况下推到你手机上，这条就是证据。\n\n目标会话：\`${target}\`` },
    });
    log('✓ 主动推送成功');
  } catch (e) {
    log('✗ 主动推送失败：', e?.message ?? e);
  } finally {
    setTimeout(() => { ws.disconnect(); process.exit(0); }, 1500);
  }
});
ws.connect();
setTimeout(() => { log('超时退出'); process.exit(1); }, 20_000);
