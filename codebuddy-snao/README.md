# SNAO 1.0（四岛形态）

> 这是**部署包**。客户机器上克隆下来、填几个值、一条命令起来。

---

## 一台机器上跑着的东西

```
                    ┌─────────────── 宿主（一台常开的机器）───────────────┐
   浏览器 / 企微 ───▶│  网关 :7000  ──▶  线 :7001（谁可以做什么/谁来决定/发生过什么） │
                    │      │                                            │
                    │      ├─▶ 岛 01 LobeHub   :13210  （人机协同界面，docker）│
                    │      ├─▶ 岛 02 沉淀       :7200  （候选 → 人裁 → 知识）│
                    │      ├─▶ 岛 03 接入       :7400  （企微机器人收文件）│
                    │      └─▶ 岛 04 身份       :7300  （人/部门/角色/离职）│
                    └───────────────────────────────────────────────────┘
```

**岛可以买、可以换；线不换。** 线只持三样：谁可以做什么 / 谁来决定 / 发生过什么。

---

## 一、准备

| 依赖 | 版本 | 说明 |
|---|---|---|
| Docker + Compose v2 | 任意较新版 | 只用来跑岛 01 |
| Node.js | ≥ 20（推荐 22） | 线、网关、岛 02/03/04 |
| 内存 | ≥ 8GB（推荐 16GB） | 岛 01 约占 500MB–1.5GB |

## 二、部署（四步）

```bash
# 1. 克隆
git clone <你的仓库地址> codebuddy-anc
cd codebuddy-anc/codebuddy-snao

# 2. 装依赖
npm install

# 3. 配置
cp deploy/.env.example deploy/.env
#   打开 deploy/.env，至少填 POSTGRES_PASSWORD；其余密钥留空会自动生成

# 4. 一条命令拉起（会自动生成密钥、建库建表、发管理员令牌）
./snao bootstrap
```

`bootstrap` 跑完会打印**管理员令牌**，把它记下来（也可以随时 `./snao token` 取）。

## 三、日常

```bash
./snao up        # 起全部（幂等，重复跑没事）
./snao down      # 全停
./snao status    # 看谁活着
./snao logs line # 看某个服务日志
./snao verify    # 跑契约闸门 + 健康检查
```

## 四、验收（第一次部署后该看到什么）

```bash
./snao verify
```

期望：`通过 13/13`，`✅ 闸门放行`，五个宿主服务全绿。

手工验两条最关键的：

```bash
TOKEN=$(./snao token)

# ① 不带令牌打不到岛（应该 401，由线判，不是岛判）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7000/api/v1/users/me

# ② 带令牌能透传到岛（401 是岛自己的鉴权，说明请求真的到了）
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "authorization: Bearer $TOKEN" http://127.0.0.1:7000/api/v1/users/me
```

第一次用某个接口会被线拦下变成**待决**，去审批台批准一次，之后自动放行：

<http://127.0.0.1:7001/inbox>

## 五、接企业微信（可选）

不配也能跑，只是收不到文件。

1. 企微后台 → 智能机器人 → 建一个 → 拿 `Bot ID` 和 `Secret`
2. 填进 `deploy/.env` 的 `WECOM_AIBOT_ID` / `WECOM_AIBOT_SECRET`
3. `./snao up`
4. 把文件发给这个机器人 → 自动进岛 03，归属和可见范围来自消息本身

**注意**：微盘/文档 API 是另一条路，它要求「企业可信IP」，而可信IP 又要求**域名备案主体与企业一致**。没有备案域名就只能用机器人这条通道。

## 六、目录

```
codebuddy-snao/
├── snao            一键运维（bash，无额外依赖）
├── line/           线：schema + 服务 + 审批台 + journal
├── gateway/        网关：唯一入口，认人 → 准入 → 放行 → 记录
├── islands/
│   ├── precipitate/ 岛 02 沉淀（ingest/candidates/export）
│   ├── intake/      岛 03 接入（企微机器人 → 文档事实）
│   ├── identity/    岛 04 身份（人/部门/角色 + 组织快照）
│   └── echo/        换岛试验用的假岛
├── gate/           契约闸门 + 灰度回滚
├── evolve/         进化提案（只在沙箱跑，不自动上线）
├── deploy/         docker-compose + .env.example
├── scripts/        建库建表
└── data/           运行时文件（不进仓库）
```

## 七、换岛怎么做（SNAO 的核心承诺）

1. 改 `deploy/binding.json` 把 canary 指向新岛
2. `node gate/bind.mjs pin <某人> canary` 先给一个人试
3. `node gate/bind.mjs canary --ratio 30` 再放 30% 流量
4. 不对就 `node gate/bind.mjs rollback`

**线一行不用改。**

## 八、注意

- `deploy/.env` 含密钥，**已在 .gitignore 里**，不要提交
- `data/` 存客户文件，不进仓库
- 岛 01 的所有端口只绑 `127.0.0.1`，不对局域网暴露
