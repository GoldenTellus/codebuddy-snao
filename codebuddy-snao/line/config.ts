import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** 从 deploy/.env 读取（与 compose 共用一份凭据，避免两处维护） */
export const env = Object.fromEntries(
  readFileSync(join(here, '..', 'deploy', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

export const TENANT = process.env.SNAO_TENANT ?? 't1';
export const LINE_PORT = Number(process.env.SNAO_LINE_PORT ?? 7001);
export const GATEWAY_PORT = Number(process.env.SNAO_GATEWAY_PORT ?? 7000);
export const ISLAND_BASE = process.env.SNAO_ISLAND_BASE ?? 'http://127.0.0.1:13210';

/** 线自己的库；与岛内库同一 PG 实例、不同 database（省内存，见实现方案 §9） */
export const DB = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 15432),
  user: 'postgres',
  password: env.POSTGRES_PASSWORD,
  database: process.env.SNAO_DB ?? 'snao_line',
};

export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
