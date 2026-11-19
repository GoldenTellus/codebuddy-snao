import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 岛 04：身份与组织
 * 一件事：把「谁」接进来——人员、部门树、汇报线、负责人，以及它们的变更事件。
 * 四口：login / people / org / changes。
 *
 * 它只产出事实：谁是 boss、谁在哪个部门、谁管哪些部门。
 * 「谁能看什么」由线算——这里一行判定都不写。
 */

const here = dirname(fileURLToPath(import.meta.url));
const ORG_PATH = join(here, 'org.json');
const PORT = Number(process.env.SNAO_IDENTITY_PORT ?? 7300);
const LINE = process.env.SNAO_LINE ?? 'http://127.0.0.1:7001';

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

type Person = { subject_id: string; name: string; email: string; team_id: string; role: 'boss' | 'manager' | 'employee'; admin: boolean; manages: string[]; status: 'active' | 'disabled' };
type Team = { team_id: string; name: string; parent_team_id: string | null; head_id: string; data_owner_id: string | null };
type Org = { tenant: string; company: string; updated_at: string; teams: Team[]; people: Person[] };

const load = (): Org => JSON.parse(readFileSync(ORG_PATH, 'utf8'));
const save = (o: Org) => { o.updated_at = new Date().toISOString(); writeFileSync(ORG_PATH, JSON.stringify(o, null, 2)); };

/** 组织快照号：线在 journal 里记它，事后能复现"当时用的哪版组织数据"（B-16） */
const snapshotSha = (o: Org) => createHash('sha256').update(JSON.stringify({ teams: o.teams, people: o.people })).digest('hex').slice(0, 16);

/** 变更事件（内存里留最近 500 条；生产会落库） */
const changes: any[] = [];
const pushChange = (ev: any) => { changes.push({ ...ev, at: new Date().toISOString() }); if (changes.length > 500) changes.shift(); };

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, service: 'island-04-identity' }));

/** 登录断言 → 主体。查不到就是查不到，不猜（B-19 同源原则） */
app.post('/v1/login', async (c) => {
  const { assertion } = await c.req.json<{ assertion: string }>();
  const org = load();
  const p = org.people.find((x) => x.subject_id === assertion && x.status === 'active');
  if (!p) return c.json({ ok: false, error: 'NO_SUCH_SUBJECT' }, 404);
  return c.json({
    ok: true,
    subject: { subject_id: p.subject_id, name: p.name, team_id: p.team_id, role: p.role, admin: p.admin },
    snapshot_sha: snapshotSha(org),
  });
});

/** 人员：stable id、部门、职级、在职状态 */
app.get('/v1/people', (c) => {
  const org = load();
  return c.json({ ok: true, snapshot_sha: snapshotSha(org), people: org.people });
});

/** 部门树 + 负责人 + manages[] */
app.get('/v1/org', (c) => {
  const org = load();
  const manages = Object.fromEntries(org.people.map((p) => [p.subject_id, p.manages]));
  return c.json({ ok: true, snapshot_sha: snapshotSha(org), teams: org.teams, manages });
});

/** 变更事件：入职 / 离职 / 调岗 / 负责人变更 */
app.get('/v1/changes', (c) => {
  const since = Number(c.req.query('since') ?? 0);
  return c.json({ ok: true, items: changes.slice(since) });
});

/**
 * HR 动作（P3 的最小入口；以后换成企微通讯录连接器）。
 * 每次动作都会：改 org.json → 记变更 → 推给线（线负责撤权/重算）
 */
app.post('/v1/hr', async (c) => {
  const b = await c.req.json<{ op: 'transfer' | 'leave' | 'rehire'; subject_id: string; team_id?: string; note?: string }>();
  const org = load();
  const p = org.people.find((x) => x.subject_id === b.subject_id);
  if (!p) return c.json({ ok: false, error: 'NO_SUCH_SUBJECT' }, 404);

  let event: any = { type: b.op, subject_id: p.subject_id, team_id: p.team_id, snapshot_before: snapshotSha(org) };

  if (b.op === 'transfer') {
    if (!org.teams.some((t) => t.team_id === b.team_id)) return c.json({ ok: false, error: 'NO_SUCH_TEAM' }, 400);
    event.from_team = p.team_id;
    p.team_id = b.team_id!;
    event.to_team = p.team_id;
  } else if (b.op === 'leave') {
    p.status = 'disabled';           // 停用不删档（借 ANC 的做法）
    event.note = b.note ?? '';
  } else if (b.op === 'rehire') {
    p.status = 'active';
  }

  save(org);
  event.snapshot_after = snapshotSha(org);

  // 推给线：线据此撤权 / 重算（岛不决定权限）
  const pushed = await fetch(`${LINE}/v1/org-sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot_sha: event.snapshot_after, people: load().people, teams: load().teams, event }),
  }).then((r) => r.json() as any).catch((e) => ({ ok: false, error: String(e) }));

  event.pushed_to_line = pushed;
  pushChange(event);
  log(`HR ${b.op} ${p.subject_id} → snapshot ${event.snapshot_after}；线回执 ${JSON.stringify(pushed).slice(0, 80)}`);
  return c.json({ ok: true, event });
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  const org = load();
  log(`岛 04 已启动 http://127.0.0.1:${PORT}（人 ${org.people.length} / 部门 ${org.teams.length} / snapshot ${snapshotSha(org)}）`);
});
