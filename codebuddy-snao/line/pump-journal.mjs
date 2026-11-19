// 线 → 岛 02 的搬运：把线上的 journal 递给沉淀岛
// 方向很重要：是「线递给岛」，不是岛自己来捞（共识 §4-5：三样不在岛内实现）
//
// 用法：node pump-journal.mjs [--limit 200]
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const limit = Number(process.argv.includes('--limit') ? process.argv[process.argv.indexOf('--limit') + 1] : 200);
const ISLAND = process.env.SNAO_ISLAND02 ?? 'http://127.0.0.1:7200';
const SECRET = process.env.SNAO_LINE_SECRET ?? 'dev-line-secret';

const pool = new pg.Pool({
  host: '127.0.0.1', port: Number(process.env.PGPORT ?? 15432), user: 'postgres',
  password: env.POSTGRES_PASSWORD, database: process.env.SNAO_DB ?? 'snao_line',
});

const { rows } = await pool.query(
  `select seq, run_id, subject_id, action, target, outcome, detail, occurred_at
     from journal order by seq asc limit $1`,
  [limit],
);
console.log(`journal 共读出 ${rows.length} 条`);

const events = rows.map((r) => ({
  seq: Number(r.seq), run_id: r.run_id, subject_id: r.subject_id,
  action: r.action, target: r.target, outcome: r.outcome,
  detail: r.detail, occurred_at: r.occurred_at,
}));

const res = await fetch(`${ISLAND}/v1/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-snao-line-secret': SECRET },
  body: JSON.stringify({ events }),
}).then((x) => x.json());

console.log('岛 02 回执：', JSON.stringify(res));
await pool.end();
