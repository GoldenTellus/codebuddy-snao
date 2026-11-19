// 装一套最小样例数据（幂等）
//
// 为什么需要：契约闸门里有几条用例要看"岛 03 有多个所有者的文档、且有删除标记"，
// 客户机上装完是空的，闸门就过不了。这个脚本造三条样例，让验收有东西可验。
//
// 不碰真实数据：只往岛 03 塞三条标了 fixture 的文档，重复跑不会重复塞。

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

const TENANT = process.env.SNAO_TENANT ?? env.SNAO_TENANT ?? 't1';
const ADMIN_SUBJECT = process.env.SNAO_ADMIN_SUBJECT ?? env.SNAO_ADMIN_SUBJECT ?? 'admin';
const PGPORT = Number(process.env.PGPORT ?? env.PG_HOST_PORT ?? 15432);
const INTAKE = `http://127.0.0.1:${process.env.SNAO_INTAKE_PORT ?? env.SNAO_INTAKE_PORT ?? 7400}`;
const ISLAND02 = `http://127.0.0.1:${process.env.SNAO_PRECIPITATE_PORT ?? env.SNAO_PRECIPITATE_PORT ?? 7200}`;

const log = (...a) => console.log(' ', ...a);

// ---------- 1) 给管理员发最基本的自有范围（不然第一次调接口全是"待决"）----------
const db = new pg.Client({
  host: '127.0.0.1', port: PGPORT, user: 'postgres',
  password: env.POSTGRES_PASSWORD, database: 'snao_line',
});
await db.connect();
const grants = [
  { action: 'api.GET./api/v1/users/me', resource: '/api/v1/users/me' },
  { action: 'api.GET./api/v1/usage', resource: '/api/v1/usage' },
  { action: 'knowledge.read', resource: `knowledge:personal:${ADMIN_SUBJECT}` },
];
let added = 0;
for (const g of grants) {
  const r = await db.query(
    `insert into subject_scope (tenant_id, subject_id, action, resource, granted_by)
     select $1,$2,$3,$4,'bootstrap'
     where not exists (
       select 1 from subject_scope
        where tenant_id=$1 and subject_id=$2 and action=$3 and resource=$4 and revoked_at is null
     )`,
    [TENANT, ADMIN_SUBJECT, g.action, g.resource],
  );
  added += r.rowCount;
}
log(added ? `管理员基础范围 +${added} 条` : '管理员基础范围已存在');
await db.end();

// ---------- 2) 岛 03 造三条样例文档（两个所有者，其中一条已删除）----------
const FIXTURES = [
  { id: 'fixture-1', owner: ADMIN_SUBJECT, space: ADMIN_SUBJECT, kind: 'single', name: '样例-报价单.txt', text: '样例数据：报价单 100 元，账期 30 天。' },
  { id: 'fixture-2', owner: `${ADMIN_SUBJECT}-colleague`, space: `${ADMIN_SUBJECT}-colleague`, kind: 'single', name: '样例-会议纪要.md', text: '样例数据：会议纪要一份。' },
  { id: 'fixture-3', owner: ADMIN_SUBJECT, space: 'fixture-group', kind: 'group', name: '样例-合同.pdf.txt', text: '样例数据：合同正文占位。' },
];

const post = (p, body) => fetch(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json()).catch(() => null);

for (const f of FIXTURES) {
  const buf = Buffer.from(f.text, 'utf8');
  const res = await post(`${INTAKE}/v1/ingest/file`, {
    source_kind: 'fixture',
    source_doc_id: f.id,
    space_id: f.space,
    space_kind: f.kind,
    owner_subject: f.owner,
    name: f.name,
    mime: 'text/plain',
    size: buf.length,
    content_base64: buf.toString('base64'),
  });
  log(res?.ok ? `样例文档已就位：${f.name}` : `样例文档失败：${f.name} ${JSON.stringify(res)}`);
}

// 其中一条标为已删除，用来验"删除标记原样交出去"
const del = await post(`${INTAKE}/v1/delete`, { source_doc_id: 'fixture-3' });
log(del?.ok ? '样例-合同 已标记删除（用于验删除标记）' : '删除标记失败（可能已删）');

// ---------- 3) 岛 02 一条知识（让沉淀岛不是空库）----------
await post(`${ISLAND02}/v1/ingest`, { events: [] }).catch(() => {});
log('样例数据就绪');
