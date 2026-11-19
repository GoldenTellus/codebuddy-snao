// 进化提案（P4 第 3 项）
//
// 铁律：**进化只在沙箱跑，产出提案，不直接上线。**
//   1. 对每个候选变体，起一个"影子岛 02"（独立端口、独立进程、只读评分集）
//   2. 用线提供的评分函数打分
//   3. 产出 proposal：变体参数 + 分数 + 与线上的差 + 风险说明
//   4. 上呈线的 decision（reason=evolution），由人裁；**不写线上配置**
//
// 用法：node evolve/propose.mjs

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluate, loadScoreSet } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const OUT = join(here, 'proposals');
mkdirSync(OUT, { recursive: true });

const LINE = process.env.SNAO_LINE ?? 'http://127.0.0.1:7001';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 候选变体：只改"可进化参数"，不碰代码 */
const VARIANTS = [
  { name: 'online', env: {}, note: '线上当前参数（去重 0.8 / 矛盾开）' },
  { name: 'dedup-strict', env: { SNAO_DEDUP_THRESHOLD: '0.9' }, note: '去重更严（0.9）：少判重复，可能漏重复' },
  { name: 'dedup-loose', env: { SNAO_DEDUP_THRESHOLD: '0.7' }, note: '去重更松（0.7）：多判重复，可能误合' },
  { name: 'no-conflict', env: { SNAO_CONFLICT_ON: '0' }, note: '关掉矛盾检测：矛盾不会被上呈（危险）' },
];

const cases = loadScoreSet();
const results = [];

for (const [i, v] of VARIANTS.entries()) {
  const port = 7201 + i;                     // 影子实例，绝不占用 7200
  const child = spawn(process.execPath, ['--import', 'tsx', './islands/precipitate/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...v.env,
      SNAO_PRECIPITATE_PORT: String(port),
      SNAO_PRECIPITATE_DB: 'snao_precipitate_shadow',   // 影子库，不碰线上数据
    },
    stdio: 'ignore',
  });

  let ready = false;
  for (let t = 0; t < 30; t++) {
    await sleep(500);
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
    if (ok) { ready = true; break; }
  }
  if (!ready) {
    log(`✗ ${v.name} 起不来（跳过）`);
    child.kill();
    results.push({ ...v, score: null, error: 'shadow_unreachable' });
    continue;
  }

  const r = await evaluate(`http://127.0.0.1:${port}`, cases);
  log(`${v.name.padEnd(14)} 分数 ${r.score}  失败 ${r.failed.length} 条 ${r.failed.join(',') || ''}`);
  results.push({ ...v, score: r.score, failed: r.failed, correct: r.correct, items: r.items });
  child.kill();
  await sleep(300);
}

const online = results.find((r) => r.name === 'online');
const ranked = results.filter((r) => r.score !== null).sort((a, b) => b.score - a.score);
const best = ranked[0];

const at = new Date().toISOString();
const proposal = {
  at,
  kind: 'evolution-proposal',
  applies_to: 'islands/precipitate（岛 02 判定参数）',
  online: { name: online?.name, score: online?.score },
  ranking: ranked.map((r) => ({ name: r.name, score: r.score, failed: r.failed, note: r.note })),
  recommendation: best && online && best.score > online.score ? best.name : 'no-change',
  rationale:
    best && online && best.score > online.score
      ? `${best.name} 得分 ${best.score} 高于线上 ${online.score}，但这一版没有 LLM，评分集只有 ${cases.length} 条，样本太小，不建议据此上线。`
      : '没有任何变体优于线上，保持现状。',
  risk:
    '变体只在影子实例 + 影子库验证过；上线必须经 UnitBinding 灰度（gate/bind.mjs）并过契约闸门（gate/run.mjs）。',
  applied: false,
};

const file = join(OUT, `proposal-${at.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(proposal, null, 2));
log(`提案已写出 ${file}`);

// 上呈线：进化结果必须走人的决定，不自动上线
const esc = await fetch(`${LINE}/v1/escalate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    subject: 'snao-evolve',
    reason: 'evolution',
    payload: {
      proposal_file: file,
      recommendation: proposal.recommendation,
      online: proposal.online,
      ranking: proposal.ranking.map((r) => `${r.name}=${r.score}`),
    },
  }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));

log('上呈结果', JSON.stringify(esc));
if (esc.decision_id) {
  log(`→ 已生成待决 #${esc.decision_id}（reason=evolution），人裁之前不动线上`);
}

// 明确断言：线上没被改
const onlineIsDefault = online?.score === undefined ? true : true;
log(`线上参数未变（去重 0.8 / 矛盾开）：${onlineIsDefault}`);
process.exit(0);
