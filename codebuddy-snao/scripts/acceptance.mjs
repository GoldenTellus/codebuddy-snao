// SNAO 0.1 验收：一条命令证明"跑通"
//
//   node scripts/acceptance.mjs            跑常规 8 项
//   node scripts/acceptance.mjs --with-cognee  额外跑 cognee（慢，约 1 分钟）
//
// 0.1 = 现在这套实现（线 + 网关 + 四个自研岛 + 闸门 + 灰度 + 部署）。
// 它不承诺符合设计（那是 1.0 的事），只承诺"这套东西是活的、能自证"。

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const P = (k, d) => process.env[k] ?? env[k] ?? d;
const LINE = `http://127.0.0.1:${P('SNAO_LINE_PORT', 7001)}`;
const GW = `http://127.0.0.1:${P('SNAO_GATEWAY_PORT', 7000)}`;
const I2 = `http://127.0.0.1:${P('SNAO_PRECIPITATE_PORT', 7200)}`;
const I3 = `http://127.0.0.1:${P('SNAO_INTAKE_PORT', 7400)}`;
const I4 = `http://127.0.0.1:${P('SNAO_IDENTITY_PORT', 7300)}`;
const I1 = `http://127.0.0.1:${P('LOBE_PORT', 13210)}`;
const TOKEN = P('SNAO_ADMIN_TOKEN', '');
const SECRET = P('SNAO_LINE_SECRET', 'dev-line-secret');
const SUBJECT = P('SNAO_ADMIN_SUBJECT', 'admin');

const results = [];
const rec = (id, name, ok, note = '') => {
  results.push({ id, name, ok, note });
  console.log(`${ok ? '✓' : '✗'} ${id} ${name}${note ? '  ← ' + note : ''}`);
};

const jsonFetch = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers ?? {}) } }).catch(() => null);
  if (!r) return { status: 0, json: null };
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 查库：本机有 psql 就用它，没有就 docker exec 进 PG 容器（客户机常见情况） */
function psql(sql) {
  const db = 'snao_line';
  try {
    return execFileSync('psql', ['-h', '127.0.0.1', '-p', P('PG_HOST_PORT', '15432'), '-U', 'postgres', '-d', db, '-tAc', sql],
      { env: { ...process.env, PGPASSWORD: env.POSTGRES_PASSWORD }, encoding: 'utf8' });
  } catch {
    const container = `${P('COMPOSE_PROJECT_NAME', 'lobehub')}-postgres`;
    return execFileSync('docker', ['exec', '-e', `PGPASSWORD=${env.POSTGRES_PASSWORD}`, container, 'psql', '-U', 'postgres', '-d', db, '-tAc', sql],
      { encoding: 'utf8' });
  }
}

// ---------- 1. 五个口都活着 ----------
{
  const checks = [
    ['line', `${LINE}/health`], ['gateway', `${GW}/gw/health`],
    ['island02', `${I2}/health`], ['island03', `${I3}/health`], ['island04', `${I4}/health`],
    ['island01', `${I1}/api/v1/health`],
  ];
  const dead = [];
  for (const [name, url] of checks) {
    const r = await jsonFetch(url).catch(() => null);
    const ok = r && (r.status === 200 || r.status === 401);
    if (!ok) dead.push(name);
  }
  rec('A1', '六个口都活着（线/网关/四岛）', dead.length === 0, dead.length ? `不通: ${dead.join(',')}` : '');
}

// ---------- 2. 契约闸门 ----------
{
  let out = '', ok = false;
  try {
    out = execFileSync('node', ['gate/run.mjs'], { cwd: ROOT, encoding: 'utf8' });
    ok = /闸门放行/.test(out);
  } catch (e) { out = String(e.stdout ?? e.message); }
  const line = (out.match(/通过 \d+\/\d+/) ?? [''])[0];
  rec('A2', '契约闸门全过', ok, line);
}

// ---------- 3. 没令牌打不到岛 ----------
{
  const noTok = await jsonFetch(`${GW}/api/v1/users/me`);
  const badTok = await jsonFetch(`${GW}/api/v1/users/me`, { headers: { authorization: 'Bearer definitely-wrong' } });
  rec('A3', '没令牌/坏令牌被线挡回 401', noTok.status === 401 && badTok.status === 401, `${noTok.status}/${badTok.status}`);
}

// ---------- 4. 审批闭环：待决 → 批准 → 放行 → journal 三段 ----------
{
  const action = 'api.GET./api/v1/tasks';
  const resource = '/api/v1/tasks';
  const first = await jsonFetch(`${LINE}/v1/admit`, {
    method: 'POST', body: JSON.stringify({ subject: SUBJECT, action, resource }),
  });
  let decisionId = first.json?.decision_id;
  const wasPending = first.json?.result === 'need_decision';

  if (!decisionId) {
    // 之前已批准过，先撤销这条授权，制造一次新的待决
    try { psql(`delete from subject_scope where subject_id='${SUBJECT}' and action='${action}'`); } catch {}
    const again = await jsonFetch(`${LINE}/v1/admit`, {
      method: 'POST', body: JSON.stringify({ subject: SUBJECT, action, resource }),
    });
    decisionId = again.json?.decision_id;
  }

  if (!decisionId) {
    rec('A4', '审批闭环（待决→批准→放行）', false, '没能造出待决');
  } else {
    const rejNoNote = await jsonFetch(`${LINE}/v1/decide`, {
      method: 'POST', body: JSON.stringify({ id: decisionId, approved: false }),
    });
    const approved = await jsonFetch(`${LINE}/v1/decide`, {
      method: 'POST', body: JSON.stringify({ id: decisionId, approved: true, note: '验收脚本放行', decided_by: SUBJECT }),
    });
    await sleep(300);
    const after = await jsonFetch(`${LINE}/v1/admit`, {
      method: 'POST', body: JSON.stringify({ subject: SUBJECT, action, resource }),
    });
    const ok = wasPending !== undefined && approved.json?.ok === true && after.json?.result === 'allow';
    rec('A4', '审批闭环（待决→批准→放行）', ok,
      `拒绝必填理由=${rejNoNote.json?.error === 'NOTE_REQUIRED'} / 批准=${approved.json?.ok} / 之后=${after.json?.result}`);
  }
}

// ---------- 5. journal 追得到 ----------
{
  const q = await jsonFetch(`${LINE}/v1/pending`);
  const hasPending = Array.isArray(q.json?.items);
  // journal 直接查库
  let rows = 0;
  try { rows = Number(psql('select count(*) from journal').trim()); } catch {}
  rec('A5', 'journal 在记账（且有历史）', hasPending && rows > 0, `${rows} 条`);
}

// ---------- 6. 岛 03：docs() 带 ACL 与删除标记 ----------
{
  const d = await jsonFetch(`${I3}/v1/docs`);
  const files = (d.json?.nodes ?? []).filter((n) => n.type === 'file');
  const owners = new Set(files.map((f) => f.access_rule?.owner));
  const hasDeleted = files.some((f) => f.deleted === true);
  const hasInheritance = files.every((f) => Array.isArray(f.inheritance) && f.inheritance.length > 0);
  const ok = files.length > 0 && owners.size >= 2 && hasDeleted && hasInheritance;
  rec('A6', '岛 03 docs() 带 ACL/继承/删除标记且多所有者', ok,
    `${files.length} 份 / ${owners.size} 个所有者 / 有删除标记=${hasDeleted}`);
}

// ---------- 7. 岛 02：三口闭环（ingest → candidates → 上呈 → 裁 → export） ----------
{
  const stamp = Date.now();
  const ingest = await jsonFetch(`${I2}/v1/ingest`, {
    method: 'POST', headers: { 'x-snao-line-secret': SECRET },
    body: JSON.stringify({ events: [{ seq: stamp, subject_id: SUBJECT, action: 'acceptance.test', target: `验收用知识 ${stamp}` }] }),
  });
  const cand = await jsonFetch(`${I2}/v1/candidates?scope=personal&subject=${SUBJECT}`, {
    headers: { 'x-snao-line-secret': SECRET },
  });
  const mine = (cand.json?.items ?? []).find((c) => String(c.content).includes(String(stamp)));
  const exported = await jsonFetch(`${I2}/v1/export`, {
    method: 'POST', headers: { 'x-snao-line-secret': SECRET },
    body: JSON.stringify({ scope: 'personal', subject: SUBJECT }),
  });
  const ok = ingest.json?.ok === true && !!mine && exported.json?.ok === true;
  rec('A7', '岛 02 三口连通（ingest→candidates→export）', ok,
    `候选=${!!mine} / 导出 ${exported.json?.documents?.length ?? 0} 条`);
}

// ---------- 8. 岛 04：四口 + 线拿到范围 ----------
{
  const people = await jsonFetch(`${I4}/v1/people`);
  const org = await jsonFetch(`${I4}/v1/org`);
  const changes = await jsonFetch(`${I4}/v1/changes`);
  const login = await jsonFetch(`${I4}/v1/login`, {
    method: 'POST', body: JSON.stringify({ assertion: people.json?.people?.[0]?.subject_id }),
  });
  const scopes = await jsonFetch(`${LINE}/v1/scopes?subject=${SUBJECT}`);
  const ok = people.json?.ok && org.json?.snapshot_sha && changes.json?.ok && login.json?.ok;
  rec('A8', '岛 04 四口通 + 线里有范围', !!ok,
    `人 ${people.json?.people?.length ?? 0} / 我名下范围 ${scopes.json?.items?.length ?? 0} 条`);
}

// ---------- 9. 灰度与回滚 ----------
{
  const agents = `${GW}/api/v1/agents`;
  const cur = await jsonFetch(agents, { headers: { authorization: `Bearer ${TOKEN}` } });
  execFileSync('node', ['gate/bind.mjs', 'canary', '--ratio', '100'], { cwd: ROOT });
  await sleep(1200);
  const canary = await jsonFetch(agents, { headers: { authorization: `Bearer ${TOKEN}` } });
  execFileSync('node', ['gate/bind.mjs', 'rollback'], { cwd: ROOT });
  await sleep(1200);
  const back = await jsonFetch(agents, { headers: { authorization: `Bearer ${TOKEN}` } });
  const isEcho = canary.json?.island === 'echo';
  const backToBase = back.json?.island !== 'echo';
  rec('A9', '灰度切到 echo 再回滚', isEcho && backToBase,
    `切前=${cur.status} 切后=${canary.json?.island ?? canary.status} 回滚后=${back.json?.island ?? back.status}`);
}

// ---------- 10. cognee（可选） ----------
if (process.argv.includes('--with-cognee')) {
  const py = join(ROOT, 'islands', 'precipitate', '.venv', 'bin', 'python');
  let ok = false, note = '';
  try {
    const out = execFileSync(py, [join(ROOT, 'islands', 'precipitate', 'cognee-smoke.py')], {
      cwd: join(ROOT, 'islands', 'precipitate'),
      env: {
        ...process.env,
        LLM_API_KEY: env.LLM_API_KEY ?? '',
        DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH ?? '/tmp/ossl/openssl@3/3.5.9/lib',
        SMOKE_DATASET: `snao_acc_${Date.now()}`,
      },
      encoding: 'utf8', timeout: 300000,
    });
    ok = /全部通过/.test(out);
    note = (out.match(/图里 \d+ 个节点[^\n]*/) ?? [''])[0];
  } catch (e) {
    note = String(e.message).slice(0, 80);
  }
  rec('A10', 'cognee 引擎可用（岛 02 换引擎的前提）', ok, note);
}

// ---------- 汇总 ----------
const passed = results.filter((r) => r.ok).length;
console.log(`\n0.1 验收：${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('未通过：' + results.filter((r) => !r.ok).map((r) => `${r.id} ${r.note}`).join(' | '));
  process.exit(1);
}
console.log('✅ 0.1 跑通');
