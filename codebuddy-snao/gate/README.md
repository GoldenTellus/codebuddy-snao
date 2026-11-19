# 闸门（P4 第 1、2 项）

**为什么先做闸门**：RSI 的次序不能反——**闸门 → 沉淀 → 进化搜索 → 自改 harness**。
没有闸门就开自动改进，是把系统交给运气。

## 一、契约测试 + 对比基线（第 1 道闸）

```bash
node gate/run.mjs            # 跑一遍，和基线比
node gate/run.mjs --save     # 全过且不退化 → 更新基线
```

- 用例在 [`cases.yaml`](cases.yaml)，每条都是「谁 · 做什么 · 期望什么 · 为什么」
- 基线在 [`baseline.json`](baseline.json)：上一次的通过情况
- **判据**：通过数比基线少、或用例由过得变不过 → `exit 1`，**拦下**

### 实测：改坏一处判定逻辑，闸门抓住了

| 步骤 | 结果 |
|---|---|
| 把线里"别人的文档要上呈"改成"直接放行"（一个看起来很贴心的改动） | — |
| 跑闸门 | **12/13**，`regressed`，列出退化用例 `A-02-别人的文档上呈`，`exit 1`，**拦下** |
| 还原后跑闸门 | 13/13，`same`，放行 |

### 闸门自己也被抓过一次

第一版 `run.mjs` 有个真 bug：`expect: { json: { error: NEED_DECISION } }` 是行内写法，我的解析器只认缩进写法，**断言整行被丢掉**——于是所有用例"空过"，13/13 假通过。

是上面那次"故意改坏"暴露出来的：改坏了还全过，说明闸门没在测东西。
修法是加一个 `parseInline()`，现在行内/缩进两种写法都支持。

> 教训：**先证明闸门会失败，才能相信它的通过。**

## 二、灰度与回滚（第 2 道闸）

```bash
node gate/bind.mjs status                  # 看当前绑定
node gate/bind.mjs canary --ratio 30       # 30% 流量走新实现（按人稳定散列）
node gate/bind.mjs pin guoshuai canary     # 指定某人先走新实现
node gate/bind.mjs rollback                # 回滚：ratio=0 且清空 pin
```

绑定文件：[`deploy/binding.json`](../deploy/binding.json)。网关**按 mtime 热重载**，改完立刻生效，不用重启。

### 实测

| 操作 | 结果 |
|---|---|
| `ratio=0` | 请求走 current（LobeHub），返回它的 401 |
| `canary --ratio 100` | 同一 token 同一路径 → **echo 岛**返回 `{"island":"echo",...}` |
| `rollback` | 回到 LobeHub |
| `ratio=50` | 按主体散列：`guoshuai`(99)→current，`zhangjiayi`(10)→canary，`lisi`(3)→canary —— **稳定、可复现** |
| `pin guoshuai canary` | 即使是 current 也强制走 canary |

回滚是**一个文件、一行命令、无需重启**——这是"敢换实现"的前提。

## 三、还没做的

| 项 | 状态 |
|---|---|
| `promptfoo` 作 LLM 层评测 | 正在装（包很大）。当前闸门是**行为契约**层面；等有真实 prompt（岛 02 的提取/判定换模型后）再接 LLM 评测 |
| CI 钩子 | `node gate/run.mjs` 的退出码已经可用；挂到 CI 是加一行的事，但目前没有 CI 服务 |
| 自动回滚 | 现在是手动一行；"指标退化自动回滚"要等北极星指标（无人工介入率）有数据 |
