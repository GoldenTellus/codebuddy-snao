# 岛 04：身份与组织

**一件事**：把「谁」接进来——人员、部门树、汇报线、负责人，以及它们的变更事件。
**四口**：`login` / `people` / `org` / `changes`。
**它只产出事实**：谁是 boss、谁在哪个部门、谁管哪些部门。「谁能看什么」由线算，这里一行判定都不写。

## 跑起来

```bash
cd codebuddy-snao
node --import tsx ./islands/identity/server.ts      # :7300
```

组织真相源：`org.json`（P3 用文件；下一版换成企微通讯录连接器，接口不变）。

## 四口

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/login` | 断言 → 主体（查不到 404，**不猜**） |
| GET | `/v1/people` | 人员：stable id、部门、职级、在职状态 + `snapshot_sha` |
| GET | `/v1/org` | 部门树 + 负责人 + `manages[]` + `snapshot_sha` |
| GET | `/v1/changes?since=` | 变更事件（入职/离职/调岗/负责人变更） |
| POST | `/v1/hr` | 触发一次组织变更（P3 的最小入口，之后换企微通讯录） |

## 三档角色怎么变成范围（线算，不是岛算）

线收到组织快照后，**自己**把标签算成范围（D-04/D-05）：

| 角色 | 线授予的 `knowledge.read` 范围 |
|---|---|
| boss | `personal:self` + `enterprise:*` + **全部** `team:*` |
| manager | `personal:self` + 自己 `team_id` + `manages[]` 里的每个部门 |
| employee | `personal:self` + 自己的 `team_id` |

**角色标签不推导范围**：`role=manager` 只说明"他是管理者"，能管哪些部门看 `manages[]`。

## P3.2 实测（2026-11-19）

| 场景 | 结果 |
|---|---|
| 全量同步 3 人 2 部门 | 线算出 10 条范围：boss 7 / manager 2 / employee 1 |
| 李四调岗 销售部→交付部 | `snapshot bf54…→b408…`；`team:team-a` → **deny**，`team:team-b` → **allow** |
| 李四离职 | `granted=7, disabled=['lisi']`；他名下范围 **0 条**；连 `personal:lisi` 都 **deny**（停用不删档，但不再给范围） |
| journal | `org.sync` 三条带 `snapshot_sha` + 事件详情；越权读记 `denied / out_of_scope` |

## 一个顺手修掉的语义错误

原来"没有授权"一律生成待决（`need_decision`）。这对**读知识**是错的：越权读不是"请人批准我读"，而是该**直接拒绝**（跨范围读是"披露"问题，走 disclosure，不是 authority）。

现在按动作族分流：

- `knowledge.read` 没范围 → **deny**
- `api.*` 没授权 → **need_decision**（能不能做这件事，由人批）

## 已知缺口

| 缺口 | 说明 |
|---|---|
| 组织源是本地 JSON | 不是企微通讯录；真源是文件，换连接器时四个口不变 |
| 矩阵组织没做 | 一人两部门仍不支持（按主部门归并，V1.1 单亲树的局限） |
| 离职没撤设备 | 设备表还没建（B-20 待接） |
| `manages[]` 不随调岗变 | 调岗只改 `team_id`；管理范围是人定的，不是自动的 |
