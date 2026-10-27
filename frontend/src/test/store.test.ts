import { describe, it, expect } from 'vitest';
import type { DrawableObject, RGBA } from '@studio/shared';
import { EditorStore, newProject } from '../state/store';
import { tick, type ClockState } from '../engine/playbackClock';

const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });

function rect(id: string, x: number, y: number): DrawableObject {
  return {
    id, name: id, kind: 'rect', transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, visible: true, parentId: null, pivot: null,
    fill: rgba(255, 0, 0), stroke: null, strokeWidth: 0, strokeCap: 'round', assetId: null,
    origin: { x: 0, y: 0 }, size: { width: 40, height: 40 }, radius: 0,
  };
}

describe('EditorStore undo/redo', () => {
  it('undo restores previous project state; redo re-applies', () => {
    const store = new EditorStore(newProject('t'));
    const before = store.getState().project;
    const obj = rect('r1', 10, 10);
    store.addObject(obj);
    const afterAdd = store.getState().project;
    expect(store.canUndo()).toBe(true);

    store.undo();
    expect(store.getState().project).toEqual(before);
    expect(store.canRedo()).toBe(true);

    store.redo();
    expect(store.getState().project).toEqual(afterAdd);
    const scene = store.activeScene()!;
    expect(scene.layers.flatMap((l) => l.objects).map((o) => o.id)).toContain('r1');
  });

  it('coalesces consecutive drag updates into one history entry', () => {
    const store = new EditorStore(newProject('t'));
    store.addObject(rect('r1', 0, 0));
    const move = (dx: number) =>
      store.updateObjects(['r1'], (o) => ({ ...o, transform: { ...o.transform, x: dx } }), 'Move', 'drag-r1');
    move(5); move(10); move(15);
    expect(store.getState().past.length).toBe(2); // addObject + one coalesced move
    store.undo();
    expect(store.getState().past.length).toBe(1);
    const o = store.activeScene()!.layers.flatMap((l) => l.objects)[0];
    expect(o.transform.x).toBe(0); // fully back to pre-drag position
  });

  it('new mutation clears the redo stack', () => {
    const store = new EditorStore(newProject('t'));
    store.addObject(rect('a', 0, 0));
    store.undo();
    expect(store.canRedo()).toBe(true);
    store.addObject(rect('b', 0, 0));
    expect(store.canRedo()).toBe(false);
  });

  it('setKeyframe adds an animation track and is undoable', () => {
    const store = new EditorStore(newProject('t'));
    store.addObject(rect('k1', 0, 0));
    store.ui({ time: 0.5 });
    store.setKeyframe('k1', 'x', 200);
    const anims = store.activeScene()!.animations;
    expect(anims.find((a) => a.objectId === 'k1')?.tracks.x.some((k) => k.time === 0.5 && k.value === 200)).toBe(true);
    store.undo();
    expect(store.activeScene()!.animations.find((a) => a.objectId === 'k1')).toBeUndefined();
  });
});

describe('Playback clock (drift-free)', () => {
  const base: ClockState = { playing: true, time: 0, speed: 1, loop: false, duration: 2 };

  it('advances by real-time delta × speed', () => {
    expect(tick(base, 500).time).toBeCloseTo(0.5);
    expect(tick({ ...base, speed: 2 }, 500).time).toBeCloseTo(1);
  });
  it('does not advance when paused', () => {
    expect(tick({ ...base, playing: false }, 1000).time).toBe(0);
  });
  it('clamps at duration and reports ended without loop', () => {
    const r = tick({ ...base, time: 1.8 }, 500);
    expect(r.time).toBe(2);
    expect(r.ended).toBe(true);
  });
  it('wraps when looping', () => {
    const r = tick({ ...base, loop: true, time: 1.8 }, 500);
    expect(r.wrapped).toBe(true);
    expect(r.time).toBeCloseTo(0.3, 4);
    // exact semantics: total 2.3 over duration 2 → remainder 0.3 (float tolerance)
    expect(Math.abs(r.time - 0.3)).toBeLessThan(1e-9);
  });
  it('many small ticks equal one big tick (no drift accumulation)', () => {
    let t = 0;
    for (let i = 0; i < 100; i++) t = tick({ ...base, time: t }, 16.6667).time;
    expect(t).toBeCloseTo(100 * 16.6667 / 1000, 3);
  });
});
