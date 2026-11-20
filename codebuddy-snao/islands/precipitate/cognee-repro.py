# 复现"重复 cognify 卡死"
#
# 目标：证明是"同一数据集第二次 cognify"卡住，并抓到卡在哪一帧。
# 手法：faulthandler 每 45 秒把当前所有线程的调用栈打出来（不需要额外依赖）。
#
# 用法：
#   DYLD_FALLBACK_LIBRARY_PATH=... EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5 \
#   LLM_API_KEY=... .venv/bin/python cognee-repro.py

import asyncio
import faulthandler
import os
import sys
import time

# 卡住 45 秒就打印一次栈，最多打 6 次
faulthandler.dump_traceback_later(45, repeat=True)

os.environ.setdefault("LLM_PROVIDER", "openai")
os.environ.setdefault("LLM_ENDPOINT", "https://api.deepseek.com/v1")
os.environ.setdefault("LLM_MODEL", "deepseek-flash")
os.environ.setdefault("EMBEDDING_PROVIDER", "fastembed")
os.environ.setdefault("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
os.environ["PROVENANCE_TRACKING"] = "true"

import cognee  # noqa: E402

DATASET = os.environ.get("REPRO_DATASET", "snao_repro")
TEXTS = [
    "复现用：供应商X的价格是200元。",
    "复现用：客户Y要求下月交付。",
]


def mark(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


async def timed(label, coro):
    t0 = time.time()
    r = await coro
    mark(f"{label} 完成，用时 {time.time() - t0:.1f}s")
    return r


async def main():
    round_no = int(os.environ.get("REPRO_ROUND", "1"))
    mark(f"开始第 {round_no} 轮（数据集 {DATASET}）")

    await timed("add", cognee.add(TEXTS, dataset_name=DATASET))
    await timed("cognify", cognee.cognify(datasets=[DATASET]))
    mark("本轮成功返回")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as e:
        import traceback
        traceback.print_exc()
        mark(f"失败：{type(e).__name__}: {e}")
        sys.exit(1)
