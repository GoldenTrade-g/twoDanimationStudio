/**
 * Tool interaction state machine. Pure-ish: given a tool + pointer events in scene
 * coordinates, produces object drafts / mutations that the UI commits via the store.
 */
import type { DrawableObject, Vec2, PathObject, RectObject, EllipseObject, LineObject, PolygonObject, TextObject } from '@studio/shared';
import { uid, hexToRgba } from '../util';
import type { EditorStore, ToolId } from '../state/store';
import { pickObject, objectsInRect, transformedBounds, snapPoint, type Bounds } from '../engine/hitTest';
import { floodFill, samplePixel } from '../engine/fillBucket';

export interface BrushSettings {
  brushSize: number; brushOpacity: number; fillColor: string; strokeColor: string; strokeWidth: number; fillTolerance: number;
}

export class ToolController {
  private drawing: PathObject | null = null;
  private shapeStart: Vec2 | null = null;
  private shapeDraft: DrawableObject | null = null;
  private polyPoints: Vec2[] = [];
  private dragKind: 'none' | 'move' | 'resize' | 'rotate' | 'marquee' | 'pan' = 'none';
  private dragStart: Vec2 | null = null;
  private marquee: Bounds | null = null;
  /** Live draft rendered on top of committed content (preview). */
  draft: DrawableObject | null = null;
  onDraftChanged: (() => void) | null = null;

  constructor(private store: EditorStore, private getBrush: () => BrushSettings) {}

  private scenePt(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): Vec2 {
    const st = this.store.getState();
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width; // device px per css px
    return {
      x: ((e.clientX - rect.left) * scale) / st.zoom - st.pan.x / st.zoom,
      y: ((e.clientY - rect.top) * scale) / st.zoom - st.pan.y / st.zoom,
    };
  }

  getMarquee(): Bounds | null { return this.marquee; }

  pointerDown(tool: ToolId, e: { clientX: number; clientY: number; shiftKey: boolean; button: number }, canvas: HTMLCanvasElement): void {
    const st = this.store.getState();
    const p0 = snapPoint(this.scenePt(e, canvas), st.project.settings.gridSize, st.project.settings.snapping);
    const layer = this.store.activeLayer();
    const objs = layer ? [...layer.objects] : [];

    switch (tool) {
      case 'hand':
        this.dragKind = 'pan';
        this.dragStart = { x: e.clientX - st.pan.x, y: e.clientY - st.pan.y };
        return;
      case 'pencil':
      case 'brush':
      case 'eraser': {
        if (!layer || layer.kind !== 'vector' || layer.locked) { this.store.status('Pick an unlocked vector layer to draw on.'); return; }
        const b = this.getBrush();
        const color = tool === 'eraser' ? null : hexToRgba(b.strokeColor, tool === 'brush' ? b.brushOpacity : 1);
        this.drawing = {
          id: uid('obj'), name: tool, kind: 'path',
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          opacity: 1, visible: true, parentId: null, pivot: null,
          fill: null, stroke: color, strokeWidth: 0, strokeCap: 'round', assetId: null,
          points: [p0], brushSize: tool === 'pencil' ? Math.max(2, b.brushSize / 2) : b.brushSize, closed: false,
          strokeKind: tool === 'eraser' ? 'eraser' : tool === 'brush' ? 'brush' : 'pencil',
        };
        this.draft = this.drawing;
        this.notify();
        return;
      }
      case 'line':
      case 'rect':
      case 'ellipse': {
        if (!layer || layer.kind !== 'vector' || layer.locked) { this.store.status('Pick an unlocked vector layer to draw on.'); return; }
        this.shapeStart = p0;
        return;
      }
      case 'polygon': {
        if (!layer || layer.kind !== 'vector' || layer.locked) return;
        if (this.polyPoints.length >= 3 && dist(p0, this.polyPoints[0]) < 12) { this.finishPolygon(); return; }
        this.polyPoints.push(p0);
        this.draft = this.makePolyDraft([...this.polyPoints]);
        this.notify();
        return;
      }
      case 'text': {
        const text = window.prompt('Text:', 'Hello');
        if (text) {
          const obj: TextObject = {
            id: uid('obj'), name: 'Text', kind: 'text',
            transform: { x: p0.x, y: p0.y, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1, visible: true, parentId: null, pivot: null,
            fill: hexToRgba(this.getBrush().strokeColor, 1), stroke: null, strokeWidth: 0, strokeCap: 'butt', assetId: null,
            text, fontFamily: 'sans-serif', fontSize: 48, bold: false, italic: false, align: 'left',
          };
          this.store.addObject(obj);
        }
        return;
      }
      case 'fill': {
        this.doFill(p0, canvas);
        return;
      }
      case 'eyedropper': {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = canvas.width / (this.viewW());
        const px = Math.floor((e.clientX - canvas.getBoundingClientRect().left) * dpr);
        const py = Math.floor((e.clientY - canvas.getBoundingClientRect().top) * dpr);
        try {
          const data = ctx.getImageData(px, py, 1, 1).data;
          const hex = rgbToHex(data[0], data[1], data[2]);
          this.store.ui({ strokeColor: hex });
          this.store.status(`Picked ${hex}`);
        } catch { this.store.status('Eyedropper unavailable (cross-origin content).'); }
        return;
      }
      case 'select':
      case 'move': {
        const hit = pickObject(objs, p0, 6 / st.zoom);
        if (hit) {
          let sel = st.selectedObjectIds;
          if (e.shiftKey) sel = sel.includes(hit.id) ? sel.filter((i) => i !== hit.id) : [...sel, hit.id];
          else if (!sel.includes(hit.id)) sel = [hit.id];
          this.store.ui({ selectedObjectIds: sel });
          this.dragKind = tool === 'move' || tool === 'select' ? 'move' : 'move';
          this.dragStart = p0;
        } else {
          this.store.ui({ selectedObjectIds: [] });
        }
        return;
      }
      case 'lasso': {
        this.dragKind = 'marquee';
        this.dragStart = p0;
        this.marquee = { x: p0.x, y: p0.y, w: 0, h: 0 };
        return;
      }
    }
  }

  pointerMove(tool: ToolId, e: { clientX: number; clientY: number; shiftKey: boolean }, canvas: HTMLCanvasElement): void {
    const st = this.store.getState();
    const p = this.scenePt(e, canvas);
    switch (this.dragKind) {
      case 'pan': {
        if (!this.dragStart) return;
        this.store.ui({ pan: { x: e.clientX - this.dragStart.x, y: e.clientY - this.dragStart.y } });
        return;
      }
      case 'move': {
        if (!this.dragStart || st.selectedObjectIds.length === 0) return;
        const dx = p.x - this.dragStart.x, dy = p.y - this.dragStart.y;
        if (dx === 0 && dy === 0) return;
        this.dragStart = p;
        this.store.updateObjects(st.selectedObjectIds, (o) => ({ ...o, transform: { ...o.transform, x: o.transform.x + dx, y: o.transform.y + dy } }), 'Move objects', 'drag-move');
        return;
      }
      case 'marquee': {
        if (!this.dragStart) return;
        this.marquee = normBounds(this.dragStart, p);
        this.notify();
        return;
      }
      case 'none': break;
    }
    if (this.drawing) {
      const sp = snapPoint(p, st.project.settings.gridSize, st.project.settings.snapping && e.shiftKey);
      const last = this.drawing.points[this.drawing.points.length - 1];
      if (dist(last, sp) > 1.5) {
        this.drawing.points.push(sp);
        this.draft = this.drawing;
        this.notify();
      }
      return;
    }
    if (this.shapeStart && (tool === 'line' || tool === 'rect' || tool === 'ellipse')) {
      const b = this.getBrush();
      const s = this.shapeStart;
      const snapped = e.shiftKey ? constrainSquare(s, p) : p;
      if (tool === 'line') {
        const to = e.shiftKey ? snapAngle(s, p) : snapped;
        this.draft = {
          id: uid('obj'), name: 'Line', kind: 'line',
          transform: IDENTITY, opacity: 1, visible: true, parentId: null, pivot: null,
          fill: null, stroke: hexToRgba(b.strokeColor, 1), strokeWidth: b.strokeWidth, strokeCap: 'round', assetId: null,
          from: s, to,
        } as LineObject;
      } else if (tool === 'rect') {
        const nb = normBounds(s, snapped);
        this.draft = {
          id: uid('obj'), name: 'Rectangle', kind: 'rect',
          transform: IDENTITY, opacity: 1, visible: true, parentId: null, pivot: null,
          fill: hexToRgba(b.fillColor, 1), stroke: hexToRgba(b.strokeColor, 1), strokeWidth: b.strokeWidth, strokeCap: 'butt', assetId: null,
          origin: { x: nb.x, y: nb.y }, size: { width: nb.w, height: nb.h }, radius: 0,
        } as RectObject;
      } else {
        const nb = normBounds(s, snapped);
        this.draft = {
          id: uid('obj'), name: 'Ellipse', kind: 'ellipse',
          transform: IDENTITY, opacity: 1, visible: true, parentId: null, pivot: null,
          fill: hexToRgba(b.fillColor, 1), stroke: hexToRgba(b.strokeColor, 1), strokeWidth: b.strokeWidth, strokeCap: 'butt', assetId: null,
          center: { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 }, radiusX: nb.w / 2, radiusY: nb.h / 2,
        } as EllipseObject;
      }
      this.notify();
    }
    if (tool === 'polygon' && this.polyPoints.length >= 1) {
      this.draft = this.makePolyDraft([...this.polyPoints, p]);
      this.notify();
    }
  }

  pointerUp(tool: ToolId, e: { clientX: number; clientY: number; shiftKey: boolean }, canvas: HTMLCanvasElement): void {
    const st = this.store.getState();
    if (this.dragKind === 'marquee' && this.marquee) {
      const layer = this.store.activeLayer();
      if (layer) {
        const picked = objectsInRect(layer.objects, this.marquee).map((o) => o.id);
        this.store.ui({ selectedObjectIds: e.shiftKey ? [...new Set([...st.selectedObjectIds, ...picked])] : picked });
      }
    }
    if (this.drawing && this.drawing.points.length > 0) {
      this.store.addObject(this.drawing);
    }
    if (this.draft && (tool === 'line' || tool === 'rect' || tool === 'ellipse') && this.shapeStart) {
      const p = this.scenePt(e, canvas);
      const snapped = e.shiftKey ? constrainSquare(this.shapeStart, p) : p;
      const b = this.getBrush();
      let obj: DrawableObject | null = null;
      if (tool === 'line') {
        const to = e.shiftKey ? snapAngle(this.shapeStart, p) : p;
        if (dist(this.shapeStart, to) > 2) {
          obj = { ...(this.draft as LineObject), to };
        }
      } else if (tool === 'rect') {
        const nb = normBounds(this.shapeStart, snapped);
        if (nb.w > 2 && nb.h > 2) obj = { ...(this.draft as RectObject), origin: { x: nb.x, y: nb.y }, size: { width: nb.w, height: nb.h } };
      } else {
        const nb = normBounds(this.shapeStart, snapped);
        if (nb.w > 2 && nb.h > 2) obj = { ...(this.draft as EllipseObject), center: { x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 }, radiusX: nb.w / 2, radiusY: nb.h / 2 };
      }
      if (obj) this.store.addObject(obj);
    }
    this.drawing = null;
    this.shapeStart = null;
    this.dragKind = 'none';
    this.marquee = null;
    this.draft = null;
    this.notify();
    void st;
  }

  finishPolygon(): void {
    if (this.polyPoints.length >= 2) {
      const b = this.getBrush();
      const obj: PolygonObject = {
        id: uid('obj'), name: 'Polygon', kind: 'polygon',
        transform: IDENTITY, opacity: 1, visible: true, parentId: null, pivot: null,
        fill: hexToRgba(b.fillColor, 1), stroke: hexToRgba(b.strokeColor, 1), strokeWidth: b.strokeWidth, strokeCap: 'butt', assetId: null,
        points: this.polyPoints, closed: true,
      };
      this.store.addObject(obj);
    }
    this.polyPoints = [];
    this.draft = null;
    this.notify();
  }

  cancelTransient(): void {
    this.polyPoints = [];
    this.drawing = null;
    this.shapeStart = null;
    this.draft = null;
    this.marquee = null;
    this.notify();
  }

  private makePolyDraft(points: Vec2[]): PolygonObject {
    const b = this.getBrush();
    return {
      id: uid('obj'), name: 'Polygon', kind: 'polygon',
      transform: IDENTITY, opacity: 1, visible: true, parentId: null, pivot: null,
      fill: null, stroke: hexToRgba(b.strokeColor, 1), strokeWidth: b.strokeWidth, strokeCap: 'butt', assetId: null,
      points, closed: false,
    };
  }

  /** Fill bucket: raster layers via ImageData; vector layers fill closed shapes under cursor. */
  private doFill(p: Vec2, canvas: HTMLCanvasElement): void {
    const layer = this.store.activeLayer();
    const st = this.store.getState();
    if (!layer) return;
    const b = this.getBrush();
    if (layer.kind !== 'vector') {
      // Raster path: operate on the layer bitmap via an offscreen canvas.
      if (!layer.rasterAssetId) { this.store.status('Raster layer has no image yet — add one first.'); return; }
      const asset = st.project.assets.find((a) => a.id === layer.rasterAssetId);
      if (!asset?.dataUrl) return;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = st.project.width; c.height = st.project.height;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const data = ctx.getImageData(0, 0, c.width, c.height);
        const col = hexToRgba(b.fillColor, 1);
        const res = floodFill(data.data, c.width, c.height, Math.round(p.x), Math.round(p.y),
          [col.r, col.g, col.b, 255], b.fillTolerance);
        if (!res.changed) { this.store.status(res.reason ?? 'Nothing filled.'); return; }
        ctx.putImageData(data, 0, 0);
        const newUrl = c.toDataURL('image/png');
        const newAsset = { ...asset, id: asset.id, dataUrl: newUrl };
        this.store.run({
          label: 'Fill raster layer',
          apply: (proj) => { const a = proj.assets.find((x) => x.id === asset.id); if (a) a.dataUrl = newUrl; },
        });
        this.store.status(`Filled ${res.pixelsFilled} px.`);
      };
      img.onerror = () => this.store.status('Could not load layer image for filling.');
      img.src = asset.dataUrl;
      return;
    }
    // Vector: if a closed filled shape is under the cursor → recolor it (undoable).
    const hit = pickObject(layer.objects, p, 4);
    if (hit && (hit.kind === 'rect' || hit.kind === 'ellipse' || hit.kind === 'polygon' || (hit.kind === 'path' && hit.closed))) {
      const col = hexToRgba(b.fillColor, 1);
      this.store.updateObjects([hit.id], (o) => ({ ...o, fill: col }), 'Fill shape');
      this.store.status('Filled shape.');
      return;
    }
    // Otherwise: convert the enclosed region visually by adding a large background fill? No — be honest:
    this.store.status('No closed shape under the cursor. On vector layers the bucket fills closed shapes; use a raster layer for pixel flood-fill.');
    void canvas;
  }

  private viewW(): number {
    const st = this.store.getState();
    return st.project.width * st.zoom;
  }

  private notify(): void { this.onDraftChanged?.(); }
}

const IDENTITY = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

function normBounds(a: Vec2, b: Vec2): Bounds {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function constrainSquare(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x, dy = to.y - from.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + Math.sign(dx) * m, y: from.y + Math.sign(dy) * m };
}

function snapAngle(from: Vec2, to: Vec2): Vec2 {
  const ang = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / (Math.PI / 4)) * (Math.PI / 4);
  const len = dist(from, to);
  return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => v.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export { transformedBounds };
