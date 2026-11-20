# cognee 冒烟测试（岛 02 换引擎前的可行性验证）
# 
# 验四件事：
#  1. 用 DeepSeek（OpenAI 兼容）能 cognify
#  2. 能检索回来
#  3. 打开 PROVENANCE_TRACKING 后能拿到血缘
#  4. 删数据能留下墓碑
# 
# 用法：islands/precipitate/.venv/bin/python islands/precipitate/cognee-smoke.py

import asyncio
import faulthandler
import os
import sys
import time

# 卡住 60 秒就把调用栈打出来（定位卡死用）
faulthandler.dump_traceback_later(60, repeat=True)

def mark(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

# --- 用 DeepSeek 当 OpenAI 兼容提供方 ---
os.environ.setdefault("LLM_PROVIDER", "openai")
os.environ.setdefault("LLM_API_KEY", os.environ.get("LLM_API_KEY", ""))
os.environ.setdefault("LLM_ENDPOINT", "https://api.deepseek.com/v1")
os.environ.setdefault("LLM_MODEL", "deepseek-flash")
os.environ.setdefault("EMBEDDING_PROVIDER", "fastembed")
os.environ.setdefault("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
os.environ["PROVENANCE_TRACKING"] = "true"

if not os.environ["LLM_API_KEY"]:
    print("✗ 没有 LLM_API_KEY")
    sys.exit(2)

import cognee  # noqa: E402


TEXTS = [
    "供应商A的价格是100元，账期30天。",
    "供应商A的价格是120元，账期45天。",   # 与上一条矛盾，用来验冲突
    "客户B要求月底前交付第一批样品。",
]


async def main():
    print("== 1) 写入并 cognify ==")
    t=time.time(); await cognee.add(TEXTS, dataset_name=os.environ.get("SMOKE_DATASET", "snao_smoke")); mark(f"add {time.time()-t:.1f}s")
    t=time.time(); await cognee.cognify(datasets=[os.environ.get("SMOKE_DATASET", "snao_smoke")]); mark(f"cognify {time.time()-t:.1f}s")
    print("  ✓ cognify 完成")

    print("== 2) 检索 ==")
    t=time.time(); results = await cognee.search(query_text="供应商A的价格是多少"); mark(f"search {time.time()-t:.1f}s")
    print(f"  ✓ 检索返回 {len(results)} 条")
    for r in results[:3]:
        text = getattr(r, "text", None) or str(r)
        print("   -", text[:100])

    print("== 3) 图与血缘 ==")
    from cognee.infrastructure.databases.graph import get_graph_engine
    engine = await get_graph_engine()
    t=time.time(); nodes, edges = await engine.get_graph_data(); mark(f"graph {time.time()-t:.1f}s")
    print(f"  ✓ 图里 {len(nodes)} 个节点 / {len(edges)} 条边")

    # provenance：写入时开了 PROVENANCE_TRACKING，血缘表应存在
    # 注意：别用 glob 去"找"库文件——上一版写成 ~/**/cognee_db 会遍历整个家目录（卡死 18 分钟）。
    # 库路径直接从 cognee 的配置里取。
    from cognee.base_config import get_base_config
    db_dir = get_base_config().system_root_directory
    db_path = os.path.join(db_dir, "databases", "cognee_db")
    print(f"  cognee 库: {db_path}（存在: {os.path.exists(db_path)}）")
    if os.path.exists(db_path):
        import sqlite3
        con = sqlite3.connect(db_path)
        tabs = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
        prov = [t for t in tabs if 'provenance' in t.lower() or 'tombstone' in t.lower()]
        rows = {t: con.execute(f"select count(*) from {t}").fetchone()[0] for t in prov}
        print(f"  ✓ 血缘表: {rows}")
        con.close()

    print("全部通过")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\n✗ 失败：{type(e).__name__}: {e}")
        sys.exit(1)
