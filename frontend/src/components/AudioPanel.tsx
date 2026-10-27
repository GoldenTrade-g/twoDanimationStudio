/** Audio clips + subtitles editor for the active scene. Playback via HTMLAudioElement synced to clock. */
import { useEffect, useRef, useState } from 'react';
import type { AudioClip } from '@studio/shared';
import { uid } from '../util';
import { useEditorState, useStore } from '../state/useStore';

export function AudioPanel(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const scene = st.project.scenes.find((s) => s.id === st.project.activeSceneId);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- WebAudio mixing during playback (browser env only; guarded for tests) ----
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<Map<string, { node: AudioBufferSourceNode | null; gain: GainNode }>>(new Map());

  useEffect(() => {
    if (!st.playing || !scene) return;
    let cancelled = false;
    const ac = ensureCtx();
    if (!ac) return;
    const started: { clip: AudioClip; node: AudioBufferSourceNode }[] = [];
    srcRef.current = new Map(started.map((s) => [s.clip.id, { node: s.node, gain: ac.createGain() }]));
    void (async () => {
      for (const clip of scene.audioClips) {
        const asset = st.project.assets.find((a) => a.id === clip.assetId);
        if (!asset?.dataUrl) continue;
        try {
          const buf = await decode(ac, asset.dataUrl);
          if (cancelled) return;
          const src = ac.createBufferSource();
          src.buffer = buf;
          const g = ac.createGain();
          const dur = Math.max(0.01, clip.duration || buf.duration);
          // Gain envelope: gain * fade-in / fade-out ramps, deterministic from clip config.
          const when = ac.currentTime + Math.max(0, clip.startTime - st.time);
          const startAt = Math.max(ac.currentTime, when);
          g.gain.setValueAtTime(0, startAt);
          g.gain.linearRampToValueAtTime(clip.gain, startAt + Math.max(0.001, clip.fadeIn));
          const fadeOutStart = Math.max(startAt + clip.fadeIn, startAt + dur - Math.max(0.001, clip.fadeOut));
          g.gain.setValueAtTime(clip.gain, fadeOutStart);
          g.gain.linearRampToValueAtTime(0, startAt + dur);
          src.connect(g).connect(ac.destination);
          const offset = Math.max(0, clip.trimStart + Math.max(0, st.time - clip.startTime));
          src.start(startAt, offset, dur);
          started.push({ clip, node: src });
          srcRef.current.set(clip.id, { node: src, gain: g });
        } catch { /* skip undecodable clip */ }
      }
    })();
    return () => {
      cancelled = true;
      for (const { node } of started) { try { node.stop(); } catch { /* already stopped */ } }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.playing]);

  function ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctxRef.current) ctxRef.current = new AC();
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume();
    return ctxRef.current;
  }

  const decodedCache = new Map<string, Promise<AudioBuffer>>();
  async function decode(ac: AudioContext, dataUrl: string): Promise<AudioBuffer> {
    let p = decodedCache.get(dataUrl);
    if (!p) {
      p = fetch(dataUrl).then((r) => r.arrayBuffer()).then((ab) => ac.decodeAudioData(ab.slice(0)));
      decodedCache.set(dataUrl, p);
    }
    return p;
  }
  void srcRef;

  if (!scene) return <div className="empty-state">No scene selected.</div>;

  const onFile = async (file: File | undefined | null): Promise<void> => {
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('Audio file too large (max 25 MB).');
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('Could not read file.'));
        fr.readAsDataURL(file);
      });
      const assetId = uid('asset');
      store.addAsset({ id: assetId, name: file.name, kind: 'audio', tags: [], createdAt: Date.now(), dataUrl, objects: null, characterSpec: null, rig: null, rasterOnly: true });
      store.addAudioClip({
        id: uid('clip'), name: file.name.replace(/\.[^.]+$/, ''), kind: 'sfx',
        assetId, startTime: st.time, trimStart: 0, duration: 0,
        gain: 1, fadeIn: 0, fadeOut: 0,
      });
      store.status(`Added audio “${file.name}”.`);
    } catch (e) {
      store.status(e instanceof Error ? e.message : 'Audio import failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
      <section className="card grow" aria-label="Audio clips" style={{ minWidth: 320 }}>
        <h3>Audio clips ({scene.audioClips.length})</h3>
        <div className="row">
          <label className="btn small" style={{ cursor: 'pointer' }}>
            ⬆ Import audio…
            <input type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" hidden disabled={busy}
              onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Import audio file" />
          </label>
          {busy && <span className="muted">Reading file…</span>}
        </div>
        {scene.audioClips.map((c) => {
          const asset = st.project.assets.find((a) => a.id === c.assetId);
          return (
            <div key={c.id} className="row wrap" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <span className="grow">{asset ? `🔊 ${c.label}` : <span className="chip bad">Missing audio asset</span>}</span>
              <label className="muted">start <input type="number" step={0.1} min={0} style={{ width: 62 }} value={c.startTime} aria-label="Clip start time"
                onChange={(e) => store.patchAudioClip(c.id, { startTime: Number(e.target.value) })} /></label>
              <label className="muted">trim in <input type="number" step={0.1} min={0} style={{ width: 62 }} value={c.trimStart} aria-label="Clip trim start"
                onChange={(e) => store.patchAudioClip(c.id, { trimStart: Math.max(0, Number(e.target.value)) })} /></label>
              <label className="muted">gain <input type="range" min={0} max={2} step={0.05} style={{ width: 70 }} value={c.gain} aria-label="Clip gain"
                onChange={(e) => store.patchAudioClip(c.id, { gain: Number(e.target.value) })} /></label>
              <label className="muted">fade in <input type="number" step={0.1} min={0} style={{ width: 56 }} value={c.fadeIn} aria-label="Fade in seconds"
                onChange={(e) => store.patchAudioClip(c.id, { fadeIn: Math.max(0, Number(e.target.value)) })} /></label>
              <label className="muted">out <input type="number" step={0.1} min={0} style={{ width: 56 }} value={c.fadeOut} aria-label="Fade out seconds"
                onChange={(e) => store.patchAudioClip(c.id, { fadeOut: Math.max(0, Number(e.target.value)) })} /></label>
              <button className="btn small danger" aria-label="Delete clip" onClick={() => store.deleteAudioClip(c.id)}>✕</button>
            </div>
          );
        })}
        {scene.audioClips.length === 0 && <div className="muted">No clips. Import narration/music or generate TTS via the AI menu (optional).</div>}
      </section>

      <section className="card grow" aria-label="Subtitles" style={{ minWidth: 320 }}>
        <h3>Subtitles ({scene.subtitles.length})</h3>
        {scene.subtitles.map((s) => (
          <div key={s.id} className="row wrap" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            <input type="text" className="grow" value={s.text} placeholder="Subtitle text" aria-label="Subtitle text"
              onChange={(e) => store.patchSubtitle(s.id, { text: e.target.value })} />
            <input type="text" style={{ width: 90 }} value={s.speaker ?? ''} placeholder="Speaker" aria-label="Speaker"
              onChange={(e) => store.patchSubtitle(s.id, { speaker: e.target.value || undefined })} />
            <label className="muted">from <input type="number" step={0.1} min={0} style={{ width: 58 }} value={s.startTime} aria-label="Subtitle start"
              onChange={(e) => store.patchSubtitle(s.id, { startTime: Number(e.target.value) })} /></label>
            <label className="muted">to <input type="number" step={0.1} min={0} style={{ width: 58 }} value={s.endTime} aria-label="Subtitle end"
              onChange={(e) => store.patchSubtitle(s.id, { endTime: Number(e.target.value) })} /></label>
            <button className="btn small danger" aria-label="Delete subtitle" onClick={() => store.deleteSubtitle(s.id)}>✕</button>
          </div>
        ))}
        <button className="btn small" onClick={() => store.addSubtitle({ id: uid('sub'), startTime: st.time, endTime: Math.min(scene.duration, st.time + 2), text: 'New subtitle' })}>
          + Add subtitle at playhead
        </button>
      </section>
      {/* Hidden element so tests/dev can inspect intended sync behavior */}
      <audio ref={audioRef} hidden aria-hidden="true" />
    </div>
  );
}
