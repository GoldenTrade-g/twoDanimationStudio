/**
 * Deterministic Canvas-2D renderer. The SAME function is used for:
 *  - editor stage display (with view transform applied by caller)
 *  - playback preview
 *  - export frame rendering (offscreen canvas, integer frames)
 * Given (ctx, project, sceneId, timeSeconds) the pixels are reproducible.
 */
import type { Project, Scene, Layer, DrawableObject, RGBA, Transform, Vec2 } from '@studio/shared';
import { evaluateAnimation, type EffectiveProps } from './interpolation';

export interface RenderOptions {
  /** Checkerboard behind transparent background (editor only). */
  checkerboard?: boolean;
  /** Onion skin layers rendered underneath with alpha. */
  onionObjects?: { objects: DrawableObject[]; alpha: number }[];
  /** Grid overlay (editor only). */
  grid?: { size: number } | null;
  /** Safe-area guides (editor only). */
  safeAreas?: { titleSafe: number; actionSafe: number } | null;
  /** Override time for camera etc. (defaults to `time`). */
  selectionOutline?: { rects: Bounds[] };
}

export interface Bounds { x: number; y: number; w: number; h: number; }

const imageCache = new Map<string, HTMLImageElement>();

export function getCachedImage(src: string): HTMLImageElement | null {
  let img = imageCache.get(src);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    imageCache.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

export function clearImageCache(): void { imageCache.clear(); }

function rgba(c: RGBA | null): string {
  if (!c) return 'transparent';
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

/** Find the drawing-frame object set active at `time` for a layer (frame-by-frame animation). */
export function activeObjectsForLayer(scene: Scene, layer: Layer, time: number): DrawableObject[] {
  const fps = scene.fps || 12;
  const frameIdx = Math.floor(time * fps + 1e-6);
  const dfs = scene.drawingFrames.filter((d) => d.layerId === layer.id);
  if (dfs.length > 0) {
    // A drawing frame covers [index, index+exposure). Later frames win on overlap.
    let best: typeof dfs[number] | null = null;
    for (const d of dfs) {
      if (frameIdx >= d.index && frameIdx < d.index + Math.max(1, d.exposure)) {
        if (!best || d.index >= best.index) best = d;
      }
    }
    if (best) return best.objects;
    // No drawing covers this frame -> fall through to base layer objects (common: single key pose)
  }
  return layer.objects;
}

function effectiveTransform(obj: DrawableObject, props: EffectiveProps): Transform {
  return {
    x: props.x ?? obj.transform.x,
    y: props.y ?? obj.transform.y,
    scaleX: props.scaleX ?? obj.transform.scaleX,
    scaleY: props.scaleY ?? obj.transform.scaleY,
    rotation: props.rotation ?? obj.transform.rotation,
  };
}

/** Local-space geometry bounds (before transform). */
export function localBounds(obj: DrawableObject): Bounds {
  switch (obj.kind) {
    case 'path': {
      if (obj.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of obj.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
      const pad = (obj.strokeKind === 'eraser' ? 0 : obj.brushSize / 2) + (obj.strokeWidth ? obj.strokeWidth / 2 : 0);
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    case 'line': {
      const minX = Math.min(obj.from.x, obj.to.x), minY = Math.min(obj.from.y, obj.to.y);
      return { x: minX, y: minY, w: Math.abs(obj.to.x - obj.from.x), h: Math.abs(obj.to.y - obj.from.y) };
    }
    case 'rect': return { x: obj.origin.x, y: obj.origin.y, w: obj.size.width, h: obj.size.height };
    case 'ellipse': return { x: obj.center.x - obj.radiusX, y: obj.center.y - obj.radiusY, w: obj.radiusX * 2, h: obj.radiusY * 2 };
    case 'polygon': {
      if (obj.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of obj.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'text': {
      const w = obj.text.length * obj.fontSize * 0.6;
      return { x: 0, y: -obj.fontSize, w, h: obj.fontSize * 1.25 };
    }
    case 'image': return { x: 0, y: 0, w: obj.size.width, h: obj.size.height };
  }
}

/** Axis-aligned world bounds including transforms along the parent chain. */
export function worldBounds(project: Project, scene: Scene, obj: DrawableObject, time: number): Bounds {
  const chain = parentChain(scene, obj.id);
  const b = localBounds(obj);
  // Compose transforms root->leaf around each node's pivot; approximate AABB via corner mapping.
  const corners: Vec2[] = [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ];
  let pts = corners;
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    const props = animFor(project, scene, node.id, time);
    const t = effectiveTransform(node, props);
    const piv = node.pivot ?? { x: (b.x + b.w / 2), y: (b.y + b.h / 2) };
    // Only apply to leaf with its own bounds; parents use their own stored transform origin semantics: translate/rotate/scale about pivot in scene coords.
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    pts = pts.map((p) => {
      const sx = i === chain.length - 1 ? p.x : p.x; // points already in child's local space mapped up
      const sy = p.y;
      const dx = (sx - piv.x) * t.scaleX, dy = (sy - piv.y) * t.scaleY;
      return { x: t.x + piv.x + dx * cos - dy * sin, y: t.y + piv.y + dx * sin + dy * cos };
    });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function parentChain(scene: Scene, objectId: string): DrawableObject[] {
  const all = collectAllObjects(scene);
  const byId = new Map(all.map((o) => [o.id, o]));
  const chain: DrawableObject[] = [];
  let cur = byId.get(objectId);
  let guard = 0;
  while (cur && guard++ < 64) {
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain; // leaf first
}

export function collectAllObjects(scene: Scene): DrawableObject[] {
  const out: DrawableObject[] = [];
  for (const l of scene.layers) {
    out.push(...activeObjectsForLayer(scene, l, 0)); // base membership uses layer.objects ids
    for (const d of scene.drawingFrames.filter((f) => f.layerId === l.id)) out.push(...d.objects);
  }
  // de-dup by id keeping first occurrence
  const seen = new Set<string>(); const dedup: DrawableObject[] = [];
  for (const o of out) if (!seen.has(o.id)) { seen.add(o.id); dedup.push(o); }
  return dedup;
}

function animFor(project: Project, scene: Scene, objectId: string, time: number): EffectiveProps {
  const a = scene.animations.find((x) => x.objectId === objectId);
  return evaluateAnimation(a, time);
}

function drawObject(ctx: CanvasRenderingContext2D, project: Project, scene: Scene, obj: DrawableObject, time: number, extraAlpha: number): void {
  if (!obj.visible) return;
  const props = animFor(project, scene, obj.id, time);
  if (props.visible === false) return;
  const t = effectiveTransform(obj, props);
  const b = localBounds(obj);
  const pivot = obj.pivot ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  ctx.save();
  ctx.globalAlpha *= obj.opacity * (props.opacity ?? 1) * extraAlpha;
  ctx.translate(t.x, t.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scaleX, t.scaleY);
  ctx.translate(-pivot.x, -pivot.y);
  // NOTE: parent transforms were baked into object placement coordinates by the rig system;
  // hierarchical transforms are applied by drawing children inside parent space (see drawHierarchy).

  const fillCss = props.fill ?? (obj.fill ? rgbaToHexStr(obj.fill) : null);
  ctx.lineCap = obj.strokeCap;
  ctx.lineJoin = 'round';

  if (obj.kind === 'path' && obj.strokeKind === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  }

  switch (obj.kind) {
    case 'path': {
      ctx.beginPath();
      obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (obj.closed) ctx.closePath();
      if (obj.strokeKind === 'eraser') {
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = obj.brushSize;
        ctx.stroke();
      } else {
        if (obj.stroke && obj.strokeWidth > 0) {
          ctx.strokeStyle = rgba(obj.stroke);
          ctx.lineWidth = obj.strokeWidth;
          ctx.stroke();
        }
        // Freehand strokes render as round-capped polyline of brushSize width
        if (obj.points.length > 1 && obj.strokeKind !== 'eraser') {
          ctx.strokeStyle = fillCss ?? rgba(obj.stroke) ;
          ctx.lineWidth = obj.brushSize;
          ctx.beginPath();
          obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.stroke();
        } else if (obj.points.length === 1) {
          ctx.fillStyle = fillCss ?? '#000';
          ctx.beginPath();
          ctx.arc(obj.points[0].x, obj.points[0].y, obj.brushSize / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        if (obj.closed && obj.fill) {
          ctx.fillStyle = fillCss ?? rgba(obj.fill);
          ctx.beginPath();
          obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.closePath();
          ctx.fill();
        }
      }
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(obj.from.x, obj.from.y);
      ctx.lineTo(obj.to.x, obj.to.y);
      ctx.strokeStyle = rgba(obj.stroke ?? obj.fill);
      ctx.lineWidth = Math.max(1, obj.strokeWidth);
      ctx.stroke();
      break;
    }
    case 'rect': {
      pathRoundRect(ctx, obj.origin.x, obj.origin.y, obj.size.width, obj.size.height, obj.radius);
      if (obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
      if (obj.stroke && obj.strokeWidth > 0) { ctx.strokeStyle = rgba(obj.stroke); ctx.lineWidth = obj.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(obj.center.x, obj.center.y, Math.abs(obj.radiusX), Math.abs(obj.radiusY), 0, 0, Math.PI * 2);
      if (obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
      if (obj.stroke && obj.strokeWidth > 0) { ctx.strokeStyle = rgba(obj.stroke); ctx.lineWidth = obj.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'polygon': {
      ctx.beginPath();
      obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (obj.closed) ctx.closePath();
      if (obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
      if (obj.stroke && obj.strokeWidth > 0) { ctx.strokeStyle = rgba(obj.stroke); ctx.lineWidth = obj.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'text': {
      ctx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px ${obj.fontFamily}`;
      ctx.textAlign = obj.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = fillCss ?? rgba(obj.fill ?? { r: 0, g: 0, b: 0, a: 1 });
      ctx.fillText(obj.text, 0, 0);
      if (obj.stroke && obj.strokeWidth > 0) {
        ctx.strokeStyle = rgba(obj.stroke);
        ctx.lineWidth = obj.strokeWidth;
        ctx.strokeText(obj.text, 0, 0);
      }
      break;
    }
    case 'image': {
      const asset = project.assets.find((a) => a.id === obj.assetId);
      if (asset?.dataUrl) {
        const img = getCachedImage(asset.dataUrl);
        if (img) ctx.drawImage(img, 0, 0, obj.size.width, obj.size.height);
      }
      break;
    }
  }
  ctx.restore();
}

function rgbaToHexStr(c: RGBA): string {
  const to = (x: number) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0');
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

function pathRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw objects respecting parent-child hierarchy (rig groups move children). */
function drawHierarchy(ctx: CanvasRenderingContext2D, project: Project, scene: Scene, objects: DrawableObject[], time: number, extraAlpha: number): void {
  const hasParent = new Set(objects.map((o) => o.parentId).filter(Boolean) as string[]);
  const childrenOf = new Map<string, DrawableObject[]>();
  const roots: DrawableObject[] = [];
  for (const o of objects) {
    if (o.parentId && hasParent.has(o.parentId)) {
      const arr = childrenOf.get(o.parentId) ?? [];
      arr.push(o);
      childrenOf.set(o.parentId, arr);
    } else roots.push(o);
  }
  const visit = (o: DrawableObject) => {
    drawObjectWithChildren(ctx, project, scene, o, childrenOf, time, extraAlpha, 0);
  };
  for (const r of roots) visit(r);
}

function drawObjectWithChildren(ctx: CanvasRenderingContext2D, project: Project, scene: Scene, obj: DrawableObject, childrenOf: Map<string, DrawableObject[]>, time: number, extraAlpha: number, depth: number): void {
  if (depth > 32) return; // cycle guard
  if (!obj.visible) return;
  const props = animFor(project, scene, obj.id, time);
  if (props.visible === false) return;
  const t = effectiveTransform(obj, props);
  const b = localBounds(obj);
  const pivot = obj.pivot ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  ctx.save();
  ctx.globalAlpha *= obj.opacity * (props.opacity ?? 1) * extraAlpha;
  // Apply transform delta relative to identity so children inherit motion without double-drawing offset:
  // We translate by (t.x,t.y) rotate about pivot scale about pivot, then draw geometry in local coords.
  ctx.translate(t.x + pivot.x, t.y + pivot.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scaleX, t.scaleY);
  ctx.translate(-pivot.x, -pivot.y);
  drawShapeOnly(ctx, project, scene, obj, props, time, extraAlpha);
  for (const c of childrenOf.get(obj.id) ?? []) {
    drawObjectWithChildren(ctx, project, scene, c, childrenOf, time, extraAlpha, depth + 1);
  }
  ctx.restore();
}

/** Renders just the shape (no transform save/restore) — called inside parent space. */
function drawShapeOnly(ctx: CanvasRenderingContext2D, project: Project, scene: Scene, obj: DrawableObject, props: EffectiveProps, _time: number, _alpha: number): void {
  const fillCss = props.fill ?? (obj.fill ? rgbaToHexStr(obj.fill) : null);
  ctx.lineCap = obj.strokeCap;
  ctx.lineJoin = 'round';
  const erasing = obj.kind === 'path' && obj.strokeKind === 'eraser';
  if (erasing) ctx.globalCompositeOperation = 'destination-out';

  switch (obj.kind) {
    case 'path': {
      if (erasing) {
        ctx.beginPath();
        obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.lineWidth = obj.brushSize;
        ctx.stroke();
      } else if (obj.points.length > 1) {
        ctx.beginPath();
        obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        if (obj.closed) ctx.closePath();
        if (obj.closed && obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
        ctx.strokeStyle = obj.stroke && obj.strokeWidth > 0 ? rgba(obj.stroke) : (fillCss ?? '#000');
        ctx.lineWidth = obj.stroke && obj.strokeWidth > 0 ? obj.strokeWidth : obj.brushSize;
        ctx.stroke();
      } else if (obj.points.length === 1) {
        ctx.fillStyle = fillCss ?? '#000';
        ctx.beginPath();
        ctx.arc(obj.points[0].x, obj.points[0].y, Math.max(0.5, obj.brushSize / 2), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(obj.from.x, obj.from.y);
      ctx.lineTo(obj.to.x, obj.to.y);
      ctx.strokeStyle = rgba(obj.stroke ?? obj.fill);
      ctx.lineWidth = Math.max(1, obj.strokeWidth);
      ctx.stroke();
      break;
    }
    case 'rect': {
      pathRoundRect(ctx, obj.origin.x, obj.origin.y, obj.size.width, obj.size.height, obj.radius);
      if (obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
      if (obj.stroke && obj.strokeWidth > 0) { ctx.strokeStyle = rgba(obj.stroke); ctx.lineWidth = obj.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(obj.center.x, obj.center.y, Math.abs(obj.radiusX), Math.abs(obj.radiusY), 0, 0, Math.PI * 2);
      if (obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
      if (obj.stroke && obj.strokeWidth > 0) { ctx.strokeStyle = rgba(obj.stroke); ctx.lineWidth = obj.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'polygon': {
      ctx.beginPath();
      obj.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (obj.closed) ctx.closePath();
      if (obj.fill) { ctx.fillStyle = fillCss ?? rgba(obj.fill); ctx.fill(); }
      if (obj.stroke && obj.strokeWidth > 0) { ctx.strokeStyle = rgba(obj.stroke); ctx.lineWidth = obj.strokeWidth; ctx.stroke(); }
      break;
    }
    case 'text': {
      ctx.font = `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize}px ${obj.fontFamily}`;
      ctx.textAlign = obj.align;
      ctx.fillStyle = fillCss ?? rgba(obj.fill ?? { r: 0, g: 0, b: 0, a: 1 });
      ctx.fillText(obj.text, 0, 0);
      break;
    }
    case 'image': {
      const asset = project.assets.find((a) => a.id === obj.assetId);
      if (asset?.dataUrl) {
        const img = getCachedImage(asset.dataUrl);
        if (img) ctx.drawImage(img, 0, 0, obj.size.width, obj.size.height);
      }
      break;
    }
  }
  if (erasing) ctx.globalCompositeOperation = 'source-over';
}

// Keep the simple non-hierarchical drawer referenced to avoid dead-code lint confusion:
void drawObject;

/**
 * THE deterministic entry point. Renders `scene` of `project` at `time` seconds onto ctx.
 * ctx must already be sized to scene dimensions (or scaled by caller).
 */
export function renderScene(ctx: CanvasRenderingContext2D, project: Project, scene: Scene, time: number, opts: RenderOptions = {}): void {
  const W = scene.width, H = scene.height;
  ctx.save();
  ctx.clearRect(0, 0, W, H);

  if (opts.checkerboard) {
    const sq = 16;
    for (let y = 0; y < H; y += sq) for (let x = 0; x < W; x += sq) {
      ctx.fillStyle = ((x / sq + y / sq) % 2 === 0) ? '#e8e8e8' : '#ffffff';
      ctx.fillRect(x, y, sq, sq);
    }
  } else if (scene.backgroundColor.a > 0) {
    ctx.fillStyle = rgba(scene.backgroundColor);
    ctx.fillRect(0, 0, W, H);
  }

  // Camera (keyframed pan/zoom), linear interpolation between camera keyframes.
  const cam = sampleCamera(scene, time);
  ctx.translate(W / 2, H / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-W / 2 - cam.x, -H / 2 - cam.y);

  // Onion skin (behind current frame)
  for (const onion of opts.onionObjects ?? []) {
    drawHierarchy(ctx, project, scene, onion.objects, time, onion.alpha);
  }

  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (layer.kind === 'vector') {
      const objs = activeObjectsForLayer(scene, layer, time);
      drawHierarchy(ctx, project, scene, objs, time, 1);
    } else if (layer.rasterAssetId) {
      const asset = project.assets.find((a) => a.id === layer.rasterAssetId);
      if (asset?.dataUrl) {
        const img = getCachedImage(asset.dataUrl);
        if (img) ctx.drawImage(img, 0, 0, W, H);
      }
    }
    ctx.restore();
  }

  // Subtitles (burned-in text overlays)
  const subs = scene.subtitles.filter((s) => s.startTime <= time && time < s.endTime);
  if (subs.length > 0) {
    ctx.save();
    ctx.resetTransform();
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(H / 22)}px sans-serif`;
    subs.slice(0, 3).forEach((s, i) => {
      const y = H - 24 - i * (H / 18);
      const label = s.speaker ? `${s.speaker}: ${s.text}` : s.text;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const w = ctx.measureText(label).width + 16;
      ctx.fillRect(W / 2 - w / 2, y - Math.round(H / 22), w, Math.round(H / 16));
      ctx.fillStyle = '#fff';
      ctx.fillText(label, W / 2, y);
    });
    ctx.restore();
  }

  if (opts.grid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120,120,255,0.25)';
    ctx.lineWidth = 1 / Math.max(0.01, cam.zoom);
    for (let x = 0; x <= W; x += opts.grid.size) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += opts.grid.size) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
  }
  if (opts.safeAreas) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,80,80,0.6)';
    ctx.setLineDash([8, 6]);
    const inset = (f: number) => { ctx.strokeRect(W * f, H * f, W * (1 - 2 * f), H * (1 - 2 * f)); };
    ctx.beginPath(); inset(opts.safeAreas.actionSafe); ctx.stroke();
    ctx.strokeStyle = 'rgba(80,180,255,0.7)';
    ctx.beginPath(); inset(opts.safeAreas.titleSafe); ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

export function sampleCamera(scene: Scene, time: number): { x: number; y: number; zoom: number } {
  const kfs = scene.camera.keyframes;
  if (!kfs || kfs.length === 0) return { x: scene.camera.x, y: scene.camera.y, zoom: scene.camera.zoom };
  if (time <= kfs[0].time) return { x: kfs[0].x, y: kfs[0].y, zoom: kfs[0].zoom };
  const last = kfs[kfs.length - 1];
  if (time >= last.time) return { x: last.x, y: last.y, zoom: last.zoom };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (time >= a.time && time <= b.time) {
      const t = (time - a.time) / Math.max(1e-9, b.time - a.time);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, zoom: a.zoom + (b.zoom - a.zoom) * t };
    }
  }
  return { x: last.x, y: last.y, zoom: last.zoom };
}

/** Render the whole project timeline at absolute time (handles scene transitions). */
export function renderProjectAtTime(ctx: CanvasRenderingContext2D, project: Project, absTime: number, opts: RenderOptions = {}): { scene: Scene; localTime: number } {
  let acc = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    const sc = project.scenes[i];
    if (absTime < acc + sc.duration || i === project.scenes.length - 1) {
      const local = Math.min(sc.duration, Math.max(0, absTime - acc));
      renderScene(ctx, project, sc, local, opts);
      // transition-in fade/wipe over previous-scene boundary
      const tr = sc.transitionIn;
      if (tr.type !== 'cut' && local < tr.duration && i > 0) {
        const prev = project.scenes[i - 1];
        const alpha = 1 - local / tr.duration;
        ctx.save();
        ctx.globalAlpha = alpha;
        if (tr.type === 'fade') {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, sc.width, sc.height);
        } else if (tr.type === 'wipeLeft' || tr.type === 'wipeRight') {
          ctx.fillStyle = '#000';
          const w = sc.width * alpha;
          ctx.fillRect(tr.type === 'wipeLeft' ? sc.width - w : 0, 0, w, sc.height);
        } else if (tr.type === 'slideLeft') {
          void prev;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, sc.width * alpha * 0.15, sc.height);
        }
        ctx.restore();
      }
      return { scene: sc, localTime: local };
    }
    acc += sc.duration;
  }
  const sc = project.scenes[0];
  renderScene(ctx, project, sc, 0, opts);
  return { scene: sc, localTime: 0 };
}

export function totalDuration(project: Project): number {
  return project.scenes.reduce((a, s) => a + s.duration, 0);
}
