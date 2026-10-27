/** Vitest setup: fake IndexedDB (in-memory) + canvas 2D stubs so storage/renderer code runs in jsdom. */
import 'fake-indexeddb/auto';

// Minimal CanvasRenderingContext2D stub — enough for renderScene not to crash in tests.
if (typeof HTMLCanvasElement !== 'undefined') {
  const ctxStub = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop === 'canvas') return null;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      if (typeof prop === 'string' && !(prop in target)) {
        // property reads like fillStyle return undefined; method calls become no-ops
        target[prop] = (..._args: unknown[]) => undefined;
      }
      return target[prop];
    },
    set(target, prop: string, value) { target[prop] = value; return true; },
  });
  HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

export {};
