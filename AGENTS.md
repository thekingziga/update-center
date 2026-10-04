# Instructions for AI agents

1. Read `CONTEXT.md` first — it has the goal, architecture, decisions and the conversation log.
2. At the end of every session, append a dated entry to the **Conversation log** in
   `CONTEXT.md`: what the user asked, decisions, what changed, open issues/next steps.
   The user wants *all* context saved to files so any agent can continue.
3. Layout:
   - `server/` hub (Node, ESM, no build). Entry `server/index.js`.
   - `public/` web UI (vanilla JS, hash router in `app.js`).
   - `agent/uc-agent.py` Linux agent (Python 3 stdlib only, must stay compatible with 3.7+).
   - `agent/install.sh` installer served by the hub at `/install.sh`.
4. Run locally: `npm install && npm start` (http://localhost:8080). Test agent in Docker:
   see README "Development".
5. Never weaken the security model described in CONTEXT.md.
