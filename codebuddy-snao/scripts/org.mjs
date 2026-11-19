// 组织与人（不需要写代码、不需要 curl）
//
//   node scripts/org.mjs list                       看所有人
//   node scripts/org.mjs teams                      看部门
//   node scripts/org.mjs add --id lisi --name 李四 --team team-a --role employee
//   node scripts/org.mjs role --id lisi --role manager
//   node scripts/org.mjs move --id lisi --team team-b
//   node scripts/org.mjs leave --id lisi            离职（权限即时清零）
//   node scripts/org.mjs sync                       把组织现状推给线（改完文件后必跑）
//
// 真源是 islands/identity/org.json；线只接收"事实"，范围由线自己算。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const ORG_PATH = join(ROOT, 'islands', 'identity', 'org.json');

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'deploy', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const LINE = `http://127.0.0.1:${process.env.SNAO_LINE_PORT ?? env.SNAO_LINE_PORT ?? 7001}`;
const load = () => JSON.parse(readFileSync(ORG_PATH, 'utf8'));
const save = (o) => { o.updated_at = new Date().toISOString(); writeFileSync(ORG_PATH, JSON.stringify(o, null, 2)); };

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : def;
};

async function sync(line = LINE) {
  const org = load();
  const res = await fetch(`${line}/v1/org-sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot_sha: 'cli', people: org.people, teams: org.teams, event: { type: 'cli_sync' } }),
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
  return res;
}

switch (cmd) {
  case 'list': {
    const org = load();
    const teamName = Object.fromEntries(org.teams.map((t) => [t.team_id, t.name]));
    console.log('主体ID        姓名        部门        角色       管理范围            状态');
    for (const p of org.people) {
      console.log(
        `${p.subject_id.padEnd(13)} ${(p.name ?? '').padEnd(11)} ${(teamName[p.team_id] ?? p.team_id).padEnd(11)} ` +
        `${p.role.padEnd(10)} ${(p.manages ?? []).join(',') || '-'.padEnd(18)} ${p.status}`,
      );
    }
    break;
  }
  case 'teams': {
    const org = load();
    for (const t of org.teams) console.log(`${t.team_id.padEnd(10)} ${t.name}（负责人 ${t.head_id}）`);
    break;
  }
  case 'add': {
    const org = load();
    const id = opt('id');
    if (!id) { console.error('用法：add --id <主体ID> --name <姓名> --team <部门ID> --role employee|manager|boss'); process.exit(2); }
    if (org.people.some((p) => p.subject_id === id)) { console.error(`已存在：${id}（改部门用 move，改角色用 role）`); process.exit(2); }
    const team = opt('team', org.teams[0]?.team_id);
    if (!org.teams.some((t) => t.team_id === team)) { console.error(`没有这个部门：${team}（先看 teams）`); process.exit(2); }
    org.people.push({
      subject_id: id, name: opt('name', id), email: opt('email', `${id}@example.com`),
      team_id: team, role: opt('role', 'employee'), admin: false,
      manages: opt('role') === 'manager' ? [team] : [], status: 'active',
    });
    save(org);
    console.log(`已加入：${id}（${team} / ${opt('role', 'employee')}）`);
    console.log('推给线：', JSON.stringify(await sync()));
    break;
  }
  case 'role': {
    const org = load(); const id = opt('id'); const role = opt('role');
    const p = org.people.find((x) => x.subject_id === id);
    if (!p) { console.error(`没有这个人：${id}`); process.exit(2); }
    if (!['boss', 'manager', 'employee'].includes(role)) { console.error('角色只能是 boss / manager / employee'); process.exit(2); }
    p.role = role;
    if (role === 'manager' && !(p.manages ?? []).length) p.manages = [p.team_id];
    if (role === 'employee') p.manages = [];
    save(org);
    console.log(`已改：${id} → ${role}`);
    console.log('推给线：', JSON.stringify(await sync()));
    break;
  }
  case 'move': {
    const org = load(); const id = opt('id'); const team = opt('team');
    const p = org.people.find((x) => x.subject_id === id);
    if (!p) { console.error(`没有这个人：${id}`); process.exit(2); }
    if (!org.teams.some((t) => t.team_id === team)) { console.error(`没有这个部门：${team}`); process.exit(2); }
    const from = p.team_id; p.team_id = team;
    save(org);
    console.log(`已调岗：${id} ${from} → ${team}（原部门的知识立刻看不到）`);
    console.log('推给线：', JSON.stringify(await sync()));
    break;
  }
  case 'leave': {
    const org = load(); const id = opt('id');
    const p = org.people.find((x) => x.subject_id === id);
    if (!p) { console.error(`没有这个人：${id}`); process.exit(2); }
    p.status = 'disabled';
    save(org);
    console.log(`已离职：${id}（停用不删档，权限即时清零）`);
    console.log('推给线：', JSON.stringify(await sync()));
    break;
  }
  case 'sync': {
    console.log('推给线：', JSON.stringify(await sync()));
    break;
  }
  default:
    console.log(`用法：
  node scripts/org.mjs list
  node scripts/org.mjs teams
  node scripts/org.mjs add --id lisi --name 李四 --team team-a --role employee
  node scripts/org.mjs role --id lisi --role manager
  node scripts/org.mjs move --id lisi --team team-b
  node scripts/org.mjs leave --id lisi
  node scripts/org.mjs sync`);
}
