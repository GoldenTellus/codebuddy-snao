#!/usr/bin/env node
// 岛 02 → 岛 01 知识库（W1.2）
//
// 为什么需要它：岛 02 只负责“产出知识事实”，岛 01 才是人检索的地方。
// 这条脚本把岛 02 的最新知识写进岛 01 的知识库：上传 → 分块 → 向量化。
//
// 用法：
//   node islands/precipitate/export-to-lobe.mjs
//
// 需要 .env 里有：
//   LOBE_BASE（默认 http://127.0.0.1:13210）
//   LOBE_API_KEY（岛 01 的 API Key，sk-lh- 开头）
//   LOBE_KB_ID（目标知识库 id，kb_ 开头）
//
// 说明：
//   1. 岛 01 没有“把文件挂进知识库”的 API（实测 404），只能写 knowledge_base_files 表。
//      这一步用 docker exec psql 完成，属已知缺陷，见收尾计划 A3。
//   2. 分块+向量化通过 POST /api/v1/files/{id}/chunks 触发，需要 embedding 服务在跑（./snao up）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ENV = new URL('../../deploy/.env', import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(ENV, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const BASE = env.LOBE_BASE || 'http://127.0.0.1:13210';
const KEY = env.LOBE_API_KEY;
const KB = env.LOBE_KB_ID;
const ISLAND02 = env.SNAO_PRECIPITATE_URL || 'http://127.0.0.1:7200';

if (!KEY || !KB) {
  console.error('✗ 缺 LOBE_API_KEY 或 LOBE_KB_ID（写在 deploy/.env）');
  process.exit(2);
}

const H = { authorization: `Bearer ${KEY}` };

const linkFileToKb = (fileId) => {
  const pg = env.POSTGRES_PASSWORD;
  const sql = `insert into knowledge_base_files (knowledge_base_id, file_id, user_id)
    select '${KB}', '${fileId}', id from users limit 1 on conflict do nothing`;
  execFileSync('docker', ['exec', '-e', `PGPASSWORD=${pg}`, 'lobehub-postgres',
    'psql', '-U', 'postgres', '-d', 'lobechat', '-q', '-c', sql]);
};

const upload = async (name, text) => {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/markdown' }), name);
  const r = await fetch(`${BASE}/api/v1/files`, { method: 'POST', headers: H, body: fd });
  const j = await r.json();
  if (!j.success) throw new Error(`上传失败 ${name}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data.file.id;
};

const chunk = async (fileId) => {
  const r = await fetch(`${BASE}/api/v1/files/${fileId}/chunks`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}',
  });
  return (await r.json()).success;
};

const main = async () => {
  console.log(`岛 02 → 岛 01（知识库 ${KB}）`);
  // 岛 02 的 export 只认线的调用（ONLY_FROM_LINE），且是 POST
  const res = await fetch(`${ISLAND02}/v1/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-snao-line-secret': (env.SNAO_LINE_SECRET || 'dev-line-secret') },
    body: JSON.stringify({}),
  });
  const { documents = [] } = await res.json();
  const items = documents.map((d) => ({
    id: d.id,
    body: d.content,
    title: (d.content || '').split('\n')[0].slice(0, 40),
  }));
  console.log(`待导出知识：${items.length} 条`);

  let ok = 0;
  for (const it of items) {
    const name = `kb-${it.id}.md`;
    const body = `# ${it.title || it.id}\n\n${it.body || it.content || ''}\n`;
    try {
      const fileId = await upload(name, body);
      linkFileToKb(fileId);
      await chunk(fileId);
      console.log(`  ✓ ${name} → ${fileId}`);
      ok += 1;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }
  console.log(`完成：${ok}/${items.length}`);
};

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
