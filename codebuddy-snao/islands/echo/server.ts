import { Hono } from 'hono';
import { serve } from '@hono/node-server';

/**
 * echo 岛：换岛试验用的假岛。
 * 它只证明一件事——把岛换掉，线一行不用改仍然成立（共识 §1.5 的最小证明）。
 */
const PORT = Number(process.env.SNAO_ECHO_PORT ?? 7100);
const app = new Hono();

app.all('/api/v1/*', async (c) => {
  const path = new URL(c.req.url).pathname;
  const body = c.req.method === 'GET' ? null : await c.req.text();
  return c.json({
    island: 'echo',
    method: c.req.method,
    path,
    subject: c.req.header('x-snao-subject') ?? null,
    body_bytes: body?.length ?? 0,
    note: '这是 echo 岛：证明岛可整体换掉而线不变',
  });
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () =>
  console.log(`echo 岛已启动 http://127.0.0.1:${PORT}`),
);
