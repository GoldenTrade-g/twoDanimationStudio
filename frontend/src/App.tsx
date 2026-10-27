/**
 * App shell: composes Toolbar / ToolRail / Stage / PropertiesPanel / BottomDock,
 * wires keyboard shortcuts, autosave (IndexedDB), theme switching, and loads the
 * built-in demo project on first run so playback works immediately.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { StoreProvider, useEditorState } from './state/useStore';
import { EditorStore, TOOLS, type ToolId } from './state/store';
import { Toolbar } from './components/Toolbar';
import { ToolRail } from './components/ToolRail';
import { Stage } from './components/Stage';
import { PropertiesPanel } from './components/PropertiesPanel';
import { BottomDock } from './components/BottomDock';
import { buildDemoProject } from './demo/demoProject';
import { loadAutosave, saveProject, autosave } from './storage/db';
import { styles } from './styles';

const SHORTCUT_TO_TOOL: Record<string, ToolId> = Object.fromEntries(
  TOOLS.map((t) => [t.shortcut.toLowerCase(), t.id]),
) as Record<string, ToolId>;

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function StudioApp(): JSX.Element {
  const store = useMemo(() => new EditorStore(buildDemoProject()), []);
  const st = useEditorState();
  const [booted, setBooted] = useState(false);
  const spaceDown = useRef(false);

  // ---- Boot: offer autosave recovery over the demo project ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await loadAutosave();
        if (!cancelled && saved) {
          const use = window.confirm('An autosaved session was found. Reopen it? (Cancel keeps the demo project.)');
          if (use) store.loadProject(saved);
        }
      } catch {
        /* autosave unavailable — keep demo */
      }
      if (!cancelled) setBooted(true);
    })();
    return () => { cancelled = true; };
  }, [store]);

  // ---- Autosave (debounced 2s after mutations) ----
  useEffect(() => {
    if (!booted || st.dirtySinceSave === 0) return;
    const h = window.setTimeout(() => { void autosave(store.getState().project).catch(() => undefined); }, 2000);
    return () => window.clearTimeout(h);
  }, [st.dirtySinceSave, booted, store]);

  // ---- Theme ----
  useEffect(() => {
    document.documentElement.dataset.theme = st.project.settings.theme;
  }, [st.project.settings.theme]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject(store.getState().project)
          .then(() => store.status('Saved to local library'))
          .catch((err: unknown) => store.status(`Save failed: ${String(err)}`));
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); store.duplicateSelected(); return; }
      if (mod) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!spaceDown.current) {
          spaceDown.current = true;
          const s = store.getState();
          store.ui({ playing: !s.playing });
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); store.deleteSelected(); return; }
      if (e.key === 'Escape') { store.ui({ selectedObjectIds: [] }); return; }
      if (e.key === 'Home') { store.ui({ time: 0 }); return; }
      if (e.key === 'ArrowLeft') { store.ui({ time: Math.max(0, store.getState().time - 1 / (store.activeScene()?.fps ?? 24)) }); return; }
      if (e.key === 'ArrowRight') {
        const sc = store.activeScene();
        if (sc) store.ui({ time: Math.min(sc.duration, store.getState().time + 1 / sc.fps) });
        return;
      }
      const tool = SHORTCUT_TO_TOOL[e.key.toLowerCase()];
      if (tool) store.ui({ tool });
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [store]);

  return (
    <StoreProvider store={store}>
      <style>{styles}</style>
      <div className="app" data-testid="studio-app">
        <Toolbar />
        <div className="main">
          <ToolRail />
          <Stage />
          <PropertiesPanel />
        </div>
        <BottomDock />
        <footer role="status" aria-live="polite" style={{ padding: '2px 10px', background: 'var(--panel)', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)', minHeight: 20 }}>
          {st.statusMessage ?? 'Ready — Space play/pause · V/A/P/B/E/R/O/G/T/F/I/H tools · Ctrl+Z/Y undo/redo · Ctrl+S save · Ctrl+D duplicate'}
        </footer>
      </div>
    </StoreProvider>
  );
}

export default StudioApp;
