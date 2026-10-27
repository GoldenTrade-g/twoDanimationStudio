# Simple 2D Animation Studio — Architecture

## Overview

A local-first, desktop-first web application for beginner 2D animation. The app is a monorepo:

```
/workspace
├── package.json          # npm workspaces root (dev/build/test scripts)
├── shared/               # Versioned project data model + schema validation (TS, consumed by both apps)
│   └── src/
│       ├── types.ts      # Project, Scene, StoryboardCard, Asset, Layer, DrawableObject,
│                         # Keyframe, TimelineTrack, AudioClip, Subtitle, Camera, Transition,
│                         # LLMProviderConfig, ExportSettings …
│       ├── schema.ts     # Runtime validation (hand-rolled validator, no heavy deps)
│       └── migrate.ts    # Schema-version migration pipeline
├── frontend/             # React + TypeScript + Vite editor
│   └── src/
│       ├── state/        # Editor store (useSyncExternalStore), history (undo/redo)
│       ├── engine/       # Deterministic renderer, timeline clock, interpolation, hit-testing
│       ├── tools/        # Drawing tool implementations (pencil, brush, shapes, fill, …)
│       ├── storage/      # IndexedDB projects/assets + autosave
│       ├── llm/          # Browser client for the backend LLM proxy (no secrets in browser)
│       ├── components/   # Toolbar, sidebar, asset panel, stage, properties, storyboard,
│       │                 # timeline, character builder, wizard, settings, export dialog
│       └── demo/         # Built-in demo project generator (2 scenes, character, keyframes)
├── backend/              # Node.js + Express API
│   └── src/
│       ├── llm/          # Provider-neutral adapter: OpenAI-compatible, Anthropic, Gemini,
│       │                 # Ollama, llama-server, custom HTTP. Capability registry, JSON-schema
│       │                 # validation of responses, retries/timeouts/error mapping.
│       ├── export/       # FFmpeg encoder: MP4 (H.264/AAC), GIF, PNG sequence from frame chunks
│       ├── credentials/  # Server-side provider configs; AES-256-GCM encryption at rest
│       ├── upload/       # MIME/size validation, SVG sanitization
│       └── tts/images    # Optional adapters (TTS, image generation) — capability-gated
└── README.md             # Setup / run / test / build instructions
```

## Key design decisions

1. **Own scene-graph renderer on Canvas 2D** (instead of Konva). Reasons:
   - Deterministic frame rendering is a hard requirement for playback *and* export; owning the
     render function (`renderScene(ctx, project, timeMs)`) guarantees the same pixels for the
     same `(project, frame)` pair.
   - The exporter can reuse the exact same renderer without a UI library.
   - High-DPI handled via `devicePixelRatio` scaling; vector objects are retained in the model
     (never flattened), raster strokes become bitmap layers with transparent backgrounds.
2. **Timeline clock decoupled from rAF.** Playback advances from `performance.now()` deltas;
   each tick computes `frame = floor(time * fps)` and renders that deterministic frame, so
   browser jank never drifts animation time. Export uses integer frames directly.
3. **Command-based undo/redo.** Every editing action produces an inverse command; history is a
   stack of `{label, apply, invert}` operating on immutable project snapshots (structural sharing).
4. **Fill bucket** runs on the raster layer's ImageData with a flood fill (scanline, BFS) using a
   color tolerance, bounded to the canvas size (max visited-pixel guard prevents runaway fills).
5. **LLM is additive only.** All manual features work with zero providers configured. Backend
   proxies every provider call; secret keys live server-side only (`.env` or encrypted store) and
   are never returned to the browser or written into exported projects/logs.
6. **Storage:** IndexedDB (`idb`) for projects, assets, thumbnails, autosave journal. Projects
   serialize to versioned JSON (`CURRENT_SCHEMA_VERSION`) with migration tests per version bump.
7. **Export:** Frontend renders frames offscreen in chunks → POSTs PNG chunks to backend →
   backend pipes them into FFmpeg (`-framerate`, `-i frame%06d.png`, optional audio mix via amix
   filtergraph) → returns MP4/GIF. PNG sequence and still PNG also export fully client-side.

## Data flow

```
UI events → Tool/engine → Command → ProjectState (immutable) → History
                                   ↓
                    Deterministic Renderer ← TimelineClock (playback)
                                   ↓
            Stage canvas (editor view)  |  Offscreen canvases (export)
                                   ↓
            IndexedDB (autosave)  +  JSON export/import  +  Backend FFmpeg
```

## Milestones (tracked in README)

- M1: scaffolding, layout, canvas, pencil/brush/eraser/shapes, color, fill, undo/redo, save/load ✔
- M2: layers, asset import, scene management, storyboard cards ✔
- M3: timeline, keyframes, interpolation, playback, onion skinning ✔
- M4: LLM adapter + settings + structured storyboard + approval workflow ✔
- M5: character builder, rigging, templates, motion presets ✔
- M6: audio tracks, subtitles, TTS hooks, MP4/GIF/PNG-seq export ✔
- M7: reliability, tests, accessibility, performance, docs ✔
