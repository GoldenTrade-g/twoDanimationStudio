/** Top toolbar: file ops, undo/redo, view toggles, AI menu, export. */
import { useRef, useState } from 'react';
import type { Project } from '@studio/shared';
import { useEditorState, useStore } from '../state/useStore';
import { saveProject, listProjects, loadProject, deleteProject, parseProjectJson, serializeProject } from '../storage/db';
import { downloadBlob, uid } from '../util';
import { buildDemoProject } from '../demo/demoProject';
import { ProvidersModal } from './ProvidersModal';
import { GenerateModal } from './GenerateModal';
import { ExportModal } from './ExportModal';

export function Toolbar(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const [modal, setModal] = useState<'providers' | 'generate' | 'export' | 'open' | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const doSave = async (): Promise<void> => {
    try {
      await saveProject(st.project);
      store.status(`Saved “${st.project.name}” to local storage.`);
    } catch (e) {
      store.status(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const renameProject = (): void => {
    const n = window.prompt('Project name', st.project.name);
    if (n) store.run({ label: 'Rename project', apply: (p) => { p.name = n; } });
  };

  const onImportFile = async (file: File | undefined | null): Promise<void> => {
    if (!file) return;
    try {
      const text = await file.text();
      const proj = parseProjectJson(text);
      store.loadProject(proj);
      await saveProject(proj);
      store.status(`Imported “${proj.name}”.`);
    } catch (e) {
      store.status(e instanceof Error ? `Import failed: ${e.message}` : 'Import failed.');
    }
  };

  // global keyboard shortcuts
  useShortcuts(store);

  return (
    <header className="toolbar" role="menubar" aria-label="Main toolbar">
      <strong style={{ marginRight: 4 }}>🎬 Studio</strong>
      <input ref={projectInputRef} type="file" accept=".json,application/json" hidden aria-hidden="true"
        onChange={(e) => void onImportFile(e.target.files?.[0])} />
      <button className="btn small" onClick={() => {
        const n = window.prompt('New project name', 'Untitled');
        if (n === null) return;
        store.loadProject({ ...buildEmpty(n) });
      }}>New</button>
      <button className="btn small" onClick={renameProject} title="Rename current project">{st.project.name}</button>
      <button className="btn small primary" data-testid="save-project" onClick={() => void doSave()} title="Ctrl+S">💾 Save</button>
      <button className="btn small" onClick={() => setModal('open')} data-testid="open-projects">Open…</button>
      <button className="btn small" onClick={() => importRef.current?.click()}>Import JSON</button>
      <input ref={importRef} type="file" accept=".json,application/json" hidden aria-label="Import project JSON"
        onChange={(e) => void onImportFile(e.target.files?.[0])} />
      <button className="btn small" onClick={() => {
        const blob = new Blob([serializeProject(st.project)], { type: 'application/json' });
        downloadBlob(blob, `${st.project.name.replace(/[^\w.-]+/g, '_')}.animation.json`);
      }}>Export JSON</button>
      <button className="btn small" onClick={() => {
        if (!window.confirm('Load the built-in demo project? Current unsaved changes will be replaced.')) return;
        store.loadProject(buildDemoProject());
        store.status('Demo project loaded — press ▶ in the timeline.');
      }}>Demo</button>

      <span className="spacer" />

      <button className="btn small" disabled={!store.canUndo()} onClick={() => store.undo()} title="Ctrl+Z" aria-label="Undo">↶ Undo</button>
      <button className="btn small" disabled={!store.canRedo()} onClick={() => store.redo()} title="Ctrl+Shift+Z" aria-label="Redo">↷ Redo</button>
      <label className="muted"><input type="checkbox" checked={st.project.settings.gridVisible} aria-label="Show grid"
        onChange={(e) => store.run({ label: 'Toggle grid', apply: (p) => { p.settings.gridVisible = e.target.checked; } })} /> Grid</label>
      <label className="muted"><input type="checkbox" checked={st.project.settings.snapping} aria-label="Snap to grid"
        onChange={(e) => store.run({ label: 'Toggle snapping', apply: (p) => { p.settings.snapping = e.target.checked; } })} /> Snap</label>
      <button className="btn small" aria-label="Zoom out" onClick={() => store.ui({ zoom: Math.max(0.1, st.zoom / 1.2) })}>−</button>
      <button className="btn small" aria-label="Fit view" onClick={() => store.ui({ zoom: 1, pan: { x: 0, y: 0 } })}>Fit</button>
      <button className="btn small" aria-label="Zoom in" onClick={() => store.ui({ zoom: Math.min(8, st.zoom * 1.2) })}>＋</button>
      <button className="btn small" onClick={() => {
        const sc = store.activeScene();
        if (!sc) return;
        const w = Number(window.prompt('Canvas width', String(sc.width)));
        const h = Number(window.prompt('Canvas height', String(sc.height)));
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
          store.patchScene(sc.id, { width: Math.round(w), height: Math.round(h) }, 'Resize canvas');
          store.run({ label: 'Resize project', apply: (p) => { p.width = Math.round(w); p.height = Math.round(h); } });
        }
      }}>Resize…</button>
      <button className="btn small" aria-label="Toggle theme" onClick={() => {
        const next = st.project.settings.theme === 'dark' ? 'light' : 'dark';
        store.run({ label: 'Theme', apply: (p) => { p.settings.theme = next; } });
      }}>{st.project.settings.theme === 'dark' ? '☀' : '🌙'}</button>

      <button className="btn small" onClick={() => setModal('providers')} data-testid="open-providers">⚙ AI Providers</button>
      <button className="btn small" onClick={() => setModal('generate')} data-testid="open-generate">✨ Generate</button>
      <button className="btn small primary" onClick={() => setModal('export')} data-testid="open-export">⤓ Export</button>

      {modal === 'providers' && <ProvidersModal onClose={() => setModal(null)} />}
      {modal === 'generate' && <GenerateModal onClose={() => setModal(null)} />}
      {modal === 'export' && <ExportModal onClose={() => setModal(null)} />}
      {modal === 'open' && <OpenProjectsModal onClose={() => setModal(null)} />}
    </header>
  );
}

function buildEmpty(name: string): Project {
  // lazy import avoided; construct minimal valid project via shared defaults
  const scene = {
    id: uid('scene'), name: 'Scene 1', description: '', duration: 4, fps: 24, width: 1280, height: 720,
    backgroundColor: { r: 245, g: 245, b: 250, a: 1 },
    layers: [
      { id: uid('layer'), name: 'Background', kind: 'vector' as const, visible: true, locked: false, opacity: 1, parallaxDepth: 0.2, objects: [], rasterAssetId: null },
      { id: uid('layer'), name: 'Characters', kind: 'vector' as const, visible: true, locked: false, opacity: 1, parallaxDepth: 1, objects: [], rasterAssetId: null },
    ],
    animations: [], drawingFrames: [], audioClips: [], subtitles: [],
    camera: { x: 0, y: 0, zoom: 1, keyframes: [] },
    transitionIn: { type: 'cut' as const, duration: 0.5 }, category: 'mixed' as const,
  };
  return {
    schemaVersion: 3, id: uid('proj'), name, createdAt: Date.now(), updatedAt: Date.now(),
    fps: 24, width: 1280, height: 720, scenes: [scene], activeSceneId: scene.id,
    storyboard: [], assets: [],
    settings: { aspectRatio: '16:9', safeAreas: { titleSafe: 0.05, actionSafe: 0.025 }, gridVisible: false, gridSize: 32, snapping: false, onionSkin: false, theme: 'dark' },
  };
}

function OpenProjectsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const store = useStore();
  const [items, setItems] = useState<Awaited<ReturnType<typeof listProjects>> | null>(null);
  useState(() => { void listProjects().then(setItems).catch(() => setItems([])); return 0; });
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Open project" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: 0 }}>Local projects</h2>
        {items === null && <div className="muted">Loading…</div>}
        {items?.length === 0 && <div className="empty-state">No saved projects yet. Use “Save” in the toolbar.</div>}
        {items?.map((p) => (
          <div key={p.id} className="row" style={{ borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
            <span className="grow"><strong>{p.name}</strong><br /><span className="muted">{new Date(p.updatedAt).toLocaleString()}</span></span>
            <button className="btn small primary" onClick={async () => {
              const proj = await loadProject(p.id);
              if (proj) { store.loadProject(proj); store.status(`Opened “${proj.name}”.`); onClose(); }
              else store.status('Project record is missing — it may have been deleted.');
            }}>Open</button>
            <button className="btn small danger" onClick={async () => {
              if (!window.confirm(`Delete project “${p.name}”? This cannot be undone.`)) return;
              await deleteProject(p.id);
              setItems(await listProjects());
            }}>Delete</button>
          </div>
        ))}
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function useShortcuts(store: ReturnType<typeof useStore>): void {
  const lastTimeKey = useRef(0);
  useState(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.ctrlKey || e.metaKey;
      const s = store.getState();
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); store.duplicateSelected(); }
      else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); store.groupSelected(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); store.ungroupSelected(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { store.deleteSelected(); }
      else if (e.key === 'k' || e.key === ' ') { /* space handled by Stage pan; K toggles play */ 
        if (e.key === 'k') store.ui({ playing: !s.playing });
      }
      else if (e.key === 'ArrowLeft') { const sc = store.activeScene(); if (sc) store.ui({ time: Math.max(0, s.time - 1 / sc.fps) }); }
      else if (e.key === 'ArrowRight') { const sc = store.activeScene(); if (sc) store.ui({ time: Math.min(sc.duration, s.time + 1 / sc.fps) }); }
      else if (e.key === 'Home') { store.ui({ time: 0 }); }
      else if (e.key === 'End') { const sc = store.activeScene(); if (sc) store.ui({ time: sc.duration }); }
      else if (e.key.toLowerCase() === 't') {
        // add keyframe for all selected objects at playhead for x,y props
        const sc = store.activeScene();
        if (sc && s.selectedObjectIds.length > 0) {
          const now = performance.now();
          if (now - lastTimeKey.current < 300) return; // accidental double-tap guard
          lastTimeKey.current = now;
          for (const id of s.selectedObjectIds) {
            const obj = sc.layers.flatMap((l) => l.objects).find((o) => o.id === id);
            if (!obj) continue;
            store.setKeyframe(id, 'x', obj.transform.x);
            store.setKeyframe(id, 'y', obj.transform.y);
          }
          store.status(`Keyframed position at ${s.time.toFixed(2)}s (${s.selectedObjectIds.length} object(s)).`);
        }
      } else {
        const t = TOOLS_BY_SHORTCUT[e.key.toUpperCase()];
        if (t && !mod) store.ui({ tool: t });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

import { TOOLS } from '../state/store';
const TOOLS_BY_SHORTCUT: Record<string, (typeof TOOLS)[number]['id']> = Object.fromEntries(TOOLS.map((t) => [t.shortcut.toUpperCase(), t.id]));
