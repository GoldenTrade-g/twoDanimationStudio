/** Hit-testing and geometry helpers for editor tools. */
import type { DrawableObject, Vec2 } from '@studio/shared';
import { localBounds, type Bounds } from './renderer';

export function pointInBounds(p: Vec2, b: Bounds, pad = 0): boolean {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

/** Test a scene-space point against an object (accounts for the object's own transform). */
export function hitTestObject(obj: DrawableObject, ptScene: Vec2, tolerance = 4): boolean {
  // Map scene point into object local space by inverting translate/rotate/scale about pivot.
  const b = localBounds(obj);
  const pivot = obj.pivot ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const t = obj.transform;
  const rad = (-t.rotation * Math.PI) / 180;
  let dx = ptScene.x - t.x - pivot.x;
  let dy = ptScene.y - t.y - pivot.y;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  dx = rx / (t.scaleX || 1e-6);
  dy = ry / (t.scaleY || 1e-6);
  const lx = dx + pivot.x, ly = dy + pivot.y;

  switch (obj.kind) {
    case 'path': {
      if (obj.points.length === 0) return false;
      const w = Math.max(obj.brushSize, obj.strokeWidth) / 2 + tolerance;
      if (obj.closed && obj.fill) {
        if (pointInBounds({ x: lx, y: ly }, b, 0) && polygonEvenOdd(obj.points, { x: lx, y: ly })) return true;
      }
      for (let i = 1; i < obj.points.length; i++) {
        if (distToSegment({ x: lx, y: ly }, obj.points[i - 1], obj.points[i]) <= w) return true;
      }
      if (obj.points.length === 1) return dist({ x: lx, y: ly }, obj.points[0]) <= w;
      return false;
    }
    case 'line': {
      const w = Math.max(2, obj.strokeWidth) / 2 + tolerance;
      return distToSegment({ x: lx, y: ly }, obj.from, obj.to) <= w;
    }
    case 'rect': {
      const inside = lx >= obj.origin.x - tolerance && lx <= obj.origin.x + obj.size.width + tolerance &&
                     ly >= obj.origin.y - tolerance && ly <= obj.origin.y + obj.size.height + tolerance;
      if (!inside) return false;
      if (obj.fill) return true;
      const edge = 4 + tolerance;
      const nearEdge =
        Math.abs(lx - obj.origin.x) < edge || Math.abs(lx - (obj.origin.x + obj.size.width)) < edge ||
        Math.abs(ly - obj.origin.y) < edge || Math.abs(ly - (obj.origin.y + obj.size.height)) < edge;
      return nearEdge || !!obj.stroke;
    }
    case 'ellipse': {
      const nx = (lx - obj.center.x) / (Math.abs(obj.radiusX) + tolerance);
      const ny = (ly - obj.center.y) / (Math.abs(obj.radiusY) + tolerance);
      const d = nx * nx + ny * ny;
      if (obj.fill) return d <= 1;
      return d <= 1.3; // approximate outline pick
    }
    case 'polygon': {
      if (obj.fill && polygonEvenOdd(obj.points, { x: lx, y: ly })) return true;
      for (let i = 1; i <= obj.points.length; i++) {
        const a = obj.points[i - 1], bp = obj.points[i % obj.points.length];
        if (distToSegment({ x: lx, y: ly }, a, bp) <= 4 + tolerance) return true;
      }
      return false;
    }
    case 'text': {
      return pointInBounds({ x: lx, y: ly }, b, tolerance);
    }
    case 'image': {
      return pointInBounds({ x: lx, y: ly }, b, 0);
    }
  }
}

/** Topmost object at scene point among candidates (draw order = array order, last on top). */
export function pickObject(objects: DrawableObject[], pt: Vec2, tolerance = 4): DrawableObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (!o.visible) continue;
    if (hitTestObject(o, pt, tolerance)) return o;
  }
  return null;
}

export function objectsInRect(objects: DrawableObject[], r: Bounds): DrawableObject[] {
  return objects.filter((o) => {
    const b = transformedBounds(o);
    return !(b.x + b.w < r.x || b.x > r.x + r.w || b.y + b.h < r.y || b.y > r.y + r.h);
  });
}

export function transformedBounds(obj: DrawableObject): Bounds {
  const b = localBounds(obj);
  const t = obj.transform;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const w = Math.abs(b.w * t.scaleX), h = Math.abs(b.h * t.scaleY);
  const nw = w * cos + h * sin, nh = w * sin + h * cos;
  const cx = t.x + b.x + b.w / 2, cy = t.y + b.y + b.h / 2;
  return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
}

function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function polygonEvenOdd(points: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y, xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Snap helper: snaps to grid when enabled. */
export function snapPoint(p: Vec2, gridSize: number, enabled: boolean): Vec2 {
  if (!enabled || gridSize <= 0) return p;
  return { x: Math.round(p.x / gridSize) * gridSize, y: Math.round(p.y / gridSize) * gridSize };
}
