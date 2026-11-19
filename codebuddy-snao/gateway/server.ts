import { Hono } from 'hono';
import { readFileSync, statSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { GATEWAY_PORT, ISLAND_BASE, LINE_PORT, log } from '../line/config.js';

/**
 * 网关：SNAO 的唯一入口。
 * 做三件事，顺序固定：准入 → 放行 → 记录。
 * 它不解析业务、不改请求体，只决定"这个请求能不能到岛"。
 */
const LINE = `http://127.0.0.1:${LINE_PORT}`;
const BINDING_PATH = process.env.SNAO_BINDING
  ?? new URL('../deploy/binding.json', import.meta.url).pathname;

/**
 * 灰度绑定（UnitBinding 式）：按比例或按人把流量分到"新实现"。
 * 绑定文件一改就生效（按 mtime 重读）；回滚就是把 ratio 归零。
 */
let binding: any = null;
let bindingMtime = 0;
function loadBinding() {
  try {
    const st = statSync(BINDING_PATH);
    if (st.mtimeMs !== bindingMtime) {
      binding = JSON.parse(readFileSync(BINDING_PATH, 'utf8'));
      bindingMtime = st.mtimeMs;
      log(`绑定载入 current=${binding.current?.name} canary=${binding.canary?.name} ratio=${binding.ratio}`);
    }
  } catch { binding = null; }
  return binding;
}

/** 稳定散列：同一个人在灰度期内始终命中同一个实现 */
function hashPct(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
  return h % 100;
}

function pickBase(subject: string): { base: string; why: string } {
  const b = loadBinding();
  if (!b?.current?.base) return { base: ISLAND_BASE, why: 'no-binding' };
  const pin = b.pin?.[subject];
  if (pin === 'canary') return { base: b.canary.base, why: 'pinned-canary' };
  if (pin === 'current') return { base: b.current.base, why: 'pinned-current' };
  const ratio = Number(b.ratio ?? 0);
  if (ratio > 0 && hashPct(subject) < ratio) return { base: b.canary.base, why: `canary(${ratio}%)` };
  return { base: b.current.base, why: `current(ratio ${ratio})` };
}

/** 只放行这 5 组（其余一律 404，岛的边界由线划） */
const ALLOW: { name: string; test: (p: string) => boolean }[] = [
  { name: '认人', test: (p) => p === '/api/v1/users/me' || p.startsWith('/api/v1/api-keys') },
  { name: '权限', test: (p) => p.startsWith('/api/v1/roles') || p.startsWith('/api/v1/permissions') || /^\/api\/v1\/users\/[^/]+\/roles/.test(p) },
  { name: '下达', test: (p) => p.startsWith('/api/v1/agents') || p.startsWith('/api/v1/tasks') || p.startsWith('/api/v1/goals') },
  { name: '待决', test: (p) => /^\/api\/v1\/goals\/[^/]+\/supervision/.test(p) || /^\/api\/v1\/tasks\/[^/]+\/status/.test(p) },
  { name: '回执', test: (p) => p.startsWith('/api/v1/signals') || p === '/api/v1/usage' },
];

const app = new Hono();
app.get('/gw/health', (c) => c.json({ ok: true, service: 'snao-gateway', island: ISLAND_BASE }));

app.all('/api/v1/*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const method = c.req.method;
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');

  // 1) 认人
  if (!token) return c.json({ ok: false, error: 'NO_TOKEN' }, 401);
  const who = await fetch(`${LINE}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json() as any)
    .catch(() => ({ ok: false }));
  if (!who.ok) return c.json({ ok: false, error: 'BAD_TOKEN' }, 401);
  const subject: string = who.subject_id;

  // 岛的边界：不在名单里的路径，网关直接 404（不告诉调用方"岛有这条路由"）
  if (!ALLOW.some((g) => g.test(path))) {
    await rec(subject, method, path, 'blocked_not_allowlisted', null);
    return c.json({ ok: false, error: 'NOT_FOUND' }, 404);
  }

  // 2) 准入
  const action = `api.${method}.${path}`;
  const adm = await fetch(`${LINE}/v1/admit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, action, resource: path }),
  }).then((r) => r.json() as any);

  if (adm.result === 'need_decision') {
    log(`待决  ${subject} ${action}`);
    return c.json({ ok: false, error: 'NEED_DECISION', decision_id: adm.decision_id, run_id: adm.run_id }, 202);
  }
  if (adm.result !== 'allow') {
    await rec(subject, method, path, 'denied', null);
    return c.json({ ok: false, error: 'DENIED' }, 403);
  }

  // 3) 放行：透传到岛
  let upstream: Response;
  const target = pickBase(subject);
  try {
    upstream = await fetch(`${target.base}${path}`, {
      method,
      headers: { ...pick(c.req.raw.headers), 'x-snao-subject': subject },
      body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
    });
  } catch (e: any) {
    await rec(subject, method, path, 'island_unreachable', { error: String(e?.message ?? e) });
    return c.json({ ok: false, error: 'ISLAND_UNREACHABLE' }, 502);
  }

  await rec(subject, method, path, `upstream_${upstream.status}`, { via: target.base, why: target.why });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
});

function pick(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['content-type', 'accept', 'authorization']) {
    const v = h.get(k);
    if (v) out[k] = v;
  }
  return out;
}

async function rec(subject: string, method: string, path: string, outcome: string, detail: any) {
  await fetch(`${LINE}/v1/record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject_id: subject, action: `api.${method}.${path}`, target: path, outcome, detail }),
  }).catch(() => {});
}

serve({ fetch: app.fetch, port: GATEWAY_PORT, hostname: '127.0.0.1' }, () =>
  log(`网关已启动 http://127.0.0.1:${GATEWAY_PORT} → 岛 ${ISLAND_BASE}；线 :${LINE_PORT}`),
);
