/** Frame ruler + playhead + object keyframe tracks + transport controls. */
import { useRef } from 'react';
import { useEditorState, useStore } from '../state/useStore';
import { roundTime } from '../state/store';

const PX_PER_FRAME = 18;

export function Timeline(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const scene = st.project.scenes.find((s) => s.id === st.project.activeSceneId);
  const rulerRef = useRef<HTMLDivElement>(null);
  if (!scene) return <div className="empty-state">No scene — create one in the Scenes tab.</div>;

  const fps = scene.fps;
  const totalFrames = Math.max(1, Math.round(scene.duration * fps));
  const width = totalFrames * PX_PER_FRAME;
  const timeToX = (t: number) => (t * fps) * PX_PER_FRAME;
  const xToTime = (clientX: number) => {
    const el = rulerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const scroll = (el.closest('.timeline-scroll') as HTMLElement)?.scrollLeft ?? 0;
    return roundTime(((clientX - rect.left + scroll) / PX_PER_FRAME) / fps, fps);
  };

  const scrub = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    store.ui({ playing: false, time: Math.min(scene.duration, Math.max(0, xToTime(e.clientX))) });
  };
  const scrubMove = (e: React.PointerEvent) => {
    if (e.buttons & 1) store.ui({ time: Math.min(scene.duration, Math.max(0, xToTime(e.clientX))) });
  };

  // Track rows: one per selected-object animation + camera; plus all animated objects compactly.
  const animatedObjs = scene.animations.map((a) => {
    const obj = scene.layers.flatMap((l) => l.objects).find((o) => o.id === a.objectId);
    return { anim: a, name: obj?.name ?? 'object', id: a.objectId };
  });

  return (
    <div>
      {/* Transport */}
      <div className="row" style={{ paddingBottom: 6 }} role="group" aria-label="Playback controls">
        <button className="btn small" aria-label="Restart" title="Restart (Home)" onClick={() => store.ui({ time: 0 })}>⏮</button>
        <button className="btn small" aria-label="Step back" title="Previous frame (←)" onClick={() => store.ui({ time: Math.max(0, roundTime(st.time - 1 / fps, fps)) })}>◀︎f</button>
        <button className="btn primary" aria-label={st.playing ? 'Pause' : 'Play'} title="Play/Pause (Space is pan; use K or this button)"
          onClick={() => store.ui({ playing: !st.playing })}>{st.playing ? '⏸' : '▶'}</button>
        <button className="btn small" aria-label="Stop" onClick={() => store.ui({ playing: false, time: 0 })}>⏹</button>
        <button className="btn small" aria-label="Step forward" title="Next frame (→)" onClick={() => store.ui({ time: Math.min(scene.duration, roundTime(st.time + 1 / fps, fps)) })}>f▶︎</button>
        <label className="muted">Speed
          <select aria-label="Playback speed" value={st.playbackSpeed} onChange={(e) => store.ui({ playbackSpeed: Number(e.target.value) })}>
            {[0.25, 0.5, 1, 2, 4].map((v) => <option key={v} value={v}>{v}×</option>)}
          </select></label>
        <label className="muted"><input type="checkbox" checked={st.loop} onChange={(e) => store.ui({ loop: e.target.checked })} aria-label="Loop playback" /> Loop</label>
        <label className="muted"><input type="checkbox" checked={st.project.settings.onionSkin} onChange={(e) => store.run({ label: 'Toggle onion skin', apply: (p) => { p.settings.onionSkin = e.target.checked; } })} aria-label="Onion skin" /> Onion skin</label>
        <span className="chip">{Math.round(st.time * fps)} / {totalFrames} f · {st.time.toFixed(2)}s</span>
        <label className="muted">FPS
          <input type="number" min={1} max={120} style={{ width: 56 }} value={fps} aria-label="Scene FPS"
            onChange={(e) => store.patchScene(scene.id, { fps: Math.min(120, Math.max(1, Number(e.target.value))) }, 'Set FPS')} /></label>
        <label className="muted">Duration
          <input type="number" min={0.5} step={0.5} style={{ width: 64 }} value={scene.duration} aria-label="Scene duration seconds"
            onChange={(e) => store.patchScene(scene.id, { duration: Math.min(600, Math.max(0.5, Number(e.target.value))) }, 'Set duration')} /></label>
      </div>

      <div className="timeline-scroll">
        <div style={{ width, position: 'relative' }}>
          {/* Ruler */}
          <div ref={rulerRef} className="ruler" data-testid="timeline-ruler" aria-label="Frame ruler — drag to scrub"
            onPointerDown={scrub} onPointerMove={scrubMove}>
            {Array.from({ length: totalFrames + 1 }, (_, f) => (
              <div key={f} style={{ position: 'absolute', left: f * PX_PER_FRAME, top: 0, bottom: 0, width: 1, background: f % 10 === 0 ? 'var(--muted)' : 'var(--border)' }}>
                {f % 10 === 0 && <span style={{ position: 'absolute', left: 3, fontSize: 10, color: 'var(--muted)' }}>{f}</span>}
              </div>
            ))}
          </div>
          {/* Object tracks */}
          {animatedObjs.length === 0 && <div className="muted" style={{ padding: 8 }}>No keyframes yet. Select an object and press K to add one at the playhead.</div>}
          {animatedObjs.map(({ anim, name, id }) => (
            <div key={id} className="track-row" aria-label={`Track ${name}`}>
              <span style={{ position: 'absolute', left: 4, top: 5, fontSize: 11, color: 'var(--muted)', zIndex: 2, pointerEvents: 'none' }}>{name}</span>
              {Object.entries(anim.tracks).flatMap(([prop, kfs]) =>
                kfs.map((kf) => (
                  <button key={kf.id} className={`kf${st.selectedObjectIds.includes(id) ? ' sel' : ''}`}
                    style={{ left: timeToX(kf.time) }}
                    title={`${prop} @ ${kf.time.toFixed(2)}s (${kf.interpolation})`}
                    aria-label={`${prop} keyframe at ${kf.time.toFixed(2)} seconds`}
                    onClick={() => { store.ui({ selectedObjectIds: [id], time: kf.time, playing: false }); }}
                    onContextMenu={(e) => { e.preventDefault(); store.deleteKeyframe(id, prop, kf.id); }}
                  />
                )),
              )}
            </div>
          ))}
          {/* Playhead */}
          <div className="playhead" data-testid="playhead" style={{ left: timeToX(st.time) }} aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
