import { describe, it, expect } from 'vitest';
import type { ObjectAnimation, Keyframe } from '@studio/shared';
import { evaluateAnimation, ease, upsertKeyframe, removeKeyframe } from '../engine/interpolation';

const kf = (time: number, prop: string, value: number | string | boolean, interpolation: Keyframe['interpolation'] = 'linear'): Keyframe =>
  ({ id: `kf-${prop}-${time}`, time, prop: prop as Keyframe['prop'], value, interpolation });

const anim = (tracks: Record<string, Keyframe[]>): ObjectAnimation => ({ objectId: 'o1', tracks });

describe('ease()', () => {
  it('linear is identity-ish', () => {
    expect(ease(0, 'linear')).toBeCloseTo(0);
    expect(ease(0.5, 'linear')).toBeCloseTo(0.5);
    expect(ease(1, 'linear')).toBeCloseTo(1);
  });
  it('easing curves are monotonic and hit endpoints', () => {
    for (const kind of ['easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(ease(0, kind)).toBeCloseTo(0);
      expect(ease(1, kind)).toBeCloseTo(1);
      expect(ease(0.5, kind)).toBeGreaterThan(ease(0.25, kind));
    }
  });
});

describe('evaluateAnimation numeric props', () => {
  const a = anim({ x: [kf(0, 'x', 100), kf(2, 'x', 300)] });
  it('holds first value before first keyframe', () => {
    expect(evaluateAnimation(a, -1).x).toBeCloseTo(100);
  });
  it('interpolates linearly between keyframes', () => {
    expect(evaluateAnimation(a, 1).x).toBeCloseTo(200);
    expect(evaluateAnimation(a, 0.5).x).toBeCloseTo(150);
  });
  it('holds last value after final keyframe', () => {
    expect(evaluateAnimation(a, 10).x).toBeCloseTo(300);
  });
  it('hold interpolation steps at the next keyframe', () => {
    const h = anim({ y: [kf(0, 'y', 0), kf(1, 'y', 50, 'hold')] });
    expect(evaluateAnimation(h, 0.999).y).toBeCloseTo(0);
    expect(evaluateAnimation(h, 1).y).toBeCloseTo(50);
  });
  it('returns undefined for missing tracks', () => {
    expect(evaluateAnimation(a, 1).rotation).toBeUndefined();
    expect(evaluateAnimation(undefined, 1)).toEqual({});
  });
});

describe('evaluateAnimation color & boolean props', () => {
  it('interpolates hex fill colors', () => {
    const c = anim({ fill: [kf(0, 'fill', '#000000'), kf(1, 'fill', '#ffffff')] });
    const mid = evaluateAnimation(c, 0.5).fill;
    expect(mid).toMatch(/^#[0-9a-f]{6}$/i);
    expect(mid!.toLowerCase()).toBe('#808080');
  });
  it('hold keeps previous color until next keyframe', () => {
    const c = anim({ fill: [kf(0, 'fill', '#ff0000'), kf(1, 'fill', '#00ff00', 'hold')] });
    expect(evaluateAnimation(c, 0.5).fill).toBe('#ff0000');
    expect(evaluateAnimation(c, 1).fill).toBe('#00ff00');
  });
  it('visible is discrete (step semantics)', () => {
    const v = anim({ visible: [kf(0, 'visible', true), kf(2, 'visible', false)] });
    expect(evaluateAnimation(v, 1.9).visible).toBe(true);
    expect(evaluateAnimation(v, 2).visible).toBe(false);
  });
});

describe('upsertKeyframe / removeKeyframe', () => {
  it('replaces a keyframe at the same time and keeps tracks sorted', () => {
    let a = anim({ x: [kf(0, 'x', 1), kf(2, 'x', 3)] });
    a = upsertKeyframe(a, 'x', kf(1, 'x', 2));
    a = upsertKeyframe(a, 'x', kf(1, 'x', 99));
    const times = a.tracks.x.map((k) => k.time);
    expect(times).toEqual([0, 1, 2]);
    expect(a.tracks.x[1].value).toBe(99);
  });
  it('removes by id', () => {
    const a = anim({ x: [kf(0, 'x', 1), kf(2, 'x', 3)] });
    const b = removeKeyframe(a, 'x', a.tracks.x[0].id);
    expect(b.tracks.x.length).toBe(1);
  });
});
