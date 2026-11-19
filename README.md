# SNAO 1.0

**四岛形态**：一台常开的机器上跑着 **一条线 + 四个岛**。

- **线**持三样：谁可以做什么 / 谁来决定 / 发生过什么。线不换。
- **岛**是一件事加这件事当下最好的实现，对外只有一个口，**可以整体换掉**。

| 岛 | 干什么 | 形态 |
|---|---|---|
| 01 | 人机协同界面 | LobeHub（买来的，docker） |
| 02 | 知识沉淀 | 自研：候选 → 人裁 → 知识 |
| 03 | 数据接入 | 自研：企微机器人收文件 → 文档事实 |
| 04 | 身份与组织 | 自研：人 / 部门 / 角色 / 离职 |

## 快速开始

```bash
cd codebuddy-snao
npm install
cp deploy/.env.example deploy/.env    # 至少填 POSTGRES_PASSWORD
./snao bootstrap
```

`bootstrap` 会生成密钥、起岛 01、建库建表、打印管理员令牌。然后：

```bash
./snao up        # 起全部
./snao verify    # 契约闸门 + 健康检查
```

完整部署说明见 [codebuddy-snao/README.md](codebuddy-snao/README.md)。
装完怎么用（审批台 / 加人 / 接企微 / 换岛）见 [codebuddy-snao/docs/上手.md](codebuddy-snao/docs/上手.md)。

## 环境要求

Docker + Compose v2 · Node.js ≥ 20 · 内存 ≥ 8GB（推荐 16GB）

## 它凭什么敢用

- **契约闸门**：13 条行为用例 + 基线，改坏了会被拦下（`./snao gate`）
- **换岛可回滚**：一个绑定文件 + 一行命令，线一行不改
- **每个决定都留痕**：谁批的、批了什么、为什么，全在 journal 里，且不可改不可删
