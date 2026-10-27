/**
 * Flood-fill ("paint bucket") on ImageData with color tolerance.
 * Scanline-based BFS with a visited-pixel guard so pathological images can't eat memory.
 */
export interface FillResult { changed: boolean; pixelsFilled: number; reason?: string; }

const MAX_VISITED_FACTOR = 1.0; // never visit more than width*height pixels anyway; hard cap below:
const HARD_CAP = 4_000_000;

export function floodFill(
  data: Uint8ClampedArray, // RGBA
  width: number,
  height: number,
  x: number,
  y: number,
  fillColor: [number, number, number, number], // rgba 0..255, a 0..255
  tolerance: number, // 0..255 per-channel-ish distance threshold
): FillResult {
  if (x < 0 || y < 0 || x >= width || y >= height) return { changed: false, pixelsFilled: 0, reason: 'Click outside canvas.' };
  const idx = (x + y * width) * 4;
  const target = [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
  const tol2 = tolerance * tolerance * 4;

  // If target color equals fill color, nothing to do (prevents "fill entire canvas" loops).
  if (colorDist2(target, fillColor) <= tol2) {
    return { changed: false, pixelsFilled: 0, reason: 'That area already has this color (or tolerance is too high).' };
  }

  const visited = new Uint8Array(width * height);
  let visitedCount = 0;
  const cap = Math.min(width * height, HARD_CAP);
  const stack: number[] = [x + y * width];
  let filled = 0;

  const match = (p: number): boolean => {
    const o = p * 4;
    return colorDist2([data[o], data[o + 1], data[o + 2], data[o + 3]], target) <= tol2;
  };

  while (stack.length > 0) {
    const p = stack.pop()!;
    if (visited[p]) continue;
    if (!match(p)) continue; // boundary: edges of enclosed region stop spread
    visited[p] = 1;
    visitedCount++;
    if (visitedCount > cap) {
      return { changed: false, pixelsFilled: 0, reason: 'Region too large — fill cancelled to protect memory. Increase stroke boundaries or lower tolerance.' };
    }
    const o = p * 4;
    // Blend alpha: fully overwrite
    data[o] = fillColor[0]; data[o + 1] = fillColor[1]; data[o + 2] = fillColor[2]; data[o + 3] = fillColor[3];
    filled++;
    const px = p % width, py = (p - px) / width;
    if (px > 0) stack.push(p - 1);
    if (px < width - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - width);
    if (py < height - 1) stack.push(p + width);
  }
  return { changed: filled > 0, pixelsFilled: filled };
}

function colorDist2(a: number[], b: number[]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2], da = a[3] - b[3];
  return dr * dr + dg * dg + db * db + da * da;
}

/** Sample pixel color under a point (for eyedropper). Returns hex or null. */
export function samplePixel(data: Uint8ClampedArray, width: number, x: number, y: number): string | null {
  if (x < 0 || y < 0 || x >= width || y * width >= data.length / 4) return null;
  const o = (x + y * width) * 4;
  const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
  if (a === 0) return null;
  const to = (v: number) => v.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
