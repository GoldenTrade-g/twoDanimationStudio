# Simple 2D Animation Studio — Upload to GitHub, Then Clone & Compile

Complete, copy-paste implementation steps. Tested against this repository
(npm workspaces: `shared/`, `backend/`, `frontend/`; Vite + React frontend on
port 5173, Express backend on port 8787).

---

## 0. Prerequisites (check first)

```bash
node --version    # must be >= 18 (Node 20 LTS recommended)
npm --version     # >= 9 ships with Node 18+
git --version     # any recent git
ffmpeg -version   # REQUIRED only for MP4/GIF export (skip if you don't need them)
```

Install FFmpeg if missing:

- **Ubuntu/Debian:** `sudo apt update && sudo apt install -y ffmpeg`
- **macOS (Homebrew):** `brew install ffmpeg`
- **Windows:** `winget install Gyan.FFmpeg` (or download from ffmpeg.org and add to PATH)

The app still runs without FFmpeg; the Export dialog will show a clear
"FFmpeg not available" message instead of failing silently.

---

## 1. Push this repository to GitHub

### 1a. Create an empty repo on GitHub
Go to https://github.com/new → name it e.g. `simple-2d-animation-studio` →
**do NOT** add README/.gitignore/license (this project already has them) → Create.

### 1b. Commit and push from your machine

```bash
cd /path/to/simple-2d-animation-studio

# --- security check BEFORE pushing: never commit real secrets ---
grep -RIn "sk-[A-Za-z0-9]\{20,\}" . --exclude-dir=node_modules --exclude-dir=.git || echo "OK: no OpenAI-style keys found"
cat .gitignore | grep -E "^\.env$"   # must list .env (it does)
test -f .env && echo "WARNING: local .env exists but is gitignored (safe)"

git status                    # review what will be committed
git add -A
git commit -m "Simple 2D Animation Studio: full editor, timeline, LLM adapters, export pipeline"

git branch -M main
git remote add origin https://github.com/<YOUR-USERNAME>/simple-2d-animation-studio.git
git push -u origin main
```

If you use SSH instead of HTTPS:
`git remote set-url origin git@github.com:<YOUR-USERNAME>/simple-2d-animation-studio.git`

Notes:
- `.env` is gitignored — your `STUDIO_SECRET_KEY` and provider keys are NEVER pushed.
- If `git status` shows files under `node_modules/`, `dist/`, or `.env`, stop and fix
  `.gitignore` before pushing.

### 1c. (Optional) protect the main branch
GitHub → Settings → Branches → Add rule: require PR + passing CI before merge.

---

## 2. Clone the repo on a new machine (the "compile the same" part)

```bash
git clone https://github.com/<YOUR-USERNAME>/simple-2d-animation-studio.git
cd simple-2d-animation-studio
```

---

## 3. Install dependencies (installs ALL workspaces at once)

```bash
npm install
```

This single command installs root dev tools plus `shared/`, `backend/`, and
`frontend/` workspace dependencies and symlinks the workspaces together.
Expected: completes in ~1–2 min on first run; no errors. Peer-dep warnings are OK.

---

## 4. Configure environment

```bash
cp .env.example .env
```

Generate a real encryption key and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# copy the output into .env as: STUDIO_SECRET_KEY=<64 hex chars>
```

`.env` reference (all variables):

```ini
# Backend HTTP port (Vite dev server proxies /api to this)
PORT=8787
# AES-256-GCM key used to encrypt stored LLM credentials at rest (REQUIRED to persist providers)
STUDIO_SECRET_KEY=<paste 64-hex string here>
# Optional: pre-seed one provider so the browser never handles secret keys
# OPENAI_API_KEY=***            # server-side only, read from env
# OPENAI_BASE_URL=https://api.openai.com/v1
```

Security rules (already implemented — do not bypass):
- Secret keys live ONLY on the server (`.env`) or encrypted in the server's
  credential store. They are never sent to the browser, logged, or exported.
- Changing `STUDIO_SECRET_KEY` invalidates previously saved provider credentials;
  re-enter them in the Providers dialog afterwards.

---

## 5. Verify (type checks + full test suite)

```bash
npm run typecheck        # tsc --noEmit for shared, backend, frontend -> expect 0 errors
npm test                 # expect: shared 16/16, backend 16/16, frontend 42/42 (74 total)
```

Run a single suite if needed:

```bash
npm test -w shared
npm test -w backend
npm test -w frontend
```

---

## 6. Run in development mode

```bash
npm run dev
```

Starts both servers via `concurrently`:
- Frontend (Vite): **http://localhost:5173**
- Backend API:      **http://localhost:8787** (`/api/health`, `/api/providers`, `/api/export/*`)

Open http://localhost:5173 — the demo project loads automatically
(2 scenes, rigged character, keyframes). Press **Space** to play.
Export → MP4/GIF/PNG-sequence works when FFmpeg is installed.

Quick sanity check in another terminal:

```bash
curl -s http://localhost:8787/api/health              # {"ok":true,...}
curl -s http://localhost:8787/api/export/ffmpeg-status # shows detected ffmpeg version
```

Stop with Ctrl+C (kills both processes).

---

## 7. Production compile (build)

```bash
npm run build
```

Produces:
- `shared/dist/`      — compiled types/validators/migrations (consumed by backend)
- `backend/dist/`     — compiled Express API (NodeNext modules)
- `frontend/dist/`    — static bundle (`index.html` + assets, ~290 kB JS)

Verify the production artifacts actually run:

```bash
# Backend (production):
node backend/dist/backend/src/server.js
curl -s http://localhost:8787/api/health

# Frontend (serve the built folder):
npx serve frontend/dist -l 5173
# then open http://localhost:5173 and point /api at the running backend
```

For a single-origin production deployment, serve `frontend/dist` from any static
host (nginx/Caddy/Vercel/Netlify) and reverse-proxy `/api/*` to the backend:

```nginx
# nginx example
server {
  listen 80;
  root /var/www/studio/frontend/dist;
  location / { try_files $uri /index.html; }
  location /api/ { proxy_pass http://127.0.0.1:8787; }
}
```

(The Vite dev server already proxies `/api` → :8787, so no extra config is needed
during development.)

---

## 8. Updating later

```bash
git pull origin main
npm install          # pick up dependency changes
npm test             # confirm green
npm run dev
```

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm run dev` fails with EADDRINUSE :5173/:8787 | Another instance is running: `lsof -ti:5173 -i:8787 \| xargs kill` (Windows: `netstat -ano \| findstr :8787` then `taskkill /PID <pid> /F`) |
| Export says FFmpeg not available | Install FFmpeg (§0), restart backend, re-check `/api/export/ffmpeg-status` |
| Providers can't be saved / "STUDIO_SECRET_KEY not set" | You skipped §4 — `.env` must exist next to the repo root with a 64-hex key |
| Backend started manually can't find `.env` | Start it from the repo root (`npm run dev` / `npm -w backend run dev`); the server looks in cwd AND repo root |
| `Cannot find module '@studio/shared'` after pulling | Run `npm install` at the ROOT (workspace linking), not inside a subfolder |
| Importing an old project file fails validation | Use the app version matching the schema; v1–v3 projects auto-migrate on import |
| Tests fail on `toDataURL` noise in jsdom | Harmless console notice; PNG byte-validity is covered by backend tests |

---

## 10. One-shot cheat sheet

```bash
# ---- on the machine that has the code ----
cd simple-2d-animation-studio
git add -A && git commit -m "Initial release" 
git branch -M main
git remote add origin https://github.com/<USER>/simple-2d-animation-studio.git
git push -u origin main

# ---- on any other machine ----
git clone https://github.com/<USER>/simple-2d-animation-studio.git
cd simple-2d-animation-studio
npm install
cp .env.example .env   # then set STUDIO_SECRET_KEY (see §4)
npm test               # 74/74 expected
npm run dev            # http://localhost:5173
npm run build          # production artifacts in */dist
```
