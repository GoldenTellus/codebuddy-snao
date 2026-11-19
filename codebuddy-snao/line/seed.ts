// 初始化：建表 + 发一个 token + 给一组初始授权
// 用法：node --import tsx ./seed.ts [token]
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DB, TENANT, log } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool(DB);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// 令牌从参数或 .env 的 SNAO_ADMIN_TOKEN 来；绝不写死进仓库
const token = process.argv[2] ?? process.env.SNAO_ADMIN_TOKEN ?? '';
if (!token) {
  console.error('缺少令牌：node line/seed.ts <token>，或在 deploy/.env 设置 SNAO_ADMIN_TOKEN');
  process.exit(2);
}
const subject = 'guoshuai';

const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
await pool.query(schema);
log('schema 已应用');

await pool.query(
  `insert into subject_token (tenant_id, subject_id, token_hash, note)
   values ($1,$2,$3,'P1 开发用')
   on conflict (token_hash) do nothing`,
  [TENANT, subject, sha256(token)],
);
log('token 已登记（明文只在创建时给一次，库里只存 sha256）');

// 初始授权：只给"读自己"和"跑任务"两条；其余走 need_decision，好观察线的行为
const grants = [
  { action: 'api.GET./api/v1/users/me', resource: '/api/v1/users/me' },
  { action: 'api.GET./api/v1/usage', resource: '/api/v1/usage' },
];
for (const g of grants) {
  await pool.query(
    `insert into subject_scope (tenant_id, subject_id, action, resource, granted_by)
     values ($1,$2,$3,$4,'seed')`,
    [TENANT, subject, g.action, g.resource],
  );
}
log(`初始授权 ${grants.length} 条`);

const { rows } = await pool.query('select count(*)::int n from subject_scope');
log('subject_scope 总数:', rows[0].n);
console.log('\n--- 开发用 token ---\n' + token + '\n');
await pool.end();
