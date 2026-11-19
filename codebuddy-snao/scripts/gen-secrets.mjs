// 生成/补齐密钥（幂等：只替换 CHANGE_ME 或空值，已有值不动）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ENV = join(here, '..', 'deploy', '.env');
const EXAMPLE = join(here, '..', 'deploy', '.env.example');

if (!existsSync(ENV)) {
  if (!existsSync(EXAMPLE)) { console.error('✗ 找不到 .env.example'); process.exit(1); }
  writeFileSync(ENV, readFileSync(EXAMPLE, 'utf8'));
  console.log('  已从 .env.example 创建 .env');
}

let s = readFileSync(ENV, 'utf8');

const hex = (n) => randomBytes(n).toString('hex');
const url = (n) => randomBytes(n).toString('base64url');
const uuid = () => randomUUID();

const RULES = {
  AUTH_SECRET: () => hex(32),
  KEY_VAULTS_SECRET: () => url(24),
  GATEWAY_SERVICE_TOKEN: () => hex(24),
  SNAO_LINE_SECRET: () => url(18),
  SNAO_ADMIN_TOKEN: () => url(24),
  RUSTFS_SECRET_KEY: () => url(16),
  POSTGRES_PASSWORD: () => url(18),
};

const changed = [];
for (const [key, gen] of Object.entries(RULES)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const cur = s.match(re);
  const needNew = !cur || /CHANGE_ME|^$/.test((cur[0].split('=')[1] ?? '').trim());
  if (needNew) {
    const val = gen();
    if (cur) s = s.replace(re, `${key}=${val}`);
    else s = s.replace(/\n*$/, `\n${key}=${val}\n`);
    changed.push(key);
  }
}

// 缺的键补上（不影响已有的）
const DEFAULTS = {
  SNAO_TENANT: 't1',
  SNAO_LINE_PORT: '7001',
  SNAO_GATEWAY_PORT: '7000',
  SNAO_PRECIPITATE_PORT: '7200',
  SNAO_INTAKE_PORT: '7400',
  SNAO_IDENTITY_PORT: '7300',
  PG_HOST_PORT: '15432',
  COMPOSE_PROJECT_NAME: 'snao',
  SNAO_ADMIN_SUBJECT: 'admin',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!new RegExp(`^${k}=`, 'm').test(s)) { s = s.replace(/\n*$/, `\n${k}=${v}\n`); changed.push(k); }
}

writeFileSync(ENV, s);
console.log(changed.length ? `  已生成/补齐: ${changed.join(', ')}` : '  密钥已齐，无需生成');
