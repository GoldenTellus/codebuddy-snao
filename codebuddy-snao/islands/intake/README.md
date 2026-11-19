# 岛 03：接入

**一件事**：把企业里的外部资料原样拿进来——带 ACL、带删除标记，**不做任何预过滤**。
**三口**：`sources` / `docs` / `ingest`（`ingest` 只给岛内采集器用，不对外）。
**它只产出事实**：有哪些源、源里有什么、谁放的、可见范围是什么、删了没有。「谁能看」由线算。

## 为什么是 AIBot 通道（C-03 的落地形态）

原计划接**企业微信微盘/文档 API**，实测被一条链卡死：

```
微盘/通讯录 API → 需要「企业可信IP」
企业可信IP     → 需要「可信域名」或「接收消息服务器URL」
这两样         → 需要域名主体 = 本企业 且 已备案
```

`dntai.online` 填入「设置可信域名」→ 实测报「域名主体校验未通过」。临时隧道 + 自写 AES 验证服务也被同一条主体校验挡回。

**改用 AIBot 长连接**：`@wecom/aibot-node-sdk` 支持 `file` 消息与 `downloadFile(url, aeskey)`，这条路**不需要备案、不需要可信 IP**。

代价说清楚：拿到的是**用户主动发给 SNAO 的文件**，不是微盘的存量自动同步。等备案域名到位，写一个微盘 adapter 换上去——**换的是 adapter，三个口和线一行不动**（共识 §1.5）。

## 跑起来

```bash
cd codebuddy-snao
node --import tsx ./islands/intake/server.ts        # 岛 03，:7400
node islands/intake/aibot-listener.mjs              # 采集器（AIBot 长连接）
```

岛内库：`snao_intake`；文件落 `codebuddy-snao/data/intake/<sha256>`。

## `docs()` 的输出（照 pipeshub 的权限模型）

```json
{
  "snapshot_sha": "f698e5841caf752c",
  "total": 2, "deleted": 1,
  "nodes": [
    { "id": "wecom-aibot:space:guoshuai", "type": "space", "name": "与 guoshuai 的会话" },
    { "id": "wecom-aibot:doc:2", "type": "file", "name": "群里的资料.md",
      "parent_id": "wecom-aibot:space:zhangjiayi",
      "inheritance": ["wecom-aibot:space:zhangjiayi"],
      "grants": [{ "subject": "zhangjiayi", "role": "owner" }],
      "access_rule": { "visibility": "personal", "owner": "zhangjiayi", "space_id": "zhangjiayi" },
      "deleted": false, "sha256": "87832b5c…", "size": 27 }
  ]
}
```

## P3.1 实测（2026-11-19）

| 判据 | 结果 |
|---|---|
| `docs()` 原样带 ACL + 删除标记 | ✅ 节点树 + `inheritance` + `grants` + `access_rule` + `deleted` |
| 删一份 → 下线 | ✅ `deleted:true` + `snapshot_sha` 从 `c9e715…` 变 `f698e5…` |
| 改权限 → 可见性跟着变 | ✅ 群空间 → 单聊：`visibility: space → personal`，`space_id` 也跟着变 |
| 岛内不预过滤 | ✅ 同时返回 `guoshuai` 和 `zhangjiayi` 两份文档，不按调用者身份裁剪 |

顺手修掉一个真 bug：`on conflict` 原来只更新文件名/大小/哈希，**不更新归属和空间**——所以"源里改权限"不会传导。现在会。

## 已知缺口

| 缺口 | 说明 |
|---|---|
| ~~还没收到过真实企微文件~~ | ✅ 2026-11-19 收到并入库第一张真实图片（`msgid=1a4860c6…`，113272 字节 JPEG，AES 解密验证正确） |
| 第一版漏了 `image` | 只写了 `message.file`，你把图片发来时没响应；现已统一处理 `file/image/video/voice` |
| 只支持单个媒体 | `mixed`（文+图混排）里的附件没展开 |
| 撤回不自动标记删除 | 企微没给撤回事件；现在靠发 `/del 文件名` |
| 没有存量同步 | 这是投喂通道，不是同步器；等备案域名接微盘 |
