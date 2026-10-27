/** Storyboard + scenes management: cards, thumbnails, edit, approve, instantiate. */
import { useEffect, useRef, useState } from 'react';
import type { StoryboardCard, Scene } from '@studio/shared';
import { uid } from '../util';
import { useEditorState, useStore } from '../state/useStore';
import { renderScene } from '../engine/renderer';

export function StoryboardPanel(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const [view, setView] = useState<'cards' | 'scenes'>('cards');

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={`btn small${view === 'cards' ? ' primary' : ''}`} onClick={() => setView('cards')}>Storyboard cards</button>
        <button className={`btn small${view === 'scenes' ? ' primary' : ''}`} onClick={() => setView('scenes')}>Scenes</button>
        <span className="spacer grow" />
        <span className="muted">Total animation: {st.project.scenes.reduce((a, s) => a + s.duration, 0).toFixed(1)}s across {st.project.scenes.length} scene(s)</span>
      </div>
      {view === 'cards' ? <CardsView /> : <ScenesView />}
    </div>
  );
}

function CardsView(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const cards = [...st.project.storyboard].sort((a, b) => a.sceneNumber - b.sceneNumber);

  const patch = (id: string, p: Partial<StoryboardCard>) =>
    store.patchStoryboard(st.project.storyboard.map((c) => (c.id === id ? { ...c, ...p } : c)));

  if (cards.length === 0) {
    return (
      <div className="empty-state">
        No storyboard cards yet.<br />
        Write them manually with “+ Add card”, or generate them with an LLM provider in the AI menu (optional — everything works without AI).
      </div>
    );
  }
  return (
    <div className="story-grid">
      {cards.map((c, i) => {
        const linked = c.linkedSceneId ? st.project.scenes.find((s) => s.id === c.linkedSceneId) : null;
        return (
          <div key={c.id} className="story-card" data-testid={`story-card-${c.sceneNumber}`}>
            <div className="thumb">{linked ? <SceneThumb scene={linked} /> : `#${c.sceneNumber}`}</div>
            <input type="text" aria-label="Card title" value={c.title} onChange={(e) => patch(c.id, { title: e.target.value })} />
            <textarea aria-label="Card description" rows={2} value={c.description} onChange={(e) => patch(c.id, { description: e.target.value })} />
            <div className="row wrap muted">
              <label>Duration <input type="number" min={0.5} step={0.5} style={{ width: 60 }} value={c.duration}
                aria-label="Card duration" onChange={(e) => patch(c.id, { duration: Number(e.target.value) })} /> s</label>
              <label>Transition
                <select value={c.transition} aria-label="Transition into this scene" onChange={(e) => patch(c.id, { transition: e.target.value as StoryboardCard['transition'] })}>
                  {['cut', 'fade', 'wipeLeft', 'wipeRight', 'slideLeft'].map((t) => <option key={t}>{t}</option>)}
                </select></label>
            </div>
            <label className="muted">Characters (comma separated)
              <input type="text" className="grow" style={{ width: '100%' }} value={c.characters.join(', ')} aria-label="Characters"
                onChange={(e) => patch(c.id, { characters: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
            {c.dialogue && <div className="muted">💬 {c.dialogue}</div>}
            {c.movement && <div className="muted">🎥 {c.framing}: {c.movement}</div>}
            {!c.approved && <div className="chip">Needs approval</div>}
            {linked && <ChecklistChip scene={linked} />}
            <div className="row wrap">
              <button className="btn small" onClick={() => patch(c.id, { approved: !c.approved })}>{c.approved ? 'Unapprove' : '✔ Approve'}</button>
              {linked ? (
                <button className="btn small primary" onClick={() => store.selectScene(linked.id)}>Open scene</button>
              ) : (
                <button className="btn small" title="Creates a new editable scene from this card"
                  onClick={() => { const id = store.instantiateStoryboardCard(c.id); if (id) store.selectScene(id); }}>
                  Create scene →
                </button>
              )}
              <button className="btn small" disabled={i === 0} aria-label="Move card earlier"
                onClick={() => reorder(cards, c.id, -1)}>←</button>
              <button className="btn small" disabled={i === cards.length - 1} aria-label="Move card later"
                onClick={() => reorder(cards, c.id, 1)}>→</button>
              <button className="btn small danger" aria-label="Delete card"
                onClick={() => { if (window.confirm(`Delete card “${c.title}”? Linked scene is kept.`)) store.patchStoryboard(st.project.storyboard.filter((x) => x.id !== c.id)); }}>✕</button>
            </div>
          </div>
        );
      })}
      <div className="story-card" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <button className="btn" onClick={() => {
          const n = (st.project.storyboard.at(-1)?.sceneNumber ?? 0) + 1;
          store.patchStoryboard([...st.project.storyboard, {
            id: uid('card'), sceneNumber: n, location: '', characters: [], movement: '', dialogue: '',
            soundCues: '', transition: 'cut', duration: 4, framing: 'medium',
            title: `Scene ${n}`, description: '', approved: false, linkedSceneId: null, thumbnailDataUrl: null,
          }]);
        }}>+ Add card</button>
      </div>
    </div>
  );

  function reorder(list: StoryboardCard[], id: string, delta: number): void {
    const arr = list.slice();
    const i = arr.findIndex((c) => c.id === id);
    const j = Math.min(arr.length - 1, Math.max(0, i + delta));
    const [it] = arr.splice(i, 1);
    arr.splice(j, 0, it);
    const numbered = arr.map((c, k) => ({ ...c, sceneNumber: k + 1 }));
    store.patchStoryboard([...st.project.storyboard.filter((c) => !numbered.some((n) => n.id === c.id)), ...numbered], 'Reorder storyboard');
  }
}

function ChecklistChip({ scene }: { scene: Scene }): JSX.Element | null {
  const hasArtwork = scene.layers.some((l) => l.objects.length > 0 || l.rasterAssetId);
  const hasAnim = scene.animations.length > 0 || scene.drawingFrames.length > 0;
  const missing: string[] = [];
  if (!hasArtwork) missing.push('artwork');
  if (!hasAnim) missing.push('animation');
  if (scene.audioClips.length === 0) missing.push('audio');
  if (missing.length === 0) return null;
  return <div className="chip bad">Missing: {missing.join(', ')}</div>;
}

function ScenesView(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  return (
    <div className="story-grid">
      {st.project.scenes.map((s, i) => (
        <div key={s.id} className={`story-card${s.id === st.project.activeSceneId ? ' selected' : ''}`}
          style={s.id === st.project.activeSceneId ? { borderColor: 'var(--accent)' } : undefined}>
          <div className="thumb"><SceneThumb scene={s} /></div>
          <input type="text" value={s.name} aria-label="Scene name"
            onChange={(e) => store.patchScene(s.id, { name: e.target.value }, 'Rename scene')} />
          <textarea rows={2} value={s.description} placeholder="Scene description…" aria-label="Scene description"
            onChange={(e) => store.patchScene(s.id, { description: e.target.value }, 'Edit scene description')} />
          <div className="row wrap muted">
            <label>Dur <input type="number" min={0.5} step={0.5} style={{ width: 58 }} value={s.duration} aria-label="Duration"
              onChange={(e) => store.patchScene(s.id, { duration: Number(e.target.value) }, 'Set duration')} />s</label>
            <label>FPS <input type="number" min={1} max={120} style={{ width: 50 }} value={s.fps} aria-label="FPS"
              onChange={(e) => store.patchScene(s.id, { fps: Number(e.target.value) }, 'Set FPS')} /></label>
            <label>Trans
              <select value={s.transitionIn.type} aria-label="Transition in"
                onChange={(e) => store.patchScene(s.id, { transitionIn: { type: e.target.value as Scene['transitionIn']['type'], duration: 0.5 } }, 'Set transition')}>
                {['cut', 'fade', 'wipeLeft', 'wipeRight', 'slideLeft'].map((t) => <option key={t}>{t}</option>)}
              </select></label>
          </div>
          {countObjects(s) === 0 && <div className="chip bad">Empty scene — no artwork</div>}
          <div className="row wrap">
            <button className="btn small primary" onClick={() => store.selectScene(s.id)}>Open in editor</button>
            <button className="btn small" disabled={i === 0} aria-label="Move scene earlier" onClick={() => store.moveScene(s.id, -1)}>↑</button>
            <button className="btn small" disabled={i === st.project.scenes.length - 1} aria-label="Move scene later" onClick={() => store.moveScene(s.id, 1)}>↓</button>
            <button className="btn small" onClick={() => store.duplicateScene(s.id)}>Duplicate</button>
            <button className="btn small danger" disabled={st.project.scenes.length <= 1}
              onClick={() => { if (window.confirm(`Delete scene “${s.name}” and all its artwork?`)) store.deleteScene(s.id); }}>Delete</button>
          </div>
        </div>
      ))}
      <div className="story-card" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <button className="btn" onClick={() => store.addScene()}>+ New scene</button>
      </div>
    </div>
  );
}

function countObjects(s: Scene): number {
  return s.layers.reduce((a, l) => a + l.objects.length, 0) + s.drawingFrames.reduce((a, d) => a + d.objects.length, 0);
}

/** Live mini-render of a scene for thumbnails. */
export function SceneThumb({ scene }: { scene: Scene }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useEditorState();
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    try { renderScene(ctx, st.project, scene, Math.min(0.5, scene.duration / 2), {}); } catch { /* assets may still be loading */ }
  }, [st.project, scene]);
  return <canvas ref={ref} width={scene.width} height={scene.height} aria-label={`Thumbnail of ${scene.name}`} role="img" />;
}
