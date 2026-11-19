// 建库建表 + 发管理员令牌（幂等，可重复跑）
// 客户第一次部署时由 `./snao bootstrap` 调用

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const PG = {
  host: '127.0.0.1',
  port: Number(env.PGPORT ?? 15432),
  user: 'postgres',
  password: env.POSTGRES_PASSWORD,
};

const TENANT = env.SNAO_TENANT ?? 't1';
const ADMIN_SUBJECT = env.SNAO_ADMIN_SUBJECT ?? 'admin';
const ADMIN_TOKEN = env.SNAO_ADMIN_TOKEN;
const DBS = ['snao_line', 'snao_precipitate', 'snao_intake'];

const log = (...a) => console.log(' ', ...a);

// 1) 建库
const admin = new pg.Client({ ...PG, database: 'postgres' });
await admin.connect();
for (const db of DBS) {
  const { rowCount } = await admin.query('select 1 from pg_database where datname=$1', [db]);
  if (rowCount) log(`${db} 已存在`);
  else {
    await admin.query(`create database ${db}`);
    log(`${db} 已创建`);
  }
}
await admin.end();

// 2) 线的表
const line = new pg.Client({ ...PG, database: 'snao_line' });
await line.connect();
await line.query(readFileSync(join(ROOT, 'line', 'schema.sql'), 'utf8'));
log('线的表已就绪（subject_scope / subject_token / decision / journal）');

// 3) 管理员令牌（只存哈希）
if (!ADMIN_TOKEN) {
  console.error('✗ .env 里没有 SNAO_ADMIN_TOKEN，先跑 ./snao bootstrap');
  process.exit(1);
}
const hash = createHash('sha256').update(ADMIN_TOKEN).digest('hex');
await line.query(
  `insert into subject_token (tenant_id, subject_id, token_hash, note)
   values ($1,$2,$3,'管理员令牌（bootstrap 生成）')
   on conflict do nothing`,
  [TENANT, ADMIN_SUBJECT, hash],
);
const { rows } = await line.query(
  `select count(*)::int as n from subject_token where tenant_id=$1`,
  [TENANT],
);
log(`管理员令牌已登记（主体 ${ADMIN_SUBJECT}，库里共 ${rows[0].n} 个令牌）`);
await line.end();

// 4) 岛 02 / 岛 03 的表由各自服务启动时自建，这里只提示
log('岛 02 / 岛 03 的表会在服务启动时自动建好');
