/**
 * Export modal: renders frames deterministically with the shared renderScene() and
 * hands them to the backend FFmpeg pipeline (MP4/GIF), ZIP packer (PNG sequence),
 * or does pure-browser exports (PNG still, project JSON). Progress + cancel + summary.
 */
import { useRef, useState } from 'react';
import type { ExportFormat, Project } from '@studio/shared';
import { api, ApiError } from '../llm/client';
import { useStore, useEditorState } from '../state/storeBridge';
import { renderScene } from '../engine/renderer';
import { serializeProject } from '../storage/db';
import { downloadBlob } from '../util';

const FORMATS: { id: ExportFormat; label: string; needsFfmpeg: boolean; desc: string }[] = [
  { id: 'mp4', label: 'MP4 video (H.264)', needsFfmpeg: true, desc: 'Best quality; requires FFmpeg on the backend.' },
  { id: 'gif', label: 'Animated GIF', needsFfmpeg: true, desc: 'Great for sharing; limited palette, no audio.' },
  { id: 'png-sequence', label: 'PNG sequence (ZIP)', needsFfmpeg: false, desc: 'Every frame as transparent PNG in a ZIP.' },
  { id: 'png-still', label: 'PNG still image', needsFfmpeg: false, desc: 'Current playhead frame of the active scene.' },
  { id: 'project-json', label: 'Editable project (.json)', needsFfmpeg: false, desc: 'Re-openable project file with scenes, keyframes & assets.' },
];

export function ExportModal({ onClose }: { onClose: () => void }): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [fps, setFps] = useState(st.project.fps);
  const [scalePct, setScalePct] = useState(100);
  const [quality, setQuality] = useState(0.8);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [transparent, setTransparent] = useState(false);
  const [scenesAll, setScenesAll] = useState(true);
  const [sceneIds, setSceneIds] = useState<string[]>(st.project.scenes.map((s) => s.id));
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(false);

  const width = Math.round((st.project.width * scalePct) / 100 / 2) * 2; // even dims for H.264
  const height = Math.round((st.project.height * scalePct) / 100 / 2) * 2;
  const selectedScenes = () => (scenesAll ? st.project.scenes : st.project.scenes.filter((s) => sceneIds.includes(s.id)));

  /** Render every frame of the selected scenes into data URLs using the deterministic renderer. */
  async function* frameGenerator(project: Project): AsyncGenerator<string> {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable in this browser.');
    for (const scene of selectedScenes()) {
      const frames = Math.max(1, Math.round(scene.duration * fps));
      for (let f = 0; f < frames; f++) {
        if (cancelRef.current) return;
        // Integer-frame time → identical pixels every run (no wall-clock reads).
        renderScene(ctx, project, scene, f / fps, { transparentBackground: transparent });
        yield canvas.toDataURL('image/png');
        await new Promise((r) => setTimeout(r, 0)); // keep UI responsive during long exports
      }
    }
  }

  const collectAudio = (): { dataUrl: string; startTime: number; gain: number; fadeIn: number; fadeOut: number; trimStart: number; duration: number }[] => {
    if (!includeAudio) return [];
    let offset = 0;
    const out: ReturnType<typeof collectAudio> = [];
    for (const scene of selectedScenes()) {
      for (const clip of scene.audioClips) {
        const asset = st.project.assets.find((a) => a.id === clip.assetId);
        if (!asset?.dataUrl) continue;
        out.push({ dataUrl: asset.dataUrl, startTime: offset + clip.startTime, gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, trimStart: clip.trimStart, duration: clip.duration || scene.duration });
      }
      offset += scene.duration;
    }
    return out;
  };

  const missingAudio = (): number => {
    let n = 0;
    for (const scene of selectedScenes())
      for (const clip of scene.audioClips)
        if (!st.project.assets.some((a) => a.id === clip.assetId && a.dataUrl)) n++;
    return n;
  };

  const start = async (): Promise<void> => {
    setBusy(true); setError(null); setSummary(null); cancelRef.current = false;
    const project = st.project;
    try {
      if (format === 'project-json') {
        const blob = new Blob([serializeProject(project)], { type: 'application/json' });
        downloadBlob(blob, `${safeName(project.name)}.json`);
        setSummary('Project JSON downloaded — reopen any time via File → Open → Import .json.');
        return;
      }
      if (format === 'png-still') {
        const scene = project.scenes.find((s) => s.id === project.activeSceneId);
        if (!scene) throw new Error('No active scene.');
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D unavailable.');
        renderScene(ctx, project, scene, st.time, { transparentBackground: transparent });
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
        if (!blob) throw new Error('PNG encoding failed.');
        downloadBlob(blob, `${safeName(project.name)}-f${Math.round(st.time * fps)}.png`);
        setSummary('Still PNG downloaded.');
        return;
      }

      // Frame-based formats: count total frames first for progress.
      const totalFrames = selectedScenes().reduce((a, s) => a + Math.max(1, Math.round(s.duration * fps)), 0);
      setProgress({ done: 0, total: totalFrames });
      const frames: string[] = [];
      for await (const f of frameGenerator(project)) {
        frames.push(f);
        setProgress({ done: frames.length, total: totalFrames });
      }
      if (cancelRef.current) { setSummary('Export cancelled — nothing was written.'); return; }
      if (frames.length === 0) throw new Error('No frames rendered — check scene durations.');

      if (format === 'png-sequence') {
        const blob = await api.pngZip(frames);
        downloadBlob(blob, `${safeName(project.name)}-seq.zip`);
        setSummary(`Exported ${frames.length} PNG frames (${width}×${height} @ ${fps}fps) into a ZIP.`);
        return;
      }

      // MP4 / GIF via backend FFmpeg
      const status = await api.ffmpegStatus();
      if (!status.ok) throw new Error(`FFmpeg not available on the backend: ${status.error ?? 'install ffmpeg and restart the server'}.\nUse “PNG sequence” or “PNG still” instead.`);
      const { jobId } = await api.createSession({ format: format === 'mp4' ? 'mp4' : 'gif', fps, width, height, quality });
      const CHUNK = 48;
      try {
        for (let i = 0; i < frames.length; i += CHUNK) {
          if (cancelRef.current) { await api.cancelSession(jobId).catch(() => undefined); setSummary('Export cancelled on the server.'); return; }
          await api.sendFrames(jobId, i, frames.slice(i, i + CHUNK));
          setProgress({ done: Math.min(frames.length, i + CHUNK), total: frames.length });
        }
        const missing = missingAudio();
        if (format === 'mp4' && includeAudio && missing > 0) store.status(`Warning: ${missing} audio clip(s) reference missing assets and were skipped.`);
        const blob = await api.finalize(jobId, format === 'mp4' ? collectAudio() : []);
        if (blob.size === 0) throw new Error('Backend returned an empty file.');
        downloadBlob(blob, `${safeName(project.name)}.${format}`);
        setSummary(`Exported ${format.toUpperCase()}: ${frames.length} frames, ${width}×${height}, ${fps}fps, ${(blob.size / 1024 / 1024).toFixed(2)} MB${format === 'mp4' && includeAudio ? ', audio mixed' : ''}.`);
      } catch (e) {
        await api.cancelSession(jobId).catch(() => undefined);
        throw e;
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); setProgress(null); }
  };

  const fmt = FORMATS.find((f) => f.id === format)!;
  const dur = selectedScenes().reduce((a, s) => a + s.duration, 0);

  return (
    <div className="modal-backdrop" role="dialog" aria-label="Export animation">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="row"><h2 style={{ margin: 0 }} className="grow">Export</h2>
          <button className="btn small" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="col" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {FORMATS.map((f) => (
              <button key={f.id} className={`btn small${format === f.id ? ' primary' : ''}`} onClick={() => setFormat(f.id)} title={f.desc}>{f.label}</button>
            ))}
          </div>
          <div className="muted">{fmt.desc}{fmt.needsFfmpeg && ' The studio checks FFmpeg availability before starting.'}</div>
          <div className="row wrap" style={{ gap: 10 }}>
            <label>FPS <select value={fps} aria-label="Export FPS" onChange={(e) => setFps(Number(e.target.value))}>{[12, 24, 30].map((v) => <option key={v}>{v}</option>)}</select></label>
            <label>Scale <select value={scalePct} aria-label="Resolution scale" onChange={(e) => setScalePct(Number(e.target.value))}>{[50, 75, 100].map((v) => <option key={v} value={v}>{v}%</option>)}</select></label>
            <span className="muted">{width}×{height}</span>
            {(format === 'mp4' || format === 'gif') && (
              <label>Quality <input type="range" min={0.2} max={1} step={0.05} value={quality} aria-label="Quality" onChange={(e) => setQuality(Number(e.target.value))} /></label>
            )}
            {format === 'mp4' && <label><input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} /> Include audio mix</label>}
            {(format === 'png-sequence' || format === 'png-still') && <label><input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} /> Transparent background</label>}
          </div>
          <div>
            <label><input type="radio" name="scope" checked={scenesAll} onChange={() => setScenesAll(true)} /> All {st.project.scenes.length} scene(s) ({dur.toFixed(1)}s)</label>{' '}
            <label><input type="radio" name="scope" checked={!scenesAll} onChange={() => setScenesAll(false)} /> Selected:</label>
            {!scenesAll && st.project.scenes.map((s) => (
              <label key={s.id} style={{ marginRight: 8 }}>
                <input type="checkbox" checked={sceneIds.includes(s.id)} aria-label={`Include ${s.name}`}
                  onChange={(e) => setSceneIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))} /> {s.name}
              </label>
            ))}
          </div>
          {includeAudio && format === 'mp4' && missingAudio() > 0 && (
            <div className="chip bad">{missingAudio()} audio clip(s) reference missing assets — they will be skipped. Fix in the Audio tab or uncheck audio.</div>
          )}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void start()}>{busy ? 'Rendering…' : `Export ${fmt.label}`}</button>
            {busy && <button className="btn danger" onClick={() => { cancelRef.current = true; }}>Cancel</button>}
          </div>
          {progress && <progress aria-label="Export progress" value={progress.done} max={progress.total} style={{ width: '100%' }} />}
          {progress && <div className="muted">Rendered {progress.done}/{progress.total} frames (deterministic engine — same pixels as preview).</div>}
          {error && <div className="chip bad" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
          {summary && <div className="chip ok" role="status">{summary}</div>}
        </div>
      </div>
    </div>
  );
}

function safeName(n: string): string {
  return n.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'animation';
}
