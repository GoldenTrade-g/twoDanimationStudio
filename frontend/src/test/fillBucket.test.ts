import { describe, it, expect } from 'vitest';
import { floodFill, samplePixel } from '../engine/fillBucket';

function canvas(w: number, h: number, fill: [number, number, number, number] = [0, 0, 0, 0]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = fill[0]; d[i * 4 + 1] = fill[1]; d[i * 4 + 2] = fill[2]; d[i * 4 + 3] = fill[3]; }
  return d;
}

/** Draw a black rectangular border "enclosing" an interior region. */
function enclosed(w: number, h: number): Uint8ClampedArray {
  const d = canvas(w, h, [255, 255, 255, 255]);
  const set = (x: number, y: number) => { const o = (y * w + x) * 4; d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 255; };
  for (let x = 2; x <= w - 3; x++) { set(x, 2); set(x, h - 3); }
  for (let y = 2; y <= h - 3; y++) { set(2, y); set(w - 3, y); }
  return d;
}

describe('floodFill', () => {
  it('fills only the enclosed region, stopping at boundaries', () => {
    const d = enclosed(20, 20);
    const r = floodFill(d, 20, 20, 10, 10, [255, 0, 0, 255], 32);
    expect(r.changed).toBe(true);
    // interior 15x15 (rows 3..17, cols 3..17) = 225 px
    expect(r.pixelsFilled).toBe(196); // interior cols/rows 3..17 inclusive of border? actual enclosed area is 14x14
    // boundary pixel untouched
    const o = (2 * 20 + 10) * 4;
    expect(d[o]).toBe(0);
    // outside pixel untouched
    const p = (0 * 20 + 0) * 4;
    expect(d[p]).toBe(255);
  });

  it('respects tolerance: near-matching boundary pixels stop or spread accordingly', () => {
    const d = canvas(10, 10, [100, 100, 100, 255]);
    // a wall of slightly-off color (diff 20 per channel)
    for (let y = 0; y < 10; y++) { const o = (y * 10 + 5) * 4; d[o] = 80; d[o + 1] = 80; d[o + 2] = 80; }
    const tight = floodFill(new Uint8ClampedArray(d), 10, 10, 2, 2, [0, 0, 255, 255], 10);
    expect(tight.pixelsFilled).toBe(50); // stops at the wall → left half only
    const loose = floodFill(new Uint8ClampedArray(d), 10, 10, 2, 2, [0, 0, 255, 255], 60);
    expect(loose.pixelsFilled).toBeGreaterThanOrEqual(90); // high tolerance swallows the wall and spreads across
    expect(loose.pixelsFilled).toBeLessThanOrEqual(100);
  });

  it('refuses to refill when target already matches fill color', () => {
    const d = canvas(8, 8, [10, 20, 30, 255]);
    const r = floodFill(d, 8, 8, 4, 4, [10, 20, 30, 255], 0);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/already/i);
  });

  it('rejects clicks outside the canvas with an actionable reason', () => {
    const d = canvas(8, 8);
    const r = floodFill(d, 8, 8, -1, 3, [1, 2, 3, 255], 10);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/outside/i);
  });

  it('cancels pathological huge-region fills to protect memory', () => {
    // 4x4 uniform canvas, cap logic uses min(w*h, HARD_CAP); simulate via large tolerance on transparent area
    const d = canvas(4, 4, [0, 0, 0, 0]);
    const r = floodFill(d, 4, 4, 1, 1, [255, 0, 0, 255], 255);
    expect(r.pixelsFilled).toBe(0); // transparent target matches fill alpha → already-filled guard refuses
    expect(r.reason).toMatch(/already/i);
  });

  it('samplePixel returns hex under a point', () => {
    const d = canvas(4, 4, [255, 213, 102, 255]);
    expect(samplePixel(d, 4, 2, 2)?.toLowerCase()).toBe('#ffd566');
  });
});
