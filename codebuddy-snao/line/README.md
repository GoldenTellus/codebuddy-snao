# 线（line）—— 谁可以做什么 / 谁来决定 / 发生过什么

P1 的最小实现。**它只持三样东西**，不知道岛内怎么实现，也不接收岛的任何"判定"。

| 端口 | 服务 | 说明 |
|---|---|---|
| 7001 | 线本身 | `admit` / `pending` / `decide` / `record` + 一页 inbox |
| 7000 | 网关 | 唯一入口：认人 → 准入 → 放行 → 记录 |
| 7100 | echo 岛 | 换岛试验用的假岛（证明线不依赖具体岛） |

## 跑起来

```bash
cd codebuddy-snao
npm run seed      # 建表 + 发 token + 2 条初始授权
npm run line      # 线  :7001
npm run gateway   # 网关 :7000
# 换岛试验时：
SNAO_ISLAND_BASE=http://127.0.0.1:7100 npm run gateway
# 假岛：
node --import tsx ./islands/echo/server.ts
```

`inbox`：<http://127.0.0.1:7001/inbox>

## 数据模型（`schema.sql`）

| 表 | 是什么 |
|---|---|
| `subject_scope` | 谁可以做什么（`subject × action × resource`，可过期、可撤销） |
| `subject_token` | 谁能进门（只存 token 的 sha256，不存明文） |
| `decision` | 谁来决定（待决事项：`reason` / `payload` / `status` / `decided_by` / `decision_note` / SLA） |
| `journal` | 发生过什么（**append-only**，触发器禁止 update/delete） |

`tenant_id` 照常存在，值恒为 `t1`（D-08）。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 存活 |
| GET | `/v1/whoami` | token → subject（查不到就 401，**不猜**） |
| POST | `/v1/admit` | `{subject, action, resource}` → `allow` / `need_decision` |
| GET | `/v1/pending` | 待决清单 |
| POST | `/v1/decide` | `{id, approved, note, decided_by}`；**拒绝必须写理由** |
| POST | `/v1/record` | 回执（只追加，不解释） |

## 网关的边界

只放行 5 组，其余一律 404，**不告诉调用方"岛有这条路由"**：

```
认人    /api/v1/users/me、/api/v1/api-keys
权限    /api/v1/roles、/api/v1/permissions、/api/v1/users/{id}/roles
下达    /api/v1/agents、/api/v1/tasks、/api/v1/goals
待决    /api/v1/goals/{id}/supervision、/api/v1/tasks/{id}/status
回执    /api/v1/signals、/api/v1/usage
```

## P1 验收（2026-11-19 实测，四条全过）

| # | 判据 | 结果 |
|---|---|---|
| 1 | 不带 token 打不到岛 | ✅ 401（由线判定，不是岛） |
| 2 | 两个身份能力不同 | ✅ `guoshuai` 放行到岛；`zhangjiayi` 无授权 → 202 待决 |
| 3 | 挂起 → 批准 → 继续，journal 三段 | ✅ `need_decision`(seq2) → `decision.approve`(seq4) → `upstream_401`(seq5) |
| 4 | 换岛（echo）后线不改 | ✅ 同一 token 命中 echo，`x-snao-subject` 正确；未授权身份仍 202 |

## 已知缺口（P1 认了）

| 缺口 | 说明 |
|---|---|
| 岛仍在本机 13210 可直连 | 为了能用 UI 登录；做到"物理上只有一个口"要等 UI 也走网关（P2 之后） |
| `need_decision` 是阻塞的 | 调用方拿到 202 要自己重试；异步通知（企微主动推送）在 P2 接 |
| 授权粒度是"精确路径" | `api.GET./api/v1/agents` 与 `api.POST./api/v1/agents` 是两条；够用，但会变多 |
| inbox 里 `decided_by` 写死 | 还没有登录态；等岛 04 的身份进来再换成真主体 |
