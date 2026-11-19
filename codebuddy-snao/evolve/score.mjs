// 评分函数（由线提供 · P4 第 3 项）
//
// 给一个岛 02 实例的地址，用评分集打分：
//   准确率 = (去重判对 + 矛盾判对) / (总判定项数)
// 这个函数只读、只打分，不写任何东西。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = process.env.SNAO_LINE_SECRET ?? 'dev-line-secret';

export function loadScoreSet() {
  return JSON.parse(readFileSync(join(here, 'score-set.json'), 'utf8')).cases;
}

export async function evaluate(base, cases = loadScoreSet()) {
  const details = [];
  let correct = 0, items = 0;

  for (const c of cases) {
    const res = await fetch(`${base}/v1/judge-one`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-snao-line-secret': SECRET },
      body: JSON.stringify({ content: c.content, existing: c.existing }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const gotDedup = res ? res.dedup_at !== null : null;
    const gotConflict = res ? res.conflict_at !== null : null;
    const okDedup = gotDedup === c.expect_dedup;
    const okConflict = gotConflict === c.expect_conflict;

    items += 2;
    if (okDedup) correct++;
    if (okConflict) correct++;
    details.push({
      id: c.id,
      expect: { dedup: c.expect_dedup, conflict: c.expect_conflict },
      got: { dedup: gotDedup, conflict: gotConflict, similarity: res?.similarity ?? null },
      ok: okDedup && okConflict,
      unreachable: res === null,
    });
  }

  return {
    base,
    score: items ? +(correct / items).toFixed(3) : 0,
    correct,
    items,
    failed: details.filter((d) => !d.ok).map((d) => d.id),
    details,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? 'http://127.0.0.1:7200';
  const r = await evaluate(base);
  console.log(JSON.stringify({ base: r.base, score: r.score, correct: r.correct, items: r.items, failed: r.failed }, null, 2));
}
