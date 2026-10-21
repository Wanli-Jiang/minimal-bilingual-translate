"""Mock OpenAI-compatible endpoint. Path prefix selects behaviour:
/v1   -> JSON array reply wrapped in <think> and a ```json fence (exercises the parser)
/bad  -> multi-item batches get prose instead of an array (exercises per-item fallback)
/deny -> HTTP 401
usage: python3 mock_openai.py <port> <log.jsonl>"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        texts = json.loads(req["messages"][-1]["content"])
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "origin": self.headers.get("Origin"),
                                "auth": self.headers.get("Authorization", "")[:13], "model": req.get("model"),
                                "items": len(texts), "extra_keys": sorted(set(req) - {"model", "messages"})}, ensure_ascii=False) + "\n")
        if self.path.startswith("/deny/"):
            return self.reply(401, {"error": {"message": "invalid api key"}})
        prefix = "[EN]" if "into English" in req["messages"][0]["content"] else "【译】"
        out = [prefix + t[:40] for t in texts]
        if self.path.startswith("/bad/") and len(texts) > 1:
            content = "Sure! Here are the translations:\n" + "\n".join(out)
        else:
            content = "<think>planning</think>```json\n" + json.dumps(out, ensure_ascii=False) + "\n```"
        self.reply(200, {"choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]})

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
