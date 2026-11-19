import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 岛 03：接入
 * 一件事：把企业里的外部资料原样拿进来，带 ACL、带删除标记。
 * 三口：sources / docs / ingest（ingest 只给岛内采集器用，不对外）。
 *
 * 硬规矩（四岛决策 §3.3）：docs() 原样返回 ACL 与删除标记，**岛内不许预过滤**。
 * 谁能看，是线的事。
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const TENANT = process.env.SNAO_TENANT ?? 't1';
const PORT = Number(process.env.SNAO_INTAKE_PORT ?? 7400);
const DATA_DIR = process.env.SNAO_DATA ?? join(ROOT, 'data', 'intake');
mkdirSync(DATA_DIR, { recursive: true });

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: Number(process.env.PGPORT ?? 15432),
  user: 'postgres',
  password: env.POSTGRES_PASSWORD,
  database: process.env.SNAO_INTAKE_DB ?? 'snao_intake',
});

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'island-03-intake', tenant: TENANT }));

/** ① sources：有哪些源 */
app.get('/v1/sources', async (c) => {
  const { rows } = await pool.query(
    `select id, kind, name, config, created_at from source where tenant_id=$1 order by id`,
    [TENANT],
  );
  return c.json({ ok: true, items: rows });
});

/**
 * ② docs：把源里的东西原样交出去（节点树 + inheritance + grants + access_rule + 删除标记）
 *    不按任何人的身份过滤 —— 谁能看由线算。
 */
app.get('/v1/docs', async (c) => {
  const { rows } = await pool.query(
    `select id, source_kind, source_doc_id, space_id, space_kind, owner_subject,
            name, mime, size, sha256, received_at, status, deleted_at
       from doc where tenant_id=$1 order by id`,
    [TENANT],
  );

  const spaces = new Map<string, any>();
  const files: any[] = [];

  for (const r of rows) {
    const spaceNode = `${r.source_kind}:space:${r.space_id}`;
    if (!spaces.has(spaceNode)) {
      spaces.set(spaceNode, {
        id: spaceNode,
        type: 'space',
        name: r.space_kind === 'group' ? `群会话 ${r.space_id}` : `与 ${r.space_id} 的会话`,
        parent_id: null,
        space_kind: r.space_kind,
      });
    }
    files.push({
      id: `${r.source_kind}:doc:${r.id}`,
      type: 'file',
      name: r.name,
      parent_id: spaceNode,
      inheritance: [spaceNode],                                  // 从空间继承
      grants: [{ subject: r.owner_subject, role: 'owner' }],     // 源里的事实：谁放进来的
      access_rule: {
        visibility: r.space_kind === 'group' ? 'space' : 'personal',
        owner: r.owner_subject,
        space_id: r.space_id,
      },
      deleted: r.status === 'deleted',
      deleted_at: r.deleted_at,
      mime: r.mime,
      size: r.size,
      sha256: r.sha256,
      source_doc_id: r.source_doc_id,
      received_at: r.received_at,
    });
  }

  const snapshot_sha = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  return c.json({
    ok: true,
    snapshot_sha,
    total: files.length,
    deleted: files.filter((f) => f.deleted).length,
    nodes: [...spaces.values(), ...files],
  });
});

/** ③ ingest：只给岛内采集器用（AIBot 长连接、以后的微盘同步器） */
app.post('/v1/ingest/file', async (c) => {
  const b = await c.req.json<any>();
  if (!b?.source_doc_id || !b?.name) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);

  let path: string | null = null;
  let sha256: string | null = null;
  let size: number = b.size ?? 0;

  if (typeof b.content_base64 === 'string') {
    const buf = Buffer.from(b.content_base64, 'base64');
    sha256 = createHash('sha256').update(buf).digest('hex');
    path = join(DATA_DIR, sha256);
    writeFileSync(path, buf);
    size = buf.length;
  }

  const { rows } = await pool.query(
    `insert into doc (tenant_id, source_kind, source_doc_id, space_id, space_kind,
                      owner_subject, name, mime, size, sha256, path)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id, source_kind, source_doc_id) do update
       set name=excluded.name, size=excluded.size, sha256=excluded.sha256, path=excluded.path,
           space_id=excluded.space_id, space_kind=excluded.space_kind, owner_subject=excluded.owner_subject,
           status='active', deleted_at=null
     returning id`,
    [TENANT, b.source_kind ?? 'wecom-aibot', b.source_doc_id, b.space_id ?? b.owner_subject,
     b.space_kind ?? 'single', b.owner_subject ?? 'unknown', b.name, b.mime ?? null, size, sha256, path],
  );
  log(`收下文档 #${rows[0].id} 《${b.name}》 来自 ${b.owner_subject}（${b.space_kind ?? 'single'} ${b.space_id ?? ''}）`);
  return c.json({ ok: true, id: rows[0].id, sha256 });
});

/** ④ 删除：源里删了/撤回，就把标记打上（不物理删，留痕） */
app.post('/v1/delete', async (c) => {
  const b = await c.req.json<any>();
  const by = b.source_doc_id
    ? await pool.query(
        `update doc set status='deleted', deleted_at=now()
          where tenant_id=$1 and source_doc_id=$2 returning id, name`,
        [TENANT, b.source_doc_id],
      )
    : await pool.query(
        `update doc set status='deleted', deleted_at=now()
          where tenant_id=$1 and name=$2 and status='active' returning id, name`,
        [TENANT, b.name],
      );
  if (!by.rowCount) return c.json({ ok: false, error: 'NOT_FOUND' }, 404);
  log(`标记删除：${by.rows.map((r) => `#${r.id} ${r.name}`).join(', ')}`);
  return c.json({ ok: true, deleted: by.rows });
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, async () => {
  await pool.query(readFileSync(join(here, 'schema.sql'), 'utf8'));
  await pool.query(
    `insert into source (tenant_id, kind, name, config)
     select $1,'wecom-aibot','企微机器人会话文件','{"note":"用户把文件发给 SNAO 机器人"}'::jsonb
     where not exists (select 1 from source where tenant_id=$1 and kind='wecom-aibot')`,
    [TENANT],
  );
  log(`岛 03 已启动 http://127.0.0.1:${PORT}（库 snao_intake，文件落 ${DATA_DIR}）`);
});
