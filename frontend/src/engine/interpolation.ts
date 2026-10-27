/**
 * Deterministic keyframe evaluation — used identically by editor playback and export.
 * Given an object's animation tracks and a time in seconds, produce the effective
 * animatable properties at that exact time. No wall-clock reads here: pure function.
 */
import type { ObjectAnimation, Keyframe, Interpolation, AnimatableProp } from '@studio/shared';

export interface EffectiveProps {
  x?: number; y?: number; scaleX?: number; scaleY?: number; rotation?: number;
  opacity?: number; fill?: string; visible?: boolean;
}

/** Easing curves. All are deterministic and map [0,1] -> [0,1]. */
export function ease(t: number, kind: Interpolation): number {
  const c = Math.min(1, Math.max(0, t));
  switch (kind) {
    case 'hold': return 0;
    case 'linear': return c;
    case 'easeIn': return c * c;
    case 'easeOut': return c * (2 - c);
    case 'easeInOut': return c < 0.5 ? 2 * c * c : -1 + (4 - 2 * c) * c;
    case 'bounce': {
      // Approximation of a bounce-out curve (documented as approximation, not physics sim).
      const n1 = 7.5625, d1 = 2.75;
      let x = 1 - c; // invert so "bounce" settles at target value
      let v: number;
      if (x < 1 / d1) v = n1 * x * x;
      else if (x < 2 / d1) { x -= 1.5 / d1; v = n1 * x * x + 0.75; }
      else if (x < 2.5 / d1) { x -= 2.25 / d1; v = n1 * x * x + 0.9375; }
      else { x -= 2.625 / d1; v = n1 * x * x + 0.984375; }
      return 1 - v;
    }
  }
}

function numAt(tracks: Record<string, Keyframe[]>, prop: string, time: number): number | undefined {
  const kfs = tracks[prop];
  if (!kfs || kfs.length === 0) return undefined;
  // kfs sorted by time (validator guarantees). Find last kf with time <= t.
  let i = -1;
  for (let j = 0; j < kfs.length; j++) { if (kfs[j].time <= time + 1e-9) i = j; else break; }
  if (i === -1) return typeof kfs[0].value === 'number' ? kfs[0].value : undefined; // before first keyframe: hold first value
  const a = kfs[i];
  if (typeof a.value !== 'number') return undefined;
  if (i === kfs.length - 1) return a.value; // after last keyframe: hold
  const b = kfs[i + 1];
  if (typeof b.value !== 'number') return a.value;
  if (b.interpolation === 'hold') return a.value;
  const span = b.time - a.time;
  if (span <= 0) return b.value;
  const t = ease((time - a.time) / span, b.interpolation);
  return a.value + (b.value - a.value) * t;
}

function boolAt(tracks: Record<string, Keyframe[]>, prop: string, time: number): boolean | undefined {
  const kfs = tracks[prop];
  if (!kfs || kfs.length === 0) return undefined;
  let val: boolean | undefined;
  for (const kf of kfs) {
    if (kf.time <= time + 1e-9) val = Boolean(kf.value);
    else break;
  }
  if (val === undefined) val = Boolean(kfs[0].value);
  return val; // discrete: step/hold semantics
}

function colorAt(tracks: Record<string, Keyframe[]>, prop: string, time: number): string | undefined {
  const kfs = tracks[prop];
  if (!kfs || kfs.length === 0) return undefined;
  let i = -1;
  for (let j = 0; j < kfs.length; j++) { if (kfs[j].time <= time + 1e-9) i = j; else break; }
  if (i === -1) return String(kfs[0].value);
  const a = String(kfs[i].value);
  if (i === kfs.length - 1) return a;
  const b = kfs[i + 1];
  const bStr = String(b.value);
  if (b.interpolation === 'hold') return a;
  const span = b.time - a.time;
  const t = span > 0 ? ease((time - a.time) / span, b.interpolation) : 1;
  const pa = parseHex(a), pb = parseHex(bStr);
  if (!pa || !pb) return t >= 0.5 ? bStr : a;
  const mix = (u: number, v: number) => Math.round(u + (v - u) * t);
  return `#${mix(pa[0], pb[0]).toString(16).padStart(2, '0')}${mix(pa[1], pb[1]).toString(16).padStart(2, '0')}${mix(pa[2], pb[2]).toString(16).padStart(2, '0')}`;
}

function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Compute all effective animated props for one object at a given scene time. */
export function evaluateAnimation(anim: ObjectAnimation | undefined, time: number): EffectiveProps {
  const out: EffectiveProps = {};
  if (!anim) return out;
  const tr = anim.tracks;
  for (const p of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'] as AnimatableProp[]) {
    const v = numAt(tr, p, time);
    if (v !== undefined) (out as Record<string, number>)[p] = v;
  }
  const vis = boolAt(tr, 'visible', time);
  if (vis !== undefined) out.visible = vis;
  const fill = colorAt(tr, 'fill', time);
  if (fill !== undefined) out.fill = fill;
  return out;
}

/** Add or replace a keyframe immutably; keeps tracks sorted by time. */
export function upsertKeyframe(anim: ObjectAnimation, prop: string, kf: Keyframe): ObjectAnimation {
  const list = (anim.tracks[prop] ?? []).filter((k) => Math.abs(k.time - kf.time) > 1e-6 && k.id !== kf.id);
  list.push(kf);
  list.sort((a, b) => a.time - b.time);
  return { objectId: anim.objectId, tracks: { ...anim.tracks, [prop]: list } };
}

export function removeKeyframe(anim: ObjectAnimation, prop: string, kfId: string): ObjectAnimation {
  const list = (anim.tracks[prop] ?? []).filter((k) => k.id !== kfId);
  const tracks = { ...anim.tracks };
  if (list.length === 0) delete tracks[prop]; else tracks[prop] = list;
  return { objectId: anim.objectId, tracks };
}
