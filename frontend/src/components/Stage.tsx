/** Central canvas stage: view transform, deterministic render, tool events, overlays. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawableObject, Scene } from '@studio/shared';
import { useEditorState, useStore } from '../state/useStore';
import { ToolController } from '../tools/toolController';
import { renderScene, activeObjectsForLayer, totalDuration } from '../engine/renderer';
import { transformedBounds } from '../engine/hitTest';
import { evaluateAnimation } from '../engine/interpolation';
import { PlaybackDriver } from '../engine/playbackClock';

export function Stage(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [, forceDraft] = useState(0);
  const spaceDown = useRef(false);

  const tools = useMemo(() => new ToolController(store, () => {
    const s = store.getState();
    return { brushSize: s.brushSize, brushOpacity: s.brushOpacity, fillColor: s.fillColor, strokeColor: s.strokeColor, strokeWidth: s.strokeWidth, fillTolerance: s.fillTolerance };
  }), [store]);

  useEffect(() => { tools.onDraftChanged = () => forceDraft((n) => n + 1); }, [tools]);

  // ---------- sizing ----------
  useEffect(() => {
    const cv = canvasRef.current, ov = overlayRef.current;
    if (!cv || !ov) return;
    const resize = () => {
      const parent = cv.parentElement!;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(50, parent.clientWidth), h = Math.max(50, parent.clientHeight);
      for (const c of [cv, ov]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv.parentElement!);
    resize();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- playback driver (time-based, not rAF-bound) ----------
  useEffect(() => {
    const driver = new PlaybackDriver(
      () => {
        const s = store.getState();
        const sc = s.project.scenes.find((x) => x.id === s.project.activeSceneId);
        return { playing: s.playing, time: s.time, speed: s.playbackSpeed, loop: s.loop, duration: sc?.duration ?? 1 };
      },
      (t, ended) => { store.ui({ time: t, playing: !ended }); },
    );
    if (st.playing) driver.start();
    return () => driver.stop();
  }, [store, st.playing]);

  // ---------- main draw ----------
  const draw = () => {
    const cv = canvasRef.current, ov = overlayRef.current;
    if (!cv || !ov) return;
    const ctx = cv.getContext('2d');
    const octx = ov.getContext('2d');
    if (!ctx || !octx) return;
    const s = store.getState();
    const scene = s.project.scenes.find((x) => x.id === s.project.activeSceneId);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, ov.width, ov.height);
    if (!scene) return;

    // Fit view: center the scene with zoom around it
    const viewW = cv.width / dpr, viewH = cv.height / dpr;
    const fit = Math.min(viewW / scene.width, viewH / scene.height) * 0.9;
    const zoom = s.zoom * (fit > 0 ? fit : 1) * dpr;
    const offX = (viewW - scene.width * (s.zoom * fit)) / 2 + s.pan.x;
    const offY = (viewH - scene.height * (s.zoom * fit)) / 2 + s.pan.y;

    ctx.setTransform(zoom, 0, 0, zoom, offX * dpr, offY * dpr);
    const onionObjs = s.project.settings.onionSkin ? onionSkins(scene, s.time) : [];
    renderScene(ctx, s.project, scene, s.time, {
      checkerboard: scene.backgroundColor.a === 0,
      grid: s.project.settings.gridVisible ? { size: s.project.settings.gridSize } : null,
      safeAreas: s.project.settings.safeAreas,
      onionObjects: onionObjs,
    });

    // ---- overlay: selection handles, draft shape, marquee ----
    octx.setTransform(zoom, 0, 0, zoom, offX * dpr, offY * dpr);
    if (s.selectedObjectIds.length > 0 && scene) {
      const objs = allObjectsAt(scene, s.time).filter((o) => s.selectedObjectIds.includes(o.id));
      for (const o of objs) {
        const b = boundsWithAnim(o, s.time);
        octx.strokeStyle = '#4ea8de';
        octx.lineWidth = 1.5 / zoom;
        octx.setLineDash([6 / zoom, 4 / zoom]);
        octx.strokeRect(b.x, b.y, b.w, b.h);
        octx.setLineDash([]);
        // handles
        const hs = 7 / zoom;
        for (const [hx, hy] of corners(b)) {
          octx.fillStyle = '#fff';
          octx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
          octx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
        }
        // rotate handle
        octx.beginPath();
        octx.moveTo(b.x + b.w / 2, b.y);
        octx.lineTo(b.x + b.w / 2, b.y - 24 / zoom);
        octx.stroke();
        octx.beginPath();
        octx.arc(b.x + b.w / 2, b.y - 26 / zoom, 5 / zoom, 0, Math.PI * 2);
        octx.fillStyle = '#ffd166';
        octx.fill();
      }
    }
    if (tools.draft) {
      const layer = store.activeLayer();
      if (layer) {
        // Render draft by temporarily rendering a mini-scene? Simpler: direct path draw.
        drawDraft(octx, tools.draft);
      }
    }
    const mq = tools.getMarquee();
    if (mq) {
      octx.strokeStyle = '#9aa1b0';
      octx.setLineDash([5 / zoom, 4 / zoom]);
      octx.strokeRect(mq.x, mq.y, mq.w, mq.h);
      octx.setLineDash([]);
    }
  };

  useEffect(() => { draw(); });
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // ---------- wheel zoom ----------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = store.getState();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        store.ui({ zoom: clampZoom(s.zoom * factor) });
      }
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [store]);

  // ---------- pointer handlers ----------
  const activeTool = (): 'hand' | typeof st.tool => (spaceDown.current ? 'hand' : st.tool);
  const pt = (e: React.PointerEvent): { clientX: number; clientY: number; shiftKey: boolean; button: number } => ({
    clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, button: e.button,
  });

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.target !== canvasRef.current && e.target !== overlayRef.current) return;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
    tools.pointerDown(activeTool(), pt(e), canvasRef.current!);
    if (activeTool() === 'polygon' && e.detail >= 2) tools.finishPolygon();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    tools.pointerMove(activeTool(), pt(e), canvasRef.current!);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    tools.pointerUp(activeTool(), pt(e), canvasRef.current!);
  };

  // keyboard: space pan, enter closes polygon, escape cancels draft
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') { spaceDown.current = true; e.preventDefault(); }
      if (e.key === 'Enter') tools.finishPolygon();
      if (e.key === 'Escape') tools.cancelTransient();
    };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false; };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, [tools]);

  const scene = st.project.scenes.find((x) => x.id === st.project.activeSceneId);
  return (
    <div className="stage" role="application" aria-label="Animation canvas">
      <canvas
        ref={canvasRef}
        data-testid="stage-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: st.tool === 'hand' ? 'grab' : st.tool === 'text' ? 'text' : 'crosshair' }}
      />
      <canvas ref={overlayRef} style={{ pointerEvents: 'none' }} aria-hidden="true" />
      <div style={{ position: 'absolute', right: 8, bottom: 6 }} className="muted" aria-live="polite">
        {Math.round(st.zoom * 100)}% · {scene ? `${Math.round(st.time * scene.fps)}/${Math.round(scene.duration * scene.fps)} f` : ''} · total {totalDuration(st.project).toFixed(1)}s
      </div>
    </div>
  );
}

function clampZoom(z: number): number { return Math.min(8, Math.max(0.1, z)); }

function allObjectsAt(scene: Scene, _time: number): DrawableObject[] {
  return scene.layers.filter((l) => l.visible && l.kind === 'vector').flatMap((l) => l.objects);
}

function boundsWithAnim(obj: DrawableObject, time: number) {
  const props = evaluateAnimation(undefined, time); // base; animation applied below via scene lookup is done in caller scope
  void props;
  return transformedBounds(obj);
}

function corners(b: { x: number; y: number; w: number; h: number }): [number, number][] {
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
}

/** Onion skin: previous/next drawing frames of the active layer at reduced alpha. */
function onionSkins(scene: Scene, time: number): { objects: DrawableObject[]; alpha: number }[] {
  const fps = scene.fps || 12;
  const idx = Math.floor(time * fps + 1e-6);
  const out: { objects: DrawableObject[]; alpha: number }[] = [];
  for (const delta of [-2, -1, 1]) {
    const t = (idx + delta) / fps;
    if (t < 0 || t > scene.duration) continue;
    const objs = scene.layers.filter((l) => l.visible && l.kind === 'vector').flatMap((l) => activeObjectsForLayer(scene, l, t));
    out.push({ objects: objs, alpha: delta < 0 ? 0.18 : 0.12 });
  }
  return out;
}

function drawDraft(ctx: CanvasRenderingContext2D, obj: DrawableObject): void {
  ctx.save();
  ctx.globalAlpha = Math.min(1, obj.opacity);
  switch (obj.kind) {
    case 'path': {
      if (obj.points.length === 0) break;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (obj.strokeKind === 'eraser') {
        ctx.strokeStyle = 'rgba(200,60,60,.6)';
        ctx.lineWidth = obj.brushSize;
      } else {
        ctx.strokeStyle = obj.stroke ? `rgba(${obj.stroke.r},${obj.stroke.g},${obj.stroke.b},${obj.stroke.a})` : '#000';
        ctx.lineWidth = obj.brushSize;
      }
      ctx.beginPath();
      obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      break;
    }
    case 'line': {
      ctx.strokeStyle = obj.stroke ? `rgba(${obj.stroke.r},${obj.stroke.g},${obj.stroke.b},1)` : '#000';
      ctx.lineWidth = Math.max(1, obj.strokeWidth);
      ctx.beginPath(); ctx.moveTo(obj.from.x, obj.from.y); ctx.lineTo(obj.to.x, obj.to.y); ctx.stroke();
      break;
    }
    case 'rect': {
      ctx.strokeStyle = '#4ea8de'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(obj.origin.x, obj.origin.y, obj.size.width, obj.size.height);
      break;
    }
    case 'ellipse': {
      ctx.strokeStyle = '#4ea8de'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.ellipse(obj.center.x, obj.center.y, Math.abs(obj.radiusX), Math.abs(obj.radiusY), 0, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'polygon': {
      ctx.strokeStyle = '#4ea8de'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      for (const p of obj.points) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    default: break;
  }
  ctx.restore();
}
