# 本地 embedding 服务（OpenAI 兼容）
#
# 为什么需要：岛 01 的记忆检索与知识库检索都要 embedding，而 DeepSeek 不提供 embedding。
# 这里复用 cognee 已经下载的本地中文模型，起一个 /v1/embeddings，不额外花钱、不需要外网 key。
#
# 用法：
#   islands/precipitate/.venv/bin/python islands/embed/server.py        # 默认 :7500
#
# 接口：
#   GET  /health          → {"ok":true,"model":...}
#   POST /v1/embeddings   → {"data":[{"embedding":[...],"index":0}],"model":...}

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
PORT = int(os.environ.get("EMBED_PORT", "7500"))

try:
    from fastembed import TextEmbedding
except Exception as e:  # pragma: no cover
    print(f"✗ 缺少 fastembed：{e}", file=sys.stderr)
    sys.exit(2)

print(f"加载模型 {MODEL} …", flush=True)
_engine = TextEmbedding(model_name=MODEL)
DIM = len(next(iter(_engine.embed(["维度探测"]))))
print(f"✓ 模型就绪，维度 {DIM}", flush=True)


def embed(texts):
    return [v.tolist() for v in _engine.embed(texts)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "model": MODEL, "dim": DIM})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/embeddings"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
            raw = body.get("input")
            texts = [raw] if isinstance(raw, str) else list(raw or [])
            if not texts:
                return self._json(400, {"error": "input required"})
            vectors = embed(texts)
            return self._json(200, {
                "object": "list",
                "model": body.get("model") or MODEL,
                "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)],
                "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
            })
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"embedding 服务 http://0.0.0.0:{PORT}/v1/embeddings", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
