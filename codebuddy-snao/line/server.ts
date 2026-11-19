import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { DB, LINE_PORT, TENANT, log } from './config.js';

const pool = new pg.Pool(DB);
const ISLAND02 = process.env.SNAO_ISLAND02 ?? 'http://127.0.0.1:7200';
const ISLAND03 = process.env.SNAO_ISLAND03 ?? 'http://127.0.0.1:7400';
const LINE_SECRET = process.env.SNAO_LINE_SECRET ?? 'dev-line-secret';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * 线：只持有三样东西
 *   1) 谁可以做什么  → subject_scope / subject_token
 *   2) 谁来决定      → decision
 *   3) 发生过什么    → journal（append-only）
 * 它不知道岛内怎么实现，也不接收岛的任何"判定"。
 */
const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'snao-line', tenant: TENANT }));

/** 认人：token → subject。查不到就是查不到，不猜 */
app.get('/v1/whoami', async (c) => {
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return c.json({ ok: false, error: 'NO_TOKEN' }, 401);
  const { rows } = await pool.query(
    `select subject_id from subject_token
      where tenant_id=$1 and token_hash=$2 and revoked_at is null`,
    [TENANT, sha256(token)],
  );
  if (rows.length === 0) return c.json({ ok: false, error: 'UNKNOWN_TOKEN' }, 401);
  return c.json({ ok: true, subject_id: rows[0].subject_id });
});

/** 准入：allow / deny / need_decision */
app.post('/v1/admit', async (c) => {
  const body = await c.req.json<{ subject: string; action: string; resource: string; run_id?: string }>();
  const { subject, action, resource } = body;
  if (!subject || !action) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);

  const { rows } = await pool.query(
    `select 1 from subject_scope
      where tenant_id=$1 and subject_id=$2 and action=$3 and resource=$4
        and revoked_at is null and (expires_at is null or expires_at > now())
      limit 1`,
    [TENANT, subject, action, resource],
  );
  if (rows.length > 0) return c.json({ ok: true, result: 'allow' });

  // 读文档：被判定的依据是岛 03 给的事实（owner / visibility / deleted），判定本身在线里
  if (action === 'doc.read') {
    const docs = await fetch(`${ISLAND03}/v1/docs`)
      .then((r) => r.json() as any)
      .catch((e) => { log('岛 03 不可达', String(e)); return null; });
    if (!docs) return c.json({ ok: false, error: 'ISLAND_UNREACHABLE' }, 502);

    const node = (docs.nodes ?? []).find((n: any) => n.id === resource);
    if (!node) {
      await record(body.run_id ?? null, subject, action, resource, 'denied', { reason: 'no_such_doc' });
      return c.json({ ok: true, result: 'deny', why: 'no_such_doc' });
    }
    if (node.deleted) {
      await record(body.run_id ?? null, subject, action, resource, 'denied', { reason: 'deleted', name: node.name });
      return c.json({ ok: true, result: 'deny', why: 'deleted' });
    }
    const rule = node.access_rule ?? {};
    if (rule.visibility === 'personal' && rule.owner === subject) {
      await record(body.run_id ?? null, subject, action, resource, 'allow', { name: node.name, why: 'owner' });
      return c.json({ ok: true, result: 'allow', why: 'owner' });
    }
    if (rule.visibility === 'space' && rule.owner === subject) {
      await record(body.run_id ?? null, subject, action, resource, 'allow', { name: node.name, why: 'space_owner' });
      return c.json({ ok: true, result: 'allow', why: 'space_owner' });
    }
    // 别人的东西 / 群成员关系还没有真源（企微通讯录被可信IP 挡住）→ 交给人裁
    const runId = body.run_id ?? `run-${randomUUID()}`;
    const { rows } = await pool.query(
      `insert into decision (tenant_id, run_id, reason, payload, sla_deadline)
       values ($1,$2,'disclosure',$3, now() + interval '24 hours') returning id`,
      [TENANT, runId, JSON.stringify({ subject, resource, name: node.name, owner: rule.owner, visibility: rule.visibility })],
    );
    await record(runId, subject, action, resource, 'need_decision', { decision_id: rows[0].id, name: node.name });
    return c.json({ ok: false, error: 'NEED_DECISION', decision_id: rows[0].id, run_id: runId });
  }

  // 没有授权时，两类动作分两种处理：
  //   读知识越界 → 直接拒绝（跨范围读是"披露"问题，不是"批不批"问题；披露走 disclosure 另说）
  //   调接口（api.*）→ 交给人批（authority：能不能做这件事）
  if (action.startsWith('knowledge.read')) {
    await record(body.run_id ?? null, subject, action, resource, 'denied', { reason: 'out_of_scope' });
    return c.json({ ok: true, result: 'deny' });
  }

  const runId = body.run_id ?? `run-${randomUUID()}`;
  const { rows: d } = await pool.query(
    `insert into decision (tenant_id, run_id, reason, payload, sla_deadline)
     values ($1,$2,$3,$4, now() + interval '4 hours') returning id`,
    [TENANT, runId, 'authority', JSON.stringify({ subject, action, resource })],
  );
  await record(runId, subject, action, resource, 'need_decision', { decision_id: d[0].id });
  return c.json({ ok: true, result: 'need_decision', decision_id: d[0].id, run_id: runId });
});

/**
 * 组织同步：岛 04 把「谁 / 在哪个部门 / 什么角色 / 管哪些部门」推过来。
 * 线自己把这些标签算成范围（D-04/D-05：角色只给标签，范围由线算），
 * 并把 snapshot_sha 记进 journal —— 事后能复现"当时用的哪版组织数据"。
 *
 * 借 ANC 的三条：角色标签不推导范围（要看 manages）、停用不删档、离职不自动重建。
 */
app.post('/v1/org-sync', async (c) => {
  const b = await c.req.json<{ snapshot_sha: string; people: any[]; teams: any[]; event?: any }>();
  if (!b.snapshot_sha || !Array.isArray(b.people)) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);

  // 旧的"由角色算出来的"授权全撤，再按当前组织重算（幂等）
  await pool.query(`delete from subject_scope where tenant_id=$1 and granted_by like 'role:%'`, [TENANT]);

  const allTeams: string[] = (b.teams ?? []).map((t: any) => t.team_id);
  let granted = 0;
  const denied: string[] = [];

  for (const p of b.people) {
    if (p.status !== 'active') { denied.push(p.subject_id); continue; }   // 离职/停用：不给任何范围
    const rows: { action: string; resource: string }[] = [];
    const seen = new Set<string>();
    const add = (action: string, resource: string) => { const k = action + '|' + resource; if (!seen.has(k)) { seen.add(k); rows.push({ action, resource }); } };
    // D-05：任何在职者都能看「本人 personal + 所在部门 team 级」
    add('knowledge.read', `knowledge:personal:${p.subject_id}`);
    if (p.team_id) add('knowledge.read', `knowledge:team:${p.team_id}`);

    if (p.role === 'boss') {
      add('knowledge.read', 'knowledge:enterprise:*');
      for (const t of allTeams) add('knowledge.read', `knowledge:team:${t}`);
    } else if (p.role === 'manager') {
      for (const t of (p.manages ?? [])) add('knowledge.read', `knowledge:team:${t}`);
    }
    for (const r of rows) {
      await pool.query(
        `insert into subject_scope (tenant_id, subject_id, action, resource, granted_by) values ($1,$2,$3,$4,$5)`,
        [TENANT, p.subject_id, r.action, r.resource, `role:${p.role}`],
      );
      granted++;
    }
  }

  await record(b.event ? `org:${b.event.type}` : 'org:sync', 'line', 'org.sync', b.snapshot_sha, 'ok', {
    snapshot_sha: b.snapshot_sha, granted, disabled: denied, event: b.event ?? null,
  });
  log(`组织同步 snapshot=${b.snapshot_sha}：授予 ${granted} 条范围；停用 ${denied.length} 人（${denied.join(',') || '无'}）`);
  return c.json({ ok: true, granted, disabled: denied });
});

/** 待人：当前这个主体有没有某条范围（只读检查，给排查用） */
app.get('/v1/scopes', async (c) => {
  const subject = c.req.query('subject');
  const args: any[] = [TENANT];
  let sql = `select subject_id, action, resource, granted_by, revoked_at from subject_scope where tenant_id=$1`;
  if (subject) { args.push(subject); sql += ` and subject_id=$${args.length}`; }
  sql += ' order by subject_id, resource';
  const { rows } = await pool.query(sql, args);
  return c.json({ ok: true, items: rows });
});

/** 待决清单 */
app.get('/v1/pending', async (c) => {
  const { rows } = await pool.query(
    `select id, run_id, reason, payload, status, sla_deadline
       from decision
      where tenant_id=$1 and status='pending'
      order by id desc limit 100`,
    [TENANT],
  );
  return c.json({ ok: true, items: rows });
});

/** 人做决定：拒绝必须写理由 */
app.post('/v1/decide', async (c) => {
  const b = await c.req.json<{ id: number; approved: boolean; note?: string; decided_by?: string }>();
  if (!b.id) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);
  if (!b.approved && !b.note?.trim()) return c.json({ ok: false, error: 'NOTE_REQUIRED' }, 400);

  const { rows } = await pool.query(
    `update decision
        set status=$1, decided_by=$2, decided_at=now(), decision_note=$3
      where tenant_id=$4 and id=$5 and status='pending'
      returning id, run_id, payload`,
    [b.approved ? 'approved' : 'rejected', b.decided_by ?? 'unknown', b.note ?? '', TENANT, b.id],
  );
  if (rows.length === 0) return c.json({ ok: false, error: 'NOT_PENDING' }, 409);

  const p = rows[0].payload;
  await record(rows[0].run_id, b.decided_by ?? 'unknown', 'decision.' + (b.approved ? 'approve' : 'reject'), String(b.id), 'ok', {
    note: b.note ?? '', subject: p?.subject, action: p?.action, resource: p?.resource,
  });

  // 知识类的裁决要回写岛 02（裁决由线发起，岛只执行）
  if (p?.candidate_id) {
    await fetch(`${ISLAND02}/v1/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-snao-line-secret': LINE_SECRET },
      body: JSON.stringify({ candidate_id: p.candidate_id, accepted: b.approved, note: b.note ?? '' }),
    }).catch((e) => log('回写岛 02 失败', String(e)));
  }

  // 批准即授权（写进 subject_scope，之后同一 action+resource 直接放行）
  // 只有 authority 类决定带 action/resource；知识类（intake / collision）不写权限表
  if (b.approved && p?.action && p?.resource) {
    await pool.query(
      `insert into subject_scope (tenant_id, subject_id, action, resource, granted_by)
       values ($1,$2,$3,$4,$5)`,
      [TENANT, p?.subject, p?.action, p?.resource, b.decided_by ?? 'unknown'],
    );
  }
  return c.json({ ok: true });
});

/**
 * 上呈：岛遇到"需要人决定"的事（例如两条知识互相矛盾），交出来、不自己拍板。
 * 与 admit 生成 decision 的差别：admit 是"能不能做"，escalate 是"这条算不算数"。
 */
app.post('/v1/escalate', async (c) => {
  const b = await c.req.json<{ subject: string; reason: string; payload: any; run_id?: string }>();
  if (!b.subject || !b.reason) return c.json({ ok: false, error: 'BAD_REQUEST' }, 400);
  const runId = b.run_id ?? `run-${randomUUID()}`;
  const { rows } = await pool.query(
    `insert into decision (tenant_id, run_id, reason, payload, sla_deadline)
     values ($1,$2,$3,$4, now() + interval '24 hours') returning id`,
    [TENANT, runId, b.reason, JSON.stringify(b.payload ?? {})],
  );
  await record(runId, b.subject, `escalate.${b.reason}`, String(rows[0].id), 'escalated', b.payload ?? {});
  return c.json({ ok: true, decision_id: rows[0].id, run_id: runId });
});

/** 回执：岛/网关只上报，不解释 */
app.post('/v1/record', async (c) => {
  const b = await c.req.json<any>();
  await record(b.run_id ?? null, b.subject_id ?? 'unknown', b.action ?? 'unknown', b.target ?? null, b.outcome ?? 'ok', b.detail ?? {});
  return c.json({ ok: true });
});

async function record(runId: string | null, subject: string, action: string, target: string | null, outcome: string, detail: any) {
  await pool.query(
    `insert into journal (tenant_id, run_id, subject_id, action, target, outcome, detail)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [TENANT, runId, subject, action, target, outcome, JSON.stringify(detail ?? {})],
  );
}

/** 一页 inbox */
app.get('/inbox', (c) =>
  c.html(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>SNAO 线的 Inbox</title>
<style>
 body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:24px;max-width:900px;color:#222}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#666;margin-bottom:20px}
 .card{border:1px solid #e3e3e3;border-radius:8px;padding:14px;margin-bottom:12px}
 .meta{color:#666;font-size:12px} code{background:#f5f5f5;padding:1px 5px;border-radius:4px}
 textarea{width:100%;box-sizing:border-box;margin-top:8px;padding:6px;border:1px solid #ddd;border-radius:6px}
 button{margin-top:8px;margin-right:8px;padding:6px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}
 .ok{background:#1677ff;color:#fff;border-color:#1677ff} .empty{color:#999}
</style>
<h1>SNAO 线的 Inbox</h1><div class="sub">谁来决定 —— 这里是人拍板的地方；线只负责把待决事项摊开、把决定留痕。</div>
<div id="list">加载中…</div>
<script>
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){
  const r = await fetch('/v1/pending').then(x=>x.json());
  const el = document.getElementById('list');
  if(!r.items?.length){ el.innerHTML = '<div class="empty">没有待决事项。</div>'; return; }
  el.innerHTML = r.items.map(it=>{
    const p = it.payload || {};
    return \`<div class="card">
      <div><b>#\${it.id}</b> · \${esc(it.reason)} · <span class="meta">run=\${esc(it.run_id)} · SLA \${esc(it.sla_deadline||'-')}</span></div>
      <div class="meta" style="margin-top:6px">谁：<code>\${esc(p.subject)}</code>　做什么：<code>\${esc(p.action)}</code>　对象：<code>\${esc(p.resource)}</code></div>
      <textarea id="n\${it.id}" placeholder="理由（拒绝必填）"></textarea>
      <button class="ok" onclick="decide(\${it.id}, true)">批准</button>
      <button onclick="decide(\${it.id}, false)">拒绝</button>
    </div>\`;
  }).join('');
}
async function decide(id, approved){
  const note = document.getElementById('n'+id).value;
  const r = await fetch('/v1/decide', {method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({id, approved, note, decided_by:'guoshuai'})}).then(x=>x.json());
  if(!r.ok){ alert(r.error || '失败'); return; }
  load();
}
load(); setInterval(load, 5000);
</script></html>`),
);

serve({ fetch: app.fetch, port: LINE_PORT, hostname: '127.0.0.1' }, async () => {
  log(`线已启动 http://127.0.0.1:${LINE_PORT}  (inbox: /inbox)`);
  const { rows } = await pool.query(`select count(*)::int n from subject_scope`);
  log(`subject_scope 现有授权 ${rows[0].n} 条`);
});
