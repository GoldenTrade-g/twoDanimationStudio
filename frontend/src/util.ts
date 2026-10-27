/** Small utilities shared across the frontend. */

let counter = 0;
/** Stable, collision-resistant IDs (no crypto dependency, works in tests). */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 46656; // wrap
  const rand = Math.floor(Math.random() * 46656).toString(36);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

export function hexToRgba(hex: string, a = 1): { r: number; g: number; b: number; a: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
}

export function rgbaToCss(c: { r: number; g: number; b: number; a: number } | null): string {
  if (!c) return 'transparent';
  return `rgba(${c.r},${c.g},${c.b},${c.a})`;
}

export function rgbaToHex(c: { r: number; g: number; b: number }): string {
  const to = (x: number) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
