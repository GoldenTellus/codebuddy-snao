// SNAO 闸门：契约测试 + 对比基线
//
// 做法（RSI 四道闸的第一道）：
//   1. 跑 cases.yaml 里每条用例
//   2. 和 baseline.json 比：通过数少了 / 关键指标退化了 → 拦下（exit 1）
//   3. 全过且不退步 → 可选把这次结果写成新基线
//
// 用法：
//   node gate/run.mjs            跑一遍，和基线比
//   node gate/run.mjs --save     跑一遍，通过则更新基线
//   node gate/run.mjs --verbose  打印每条用例细节

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = join(here, 'baseline.json');
const args = process.argv.slice(2);
const SAVE = args.includes('--save');
const VERBOSE = args.includes('--verbose');

// 端口可由环境变量覆盖，便于同一台机器跑多套或做干净环境验证
const TARGETS = {
  gateway: process.env.SNAO_GATEWAY_URL ?? `http://127.0.0.1:${process.env.SNAO_GATEWAY_PORT ?? 7000}`,
  line: `http://127.0.0.1:${process.env.SNAO_LINE_PORT ?? 7001}`,
  island02: `http://127.0.0.1:${process.env.SNAO_PRECIPITATE_PORT ?? 7200}`,
  island03: `http://127.0.0.1:${process.env.SNAO_INTAKE_PORT ?? 7400}`,
  island04: `http://127.0.0.1:${process.env.SNAO_IDENTITY_PORT ?? 7300}`,
};

/** 行内对象解析：把 `{ a: 1, json: { k: v } }` 变成对象（只支持我们写的形态） */
function parseInline(text) {
  const src = text.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  const out = {};
  if (!src) return out;

  // 按顶层逗号切开（忽略嵌套括号里的逗号）
  const parts = [];
  let depth = 0, buf = '';
  for (const ch of src) {
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  for (const part of parts) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('{')) v = parseInline(v);
    else if (v.startsWith('[')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1).split(',').map((x) => x.trim()); } }
    else if (/^\d+$/.test(v)) v = Number(v);
    else v = v.replace(/^"|"$/g, '');
    out[k] = v;
  }
  return out;
}

/** 极简 YAML 用例解析：只认我们写的那种结构，不引依赖 */
function parseCases(text) {
  const cases = [];
  let cur = null;
  let inExpect = false;

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- id:')) {
      if (cur) cases.push(cur);
      cur = { id: trimmed.slice(5).trim(), expect: {} };
      inExpect = false;
      continue;
    }
    if (!cur) continue;

    if (trimmed.startsWith('call:')) {
      cur.call = {};
      inExpect = false;
      // 支持行内写法：call: { target: gateway, method: GET, path: /x }
      const inline = trimmed.match(/\{(.+)\}/);
      if (inline) Object.assign(cur.call, parseInline(inline[0]));
      continue;
    }
    if (trimmed.startsWith('expect:')) {
      const inline = trimmed.match(/\{(.+)\}/);
      if (inline) { Object.assign(cur.expect, parseInline(inline[0])); inExpect = false; }
      else inExpect = true;
      continue;
    }
    if (trimmed.startsWith('why:')) { cur.why = trimmed.slice(4).trim(); inExpect = false; continue; }

    if (trimmed.startsWith('target:')) cur.call.target = trimmed.slice(7).trim();
    else if (trimmed.startsWith('method:')) cur.call.method = trimmed.slice(7).trim();
    else if (trimmed.startsWith('path:')) cur.call.path = trimmed.slice(5).trim();
    else if (trimmed.startsWith('headers:')) {
      // headers: { authorization: "Bearer x" }
      const m = trimmed.match(/\{(.+)\}/);
      cur.call.headers = {};
      if (m) for (const pair of m[1].split(',')) {
        const [k, v] = pair.split(':');
        if (k && v) cur.call.headers[k.trim()] = v.trim().replace(/^"|"$/g, '');
      }
    } else if (trimmed.startsWith('body:')) {
      const m = trimmed.match(/\{(.+)\}/);
      try { cur.call.body = JSON.parse('{' + (m ? m[1] : '') + '}'); } catch { cur.call.body = {}; }
    } else if (inExpect) {
      const m = trimmed.match(/^([a-z_]+):\s*(.+)$/);
      if (m) {
        let v = m[2].trim();
        if (v.startsWith('[')) { try { v = JSON.parse(v); } catch {} }
        else if (/^\d+$/.test(v)) v = Number(v);
        else if (v.startsWith('{')) { try { v = JSON.parse(v.replace(/([a-zA-Z_]+):/g, '"$1":')); } catch {} }
        else v = v.replace(/^"|"$/g, '');
        cur.expect[m[1]] = v;
      }
    }
  }
  if (cur) cases.push(cur);
  return cases;
}

async function call(c) {
  const base = TARGETS[c.target];
  if (!base) throw new Error(`未知 target: ${c.target}`);
  const res = await fetch(base + c.path, {
    method: c.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
    body: c.body ? JSON.stringify(c.body) : undefined,
  }).catch((e) => ({ status: 0, json: async () => ({ error: String(e) }) }));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** 期望是否满足。返回 null 表示通过，否则返回失败原因 */
function check(c, r) {
  const e = c.expect;
  if (e.status !== undefined && r.status !== e.status) return `状态码 ${r.status}，期望 ${e.status}`;
  if (e.status_in && !e.status_in.includes(r.status)) return `状态码 ${r.status}，期望其中之一 ${e.status_in}`;
  if (e.json) {
    for (const [k, v] of Object.entries(e.json)) {
      if ((r.json ?? {})[k] !== v) return `json.${k}=${JSON.stringify((r.json ?? {})[k])}，期望 ${JSON.stringify(v)}`;
    }
  }
  if (e.docs_min_total !== undefined) {
    if (!(r.json?.total >= e.docs_min_total)) return `docs.total=${r.json?.total}，期望 ≥ ${e.docs_min_total}`;
  }
  if (e.docs_deleted_at_least !== undefined) {
    if (!(r.json?.deleted >= e.docs_deleted_at_least)) return `docs.deleted=${r.json?.deleted}，期望 ≥ ${e.docs_deleted_at_least}`;
  }
  if (e.docs_owners_at_least !== undefined) {
    const owners = new Set((r.json?.nodes ?? []).filter((n) => n.type === 'file').map((n) => n.access_rule?.owner));
    if (owners.size < e.docs_owners_at_least) return `文档所有者只有 ${owners.size} 个，期望 ≥ ${e.docs_owners_at_least}（岛内不许预过滤）`;
  }
  if (e.has_fields) {
    for (const f of e.has_fields) if (!(f in (r.json ?? {}))) return `缺少字段 ${f}`;
  }
  return null;
}

// .env 里的值（含 SNAO_ADMIN_TOKEN）注入用例，避免把令牌写死进仓库
try {
  const envPath = join(here, '..', 'deploy', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) {
      const k = line.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = line.slice(i + 1).trim();
    }
  }
} catch { /* 没有 .env 就用现有环境变量 */ }

const interpolate = (v) =>
  typeof v === 'string' ? v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => process.env[k] ?? '') : v;

const cases = parseCases(readFileSync(join(here, 'cases.yaml'), 'utf8')).map((c) => ({
  ...c,
  call: { ...c.call, headers: Object.fromEntries(Object.entries(c.call.headers ?? {}).map(([k, v]) => [k, interpolate(v)])) },
}));
const results = [];
for (const c of cases) {
  let reason = null, r = { status: 0, json: null };
  try {
    r = await call(c.call);
    reason = check(c, r);
  } catch (e) {
    reason = String(e?.message ?? e);
  }
  results.push({ id: c.id, ok: !reason, reason, status: r.status });
  const mark = reason ? '✗' : '✓';
  console.log(`${mark} ${c.id}${reason ? '  ← ' + reason : ''}`);
  if (VERBOSE && reason) console.log('    why:', c.why);
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n通过 ${passed}/${total}`);

// 对比基线
let verdict = 'no-baseline';
let worse = [];
if (existsSync(BASE)) {
  const b = JSON.parse(readFileSync(BASE, 'utf8'));
  const bPassed = b.passed ?? 0;
  const regressed = b.cases?.filter((c) => c.ok && !results.find((r) => r.id === c.id)?.ok) ?? [];
  worse = regressed.map((c) => c.id);

  if (passed < bPassed) verdict = 'regressed';
  else if (regressed.length) verdict = 'regressed';
  else if (passed > bPassed) verdict = 'improved';
  else verdict = 'same';

  console.log(`基线：通过 ${bPassed}/${b.total}（${b.at}）→ 本次 ${passed}/${total}：${verdict}`);
  if (regressed.length) console.log(`退化的用例：${regressed.map((c) => c.id).join(', ')}`);
} else {
  console.log('基线：还没有（第一次运行，建议 --save）');
}

const snapshot = {
  at: new Date().toISOString(),
  passed, total,
  cases: results,
};
if (SAVE) {
  if (verdict === 'regressed') {
    console.log('\n⛔ 有退化，拒绝写基线（先修好再 --save）');
    process.exit(1);
  }
  writeFileSync(BASE, JSON.stringify(snapshot, null, 2));
  console.log(`\n基线已更新 → ${BASE}`);
  process.exit(0);
}

if (verdict === 'regressed') {
  console.log('\n⛔ 闸门拦下：相比基线有退化，不许合入');
  process.exit(1);
}
if (passed !== total) {
  console.log(`\n⛔ 闸门拦下：${total - passed} 条用例未通过`);
  process.exit(1);
}
console.log('\n✅ 闸门放行');
process.exit(0);
