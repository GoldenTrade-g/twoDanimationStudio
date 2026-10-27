# Simple 2D Animation Studio

A desktop-first, beginner-friendly web application for creating complete 2D animations:
draw → color → rig simple characters → storyboard → keyframe animation → audio → preview → export.

**Local-first and AI-optional.** Every drawing, timeline, playback, storage, and export feature works
with no LLM connection whatsoever. AI (when configured) only assists with planning: scripts,
storyboards, palettes, and animation suggestions — always behind explicit user approval, and always
validated as untrusted data before use.

---

## Repository layout

```
simple-animation-studio/
├── shared/     # Versioned TypeScript project schema (v3), runtime validators, migrations  (npm workspace)
├── backend/    # Node.js + Express + TypeScript API: LLM proxy, encrypted credentials, uploads, FFmpeg export
├── frontend/   # React + TypeScript + Vite editor: canvas engine, tools, timeline, storyboard, IndexedDB storage
├── ARCHITECTURE.md
└── .env.example
```

See **ARCHITECTURE.md** for the module design (deterministic `renderScene(ctx, project, time)` shared by
editor preview and export, command-based undo/redo, drift-free timeline clock, provider-neutral adapter).

### Key modules (frontend)

| Module | Responsibility |
|---|---|
| `engine/renderer.ts` | Deterministic Canvas-2D scene renderer (editor + export share this one function) |
| `engine/interpolation.ts` | Keyframe evaluation: linear, easing, hold/step, color interpolation |
| `engine/playbackClock.ts` | Timeline clock decoupled from `requestAnimationFrame` (no playback/export drift) |
| `engine/fillBucket.ts` | Scanline flood fill with tolerance, bounds checks, memory cap |
| `engine/hitTest.ts` | Object selection / lasso hit-testing |
| `state/store.ts` | EditorStore: immutable project state + command history (undo/redo) |
| `storage/db.ts` | IndexedDB persistence, autosave journal, JSON import/export with migration + validation |
| `llm/client.ts` | Browser client for the backend proxy (never sees API secrets) |
| `components/` | Toolbar, ToolRail, Stage, PropertiesPanel, Timeline, Storyboard, Audio, Providers/Generate/Export modals |

---

## Prerequisites

- **Node.js ≥ 18** and npm ≥ 9 (workspaces).
- **FFmpeg** — required only for MP4/GIF exports on the backend:
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg` or download from https://ffmpeg.org and add to `PATH`.
  - Verify: `ffmpeg -version`. The app exposes this check at `GET /api/export/ffmpeg-status`; PNG
    sequence, still PNG, and project-JSON exports work without FFmpeg.
- A browser with Canvas 2D + IndexedDB (Chrome, Edge, Firefox, Safari 15+). High-DPI supported.

## Install

```bash
npm install          # installs all three workspaces
cp .env.example .env # then edit .env — see Configuration below
```

## Configuration (`.env`, backend only)

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 8787) | Backend API port |
| `STUDIO_SECRET_KEY` | **yes** if you store provider credentials | 64-hex-char AES-256-GCM key used to encrypt provider secrets at rest. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ALLOWED_ORIGINS` | no | CORS allow-list for the frontend origin(s) |
| `MAX_UPLOAD_MB` | no (default 20) | Upload size limit |

Provider API keys are entered through the in-app **Providers** dialog; they are sent once to the
backend over `/api/providers`, encrypted with `STUDIO_SECRET_KEY`, and stored server-side. For local
providers (Ollama, llama-server) no key is needed at all.

## Run (development)

```bash
npm run dev        # starts backend on :8787 and Vite frontend on :5173 together
```

Open http://localhost:5173. The app boots with a built-in **demo project**: two scenes, a rigged
vector character, backgrounds, multiple keyframes, and working playback — press Space to play.
Vite proxies `/api/*` to the backend, so no extra configuration is needed.

## Test

```bash
npm test           # runs shared → backend → frontend suites
# individually:
npm test -w shared     # 16 tests: schema validation, referential integrity, v1→v2→v3 migrations
npm test -w backend    # 16 tests: LLM adapter errors, credential redaction/encryption, upload
                       #           validation & SVG sanitizing, FFmpeg status, PNG-sequence ZIP
npm test -w frontend   # 42 tests: interpolation/easing/hold, fill bucket edge cases, undo/redo,
                       #           playback clock drift, IndexedDB save/reload round trip (fake-indexeddb),
                       #           JSON import + migration, and the full vertical-slice journey test
npx tsc --noEmit -p frontend && npx tsc --noEmit -p backend   # strict type checks
```

The frontend vertical-slice test executes the exact acceptance journey offline:
create project → draw shapes → recolor → add background → add keyframes → deterministic playback
renders → save to IndexedDB → reload intact → produce export frames. Real PNG byte-validity is
asserted in the backend suite (jsdom cannot encode PNGs without the native `canvas` package; this is
a documented test-environment limitation, not an app limitation — browsers encode real PNGs).

## Production build

```bash
npm run build      # shared → backend (tsc) → frontend (tsc --noEmit + vite build)
# serve: node backend/dist/server.js   + host frontend/dist/ with any static server
```

## Using an LLM provider (optional)

1. Top toolbar → **Settings → Providers → Add provider**.
2. Pick a kind, base URL/model, enter a key if required, press **Test connection**.
3. Mark it as default; the **Generate** wizard (idea/script → script → storyboard → review/approve →
   scene plans → editable keyframes) uses it. Every generated result is shown for manual editing and
   requires your approval before touching the project. Nothing is destructive without confirmation.

### Provider capability table

Capabilities are reported per configured provider by `GET /api/providers` (secrets stripped).

| Provider kind | Text | Structured JSON (storyboard/plans) | Connection test | Image generation | Text-to-speech | Secret key needed |
|---|---|---|---|---|---|---|
| OpenAI-compatible (incl. Azure-style, LM Studio, vLLM) | ✅ | ✅ | ✅ | ✅* | ✅* | usually yes |
| Anthropic | ✅ | ✅ | ✅ | ❌ | ❌ | yes |
| Google Gemini | ✅ | ✅ | ✅ | ✅ | ❌ | yes |
| Ollama (local) | ✅ | ✅ | ✅ | ❌ | ❌ | no |
| llama-server (local) | ✅ | ✅ | ✅ | ❌ | ❌ | no |
| Custom HTTP endpoint | ✅ | ✅ | ✅ | ❌ | ❌ | optional |

\* available only when the endpoint/model actually supports those APIs; the UI disables unsupported
features based on the capability registry (`capabilitiesFor()` in `backend/src/credentials/store.ts`).
Text, image, and speech generation are treated as **separate capabilities** — the app never assumes a
text model can generate images or audio.

## Security & privacy notes

- **No secrets in the browser.** API keys live only on the server, encrypted at rest with
  AES-256-GCM (`STUDIO_SECRET_KEY`). The list endpoint strips ciphertext; log output is redacted.
- **Model output is untrusted data.** Responses are parsed leniently, validated against documented
  JSON schemas, clamped (durations, counts, colors), and rejected on malformed input with retries
  for rate limits/timeouts. The app never executes model-generated code, HTML, or scripts.
- **Uploads** are validated by MIME allow-list *and* magic bytes, size-limited, and SVGs are
  sanitized (scripts, event handlers, external references removed) before import.
- **Local-first storage.** Projects and assets persist in browser IndexedDB. Only what you explicitly
  send (prompts to the LLM endpoints; frames/audio to the export endpoints) leaves the browser, and
  only to your own backend/provider. Exported project JSON contains asset references, never secrets.
- Destructive actions (delete scene/project, overwrite imports) require confirmation; autosave keeps
  a recoverable journal.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Export says FFmpeg not found | Install FFmpeg (see Prerequisites) and restart the backend; check `curl localhost:8787/api/export/ffmpeg-status`. Use PNG sequence/GIF-less exports meanwhile. |
| “No provider configured” error in Generate wizard | Expected — the wizard degrades gracefully; all features remain usable manually. Configure a provider in Settings → Providers. |
| 401/429 from provider calls | Wrong key/rate limit. Use Test connection; the backend retries 429/5xx with backoff and surfaces clean errors without logging keys. |
| Credentials fail after server move | They’re encrypted with `STUDIO_SECRET_KEY`; keep the same key or re-enter providers. |
| Project won’t import | Files from newer schema versions are rejected with a clear message; older versions migrate automatically (v1→v3, tested). |
| Blank canvas on huge projects | Zoom to fit (H tool or toolbar); renderer caches assets — report if reproducible. |
| Frontend tests show jsdom “toDataURL not implemented” noise | Known test-env limitation (see Test section); the suite asserts the deterministic-render contract instead and still passes. |

## License note

Dependencies are MIT/Apache-2.0 licensed and compatible with permissive redistribution; FFmpeg itself
is LGPL/GPL depending on build — invoke it as an external binary (as this app does) to stay LGPL-clean.
