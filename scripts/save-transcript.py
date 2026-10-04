#!/usr/bin/env python3
"""Claude Code Stop hook: copy this session's transcript into .context/transcripts/
as raw JSONL plus a readable Markdown version (user + assistant text only)."""
import json, os, shutil, sys

hook = json.load(sys.stdin)
src = hook.get("transcript_path")
root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
if not src or not os.path.exists(src):
    sys.exit(0)
out = os.path.join(root, ".context", "transcripts")
os.makedirs(out, exist_ok=True)
base = os.path.splitext(os.path.basename(src))[0]
shutil.copy(src, os.path.join(out, base + ".jsonl"))

lines = []
for raw in open(src, encoding="utf-8"):
    try:
        e = json.loads(raw)
    except ValueError:
        continue
    msg = e.get("message") or {}
    role = msg.get("role")
    if e.get("type") not in ("user", "assistant") or role not in ("user", "assistant"):
        continue
    content = msg.get("content")
    parts = [content] if isinstance(content, str) else [
        c.get("text", "") for c in (content or []) if isinstance(c, dict) and c.get("type") == "text"]
    text = "\n".join(p for p in parts if p and p.strip())
    if text.strip():
        lines.append("## %s  (%s)\n\n%s\n" % (role.upper(), e.get("timestamp", ""), text.strip()))
with open(os.path.join(out, base + ".md"), "w", encoding="utf-8") as f:
    f.write("# Transcript %s\n\n" % base + "\n".join(lines))
