# 给客户的部署清单（发布前逐条打勾）

> 这份是**发布前自检表**，不进客户可见的文档区。

## 一、仓库卫生

- [x] 有 `.gitignore`，且**拦住**：`.env`、`data/`、`node_modules/`、`.venv/`、`deploy/data/`（PG 数据）、`logs/`、`evolve/proposals/`
- [x] 提交体积 < 1MB（当前 58 个文件 / 0.7MB）
- [x] 无真实密钥：AIBot Secret / 自建应用 Secret / PG 密码 / 回调 Token 全部扫描为 0 命中
- [x] 代码里没有硬编码令牌（`line/seed.ts`、`gate/cases.yaml` 都改成读 `SNAO_ADMIN_TOKEN`）
- [x] 无平台绑定依赖（已移除 `@esbuild/darwin-arm64`，Windows/Linux 可装）
- [x] `engines.node >= 20`

## 二、一条命令能起来

```bash
./snao bootstrap   # 生成密钥 → 起岛 01 → 建库建表 → 发管理员令牌
./snao up          # 起全部
./snao verify      # 契约闸门 + 健康检查
```

- [x] `bootstrap` 幂等（重复跑不炸）
- [x] `up` 幂等
- [x] `down` 干净（进程按 pid 文件杀，docker compose down）
- [x] `status` 一眼看出谁活着
- [x] `verify` 输出 13/13 + 五个服务全绿

## 三、资源占用（16GB 机器实测）

| 组件 | 内存 |
|---|---|
| 岛 01 lobe | ~530 MB |
| 岛 01 rustfs | ~216 MB |
| 岛 01 postgres | ~83 MB |
| 岛 01 redis / gateway | < 20 MB |
| 宿主的线 + 网关 + 三个岛 | 各几十 MB |

- [x] `searxng` / `elasticsearch` / `fts-search-*` 默认不启动（`searxng` 收进 `--profile search`）

## 四、客户要改的只有三处

1. `deploy/.env` → `POSTGRES_PASSWORD`（其余密钥留空自动生成）
2. 可选：`WECOM_AIBOT_ID` / `WECOM_AIBOT_SECRET`（不填就收不到企微文件）
3. 可选：端口（默认 7000/7001/7200/7300/7400/13210）

## 五、已定 / 待定

- [x] **设计文档不进仓库**（2026-11-19 YG 定）：`SNAO_Framework_v1.1.md`、`SNAO_共识与决策`、`SNAO_四岛决策`、`SNAO_实现方案与路线图`、`调研/`、`AGENTS.md` 全部留在本地，已写进 `.gitignore`
- [x] 首次 commit：`33f92f8`，49 个文件 / 0.4MB；`.git` 仅 396K（重建过一次，清掉了早期误入的数据库对象）
- [x] 干净克隆验证：`git clone` → `npm install`（55 个包，3 秒）→ `./snao status` 正常
- [ ] 仓库地址与可见性（public / private）
- [ ] `LICENSE`（客户要商用授权，得有明确条款）
