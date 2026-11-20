# 岛 02：知识沉淀

**一件事**：把工作记录变成有归属、要确认、会淘汰的知识。
**三口**：`ingest` / `candidates` / `export`。
它只产出**候选**和**判定依据**，不替线决定任何事。

## 跑起来

```bash
cd codebuddy-snao
node --import tsx ./islands/precipitate/server.ts     # :7200
node line/pump-journal.mjs                            # 把线的 journal 递给它
```

岛内库：`snao_precipitate`（与线同 PG 实例、不同 database）。

## 三口

| 方法 | 路径 | 谁可以调 | 作用 |
|---|---|---|---|
| POST | `/v1/ingest` | **只接受线**（`x-snao-line-secret`） | 喂工作记录 → 生成候选 |
| GET | `/v1/candidates` | 线 / inbox | 候选清单，默认 `scope=personal` |
| POST | `/v1/export` | **只接受线** | 把已确认知识导出（给岛 01 索引） |

内部两口（供线与编排用）：`/v1/judge`（去重+矛盾+质量分）、`/v1/settle`（人裁之后回写）。

## 三条最重要的行为

1. **默认 `personal`**（D-09）：候选不确认不会进公司大脑；`candidates()` 默认只列"你自己的"。
2. **重复要标出来，不静默合并**：与已有知识相似度 ≥0.8 → 打 `dedup_of`，仍然留在候选里给人看。
3. **矛盾不由岛裁决**：同主体同属性不同值 → 打 `conflict_with` 并 `POST /v1/escalate` 上呈线；人裁完，线再调 `/v1/settle` 回写。

## P2 实测（2026-11-19）

预置一条知识「供应商A的价格是100元，账期30天」，再喂三条事件：

| 候选 | 内容 | 判定 | 结果 |
|---|---|---|---|
| #1 | 供应商A的价格是100元，账期30天 | `dedup_of=1` | 标为重复，留在候选里 |
| #2 | 供应商A的价格是120元，账期45天 | `conflict_with=1` → decision #5 | 人裁「以旧价为准」→ 候选 `rejected` |
| #3 | 客户B要求月底前交付第一批样品 | 无重复无矛盾 → intake decision #6 | 人裁同意 → 入库为知识 #2 |

`export` 返回 2 条知识（预置的一条 + 被接受的一条）。

## 换引擎前的可行性验证（2026-11-19 实测）

`cognee 1.6.10` + DeepSeek（OpenAI 兼容）+ 本地向量模型 `BAAI/bge-small-zh-v1.5`，实跑结果：

| 步骤 | 用时 | 结果 |
|---|---|---|
| `add` 3 条中文 | 8.9s | ✓ |
| `cognify` | 12.5s | ✓ |
| `search`「供应商A的价格是多少」 | 7.2s | 返回 4 条 |
| 图数据 | 0.0s | 17 节点 / 22 条边 |
| 血缘（`PROVENANCE_TRACKING=true`） | — | `provenance_entries` 11 / `provenance_edge_evidence` 53 |

**两个平台坑**：

1. **macOS 缺 OpenSSL 3**：cognee 的图库 `kuzu` 需要 `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`。
   有 brew 就 `brew install openssl@3`；没有就取一份 bottle 的 `lib` 目录并设 `DYLD_FALLBACK_LIBRARY_PATH`。
2. **向量模型名要对上 fastembed**：默认的 `openai/text-embedding-3-large` 不被支持，
   中文用 `EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5`。

跑法：`islands/precipitate/.venv/bin/python islands/precipitate/cognee-smoke.py`

## 已知缺口（P2 认了）

| 缺口 | 说明 | 下一步 |
|---|---|---|
| cognee 只装未接 | `cognee 1.6.10` 已装在 `islands/precipitate/.venv`，`provenance.tombstones` 可用；但 `cognify` 要 LLM key 或本地模型下载，本轮没跑通 | 配 key 后接进来，用它的 `conflicts` + `tombstones` 替换本文件的 `contradiction()` 与重复判定 |
| 去重是规则版 | 2–3 字 n-gram 的 Jaccard，够用但不懂语义 | 换 embedding 召回 + 模型判定 |
| 提取是规则版 | `extractFact()` 只认 `detail.text` / `detail.note` / 非 API 的 target | 换 ⑥ 知识提取 |
| 质量分是占位 | `0.3 + 相似度*0.4 + 长度/500` | 换真实指标（采纳次数、来源、时效） |
| 还不能写进岛 01 | `export` 只返回文档；写入岛 01 的知识库需要岛 01 鉴权 | P3 有身份后补 |
| 线 → 岛的搬运是手动脚本 | `pump-journal.mjs` 跑一次搬一次 | P3 做成定时/事件驱动 |
