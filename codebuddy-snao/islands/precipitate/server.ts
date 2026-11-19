import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 岛 02：知识沉淀
 * 一件事：把工作记录变成有归属、要确认、会淘汰的知识。
 * 三口：ingest / candidates / export。
 *
 * 它只产出「候选」和「判定依据」，不替线决定任何事：
 *   重复 / 矛盾 → 标出来 + 上呈线（POST /v1/escalate），由人裁。
 */

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, '..', '..', 'deploy', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const TENANT = process.env.SNAO_TENANT ?? 't1';
const PORT = Number(process.env.SNAO_PRECIPITATE_PORT ?? 7200);
const LINE = process.env.SNAO_LINE ?? 'http://127.0.0.1:7001';
const LINE_SECRET = process.env.SNAO_LINE_SECRET ?? 'dev-line-secret';

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: Number(process.env.PGPORT ?? 15432),
  user: 'postgres',
  password: env.POSTGRES_PASSWORD,
  database: process.env.SNAO_PRECIPITATE_DB ?? 'snao_precipitate',
});

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * 可进化参数（P4 第 3 项）：进化只改这些，且在影子实例里跑，不碰线上。
 * 线上取默认值；变体由 evolve/propose.mjs 起影子实例验证后，才可能被人批准上线。
 */
const DEDUP_THRESHOLD = Number(process.env.SNAO_DEDUP_THRESHOLD ?? 0.8);
const CONFLICT_ON = (process.env.SNAO_CONFLICT_ON ?? '1') === '1';
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '');
const tokens = (s: string) => new Set(norm(s).match(/.{2,3}/g) ?? []);

function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 极简矛盾检测：同主语 + 同属性 + 不同取值（数字/日期） */
function contradiction(a: string, b: string): boolean {
  // 值要能吃到中文与日期整体：原来 [\w.\-/] 只匹配字母数字，中文值一律漏掉，
  // "合同签署日期是2026年3月1日" 也只截到年份。评分集 S-05/S-06 就是被这两点坑掉的。
  const pat = /(.{2,12}?)(价格|费用|金额|时间|日期|版本|负责人|电话|邮箱)[是为:：]?\s*([^\s，。；、,;!?！？]{1,24})/gu;
  const grab = (s: string) => [...s.matchAll(pat)].map((m) => ({ k: m[1].trim() + '/' + m[2], v: m[3] }));
  const A = grab(a), B = grab(b);
  return A.some((x) => B.some((y) => x.k === y.k && x.v !== y.v));
}

const app = new Hono();

/** 只接受线递进来的数据：没有线就喂不进来（共识 §4-5） */
const fromLine = (c: any) => (c.req.header('x-snao-line-secret') ?? '') === LINE_SECRET;

app.get('/health', (c) => c.json({ ok: true, service: 'island-02-precipitate', tenant: TENANT }));

/** ① ingest：喂工作记录，吐候选 */
app.post('/v1/ingest', async (c) => {
  if (!fromLine(c)) return c.json({ ok: false, error: 'ONLY_FROM_LINE' }, 403);
  const { events } = await c.req.json<{ events: any[] }>();
  if (!Array.isArray(events)) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);

  const created: number[] = [];
  for (const e of events) {
    // 只处理"发生过的事"：line 的 journal 行
    if (e.action?.startsWith('decision.')) continue;
    const text = extractFact(e);
    if (!text) continue;
    const { rows } = await pool.query(
      `insert into candidate (tenant_id, source_seq, subject_id, content, kind, share_scope, origin)
       values ($1,$2,$3,$4,$5,'personal',$6) returning id`,
      [TENANT, e.seq ?? null, e.subject_id ?? 'unknown', text, 'fact', JSON.stringify({ action: e.action, target: e.target })],
    );
    created.push(rows[0].id);
  }
  await pool.query(
    `insert into applied_seq (seq) select unnest($1::bigint[]) on conflict do nothing`,
    [events.map((e) => e.seq).filter(Boolean)],
  );
  log(`ingest ${events.length} 条事件 → ${created.length} 条候选`);
  return c.json({ ok: true, candidate_ids: created });
});

/** ② candidates：候选清单（默认只看自己的；D-09） */
app.get('/v1/candidates', async (c) => {
  const scope = c.req.query('scope') ?? 'personal';
  const subject = c.req.query('subject');
  const status = c.req.query('status');
  const args: any[] = [TENANT, scope];
  let sql = `select id, subject_id, content, share_scope, status, quality, dedup_of, conflict_with, decision_id, created_at
               from candidate where tenant_id=$1 and share_scope=$2`;
  if (subject) { args.push(subject); sql += ` and subject_id=$${args.length}`; }
  if (status) { args.push(status); sql += ` and status=$${args.length}`; }
  sql += ' order by id desc limit 200';
  const { rows } = await pool.query(sql, args);
  return c.json({ ok: true, items: rows });
});

/** ③ export：把已确认的知识导出（给岛 01 索引，经线取，不推） */
app.post('/v1/export', async (c) => {
  if (!fromLine(c)) return c.json({ ok: false, error: 'ONLY_FROM_LINE' }, 403);
  const { scope, subject } = await c.req.json<{ scope?: string; subject?: string }>();
  const args: any[] = [TENANT];
  let sql = `select id, content, share_scope, share_target_id, subject_id from knowledge
              where tenant_id=$1 and retired_at is null and superseded_by is null`;
  if (scope) { args.push(scope); sql += ` and share_scope=$${args.length}`; }
  if (subject) { args.push(subject); sql += ` and (share_scope<>'personal' or share_target_id=$${args.length})`; }
  const { rows } = await pool.query(sql, args);
  return c.json({ ok: true, documents: rows });
});

/**
 * ④ judge：去重 + 矛盾检测 + 质量分。这是岛内能力，不对外决策。
 *    发现重复 → 标 dedup_of；发现矛盾 → 标 conflict_with 并上呈线。
 */
app.post('/v1/judge', async (c) => {
  if (!fromLine(c)) return c.json({ ok: false, error: 'ONLY_FROM_LINE' }, 403);
  const dry = c.req.query('dry') === '1';
  const { rows: cands } = await pool.query(
    `select id, subject_id, content from candidate where tenant_id=$1 and status='draft' order by id`,
    [TENANT],
  );
  const results: any[] = [];
  for (const cand of cands) {
    const { rows: existing } = await pool.query(
      `select id, content from knowledge where tenant_id=$1 and retired_at is null`,
      [TENANT],
    );
    let dedupOf: number | null = null, conflictWith: number | null = null, best = 0;
    for (const k of existing) {
      const sim = jaccard(cand.content, k.content);
      if (sim > best) best = sim;
      if (sim >= DEDUP_THRESHOLD && !dedupOf) dedupOf = k.id;
      // 矛盾的判据是「同主体同属性不同值」，不靠整体相似度（两条几乎只说同一件事时相似度反而低）
      if (!conflictWith && contradiction(cand.content, k.content)) conflictWith = k.id;
    }
    const quality = Math.min(1, 0.3 + best * 0.4 + Math.min(cand.content.length, 200) / 500);
    let decisionId: number | null = null;

    // 全新知识也要人确认才入库（V1.1 §8.2.2 的 intake；D-09 默认 personal）
    if (!conflictWith && !dedupOf && !dry) {
      const r = await fetch(`${LINE}/v1/escalate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: cand.subject_id, reason: 'intake',
          payload: { candidate_id: cand.id, content: cand.content, share_scope: 'personal' },
        }),
      }).then((x) => x.json() as any).catch(() => null);
      decisionId = r?.decision_id ?? null;
      if (decisionId) await pool.query(`update candidate set status='pending', decision_id=$1 where id=$2`, [decisionId, cand.id]);
    }

    if (conflictWith) {
      // 矛盾：上呈线，由人裁；岛不自己选一条
      if (!dry) {
        const r = await fetch(`${LINE}/v1/escalate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            subject: cand.subject_id, reason: 'collision',
            payload: { candidate_id: cand.id, conflict_with: conflictWith, content: cand.content },
          }),
        }).then((x) => x.json() as any).catch(() => null);
        decisionId = r?.decision_id ?? null;
      }
    }

    if (!dry) {
      await pool.query(
        `update candidate set dedup_of=$1, conflict_with=$2, quality=$3, decision_id=$4,
                status = case when $2::bigint is not null then 'pending' else status end
          where id=$5`,
        [dedupOf, conflictWith, quality, decisionId, cand.id],
      );
    }
    results.push({ id: cand.id, dedup_of: dedupOf, conflict_with: conflictWith, quality: +quality.toFixed(2), decision_id: decisionId });
  }
  log(`judge ${results.length} 条：重复 ${results.filter((r) => r.dedup_of).length}，矛盾 ${results.filter((r) => r.conflict_with).length}`);
  return c.json({ ok: true, results });
});

/**
 * 纯函数口：给一条候选 + 一组已有知识，只判定不落库。
 * 评测（promptfoo）和调试都用它；岛内判定换模型时，这里的行为就是被评测的对象。
 */
app.post('/v1/judge-one', async (c) => {
  if (!fromLine(c)) return c.json({ ok: false, error: 'ONLY_FROM_LINE' }, 403);
  const { content, existing } = await c.req.json<{ content: string; existing: string[] }>();
  if (!content) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);

  let dedup_at: number | null = null;
  let conflict_at: number | null = null;
  let best = 0;
  (existing ?? []).forEach((k, i) => {
    const sim = jaccard(content, k);
    if (sim > best) best = sim;
    if (sim >= DEDUP_THRESHOLD && dedup_at === null) dedup_at = i;
    if (CONFLICT_ON && conflict_at === null && contradiction(content, k)) conflict_at = i;
  });
  const quality = Math.min(1, 0.3 + best * 0.4 + Math.min(content.length, 200) / 500);
  return c.json({
    ok: true,
    dedup_at,
    conflict_at,
    similarity: +best.toFixed(3),
    quality: +quality.toFixed(2),
  });
});

/** 人裁完之后，线来回写：接受 / 拒绝 */
app.post('/v1/settle', async (c) => {
  if (!fromLine(c)) return c.json({ ok: false, error: 'ONLY_FROM_LINE' }, 403);
  const { candidate_id, accepted, note } = await c.req.json<any>();
  const { rows } = await pool.query(
    `select id, subject_id, content, share_scope from candidate where tenant_id=$1 and id=$2`,
    [TENANT, candidate_id],
  );
  if (!rows.length) return c.json({ ok: false, error: 'NOT_FOUND' }, 404);
  const cand = rows[0];

  if (!accepted) {
    await pool.query(`update candidate set status='rejected' where id=$1`, [cand.id]);
    return c.json({ ok: true, status: 'rejected' });
  }
  await pool.query(`update candidate set status='accepted' where id=$1`, [cand.id]);
  const target = cand.share_scope === 'personal' ? cand.subject_id : null;
  await pool.query(
    `insert into knowledge (tenant_id, candidate_id, subject_id, content, share_scope, share_target_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [TENANT, cand.id, cand.subject_id, cand.content, cand.share_scope, target],
  );
  log(`接受候选 #${cand.id} → 知识（${cand.share_scope}）`, note ? `备注：${note}` : '');
  return c.json({ ok: true, status: 'accepted' });
});

/** 从一条事件里抠出"可复用的事实"。P2 先用规则；P4 换模型。 */
function extractFact(e: any): string | null {
  const d = e.detail ?? {};
  if (typeof d.text === 'string' && d.text.trim()) return d.text.trim();
  if (typeof d.note === 'string' && d.note.trim()) return d.note.trim();
  if (e.target && typeof e.target === 'string' && e.target.length > 6 && !e.target.startsWith('/api/')) return e.target;
  return null;
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, async () => {
  await pool.query(readFileSync(join(here, 'schema.sql'), 'utf8'));
  log(`岛 02 已启动 http://127.0.0.1:${PORT}（库 snao_precipitate；去重阈值 ${DEDUP_THRESHOLD}，矛盾检测 ${CONFLICT_ON ? '开' : '关'}）`);
});
