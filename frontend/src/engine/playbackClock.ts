/**
 * Playback clock decoupled from requestAnimationFrame scheduling.
 * Time advances from monotonic performance.now() deltas scaled by playbackSpeed,
 * so dropped frames never desynchronize animation time. Pure logic → testable.
 */
export interface ClockState {
  playing: boolean;
  time: number;        // seconds within scene
  speed: number;
  loop: boolean;
  duration: number;    // scene duration
}

export type TickResult = { time: number; ended: boolean; wrapped: boolean };

/** Advance a clock by a real-time delta. Deterministic given (state, dt). */
export function tick(state: ClockState, dtMs: number): TickResult {
  if (!state.playing) return { time: state.time, ended: false, wrapped: false };
  let t = state.time + (dtMs / 1000) * state.speed;
  let wrapped = false;
  let ended = false;
  if (t >= state.duration) {
    if (state.loop) { t = t % state.duration; wrapped = true; }
    else { t = state.duration; ended = true; }
  }
  if (t < 0) t = state.loop ? state.duration - ((-t) % state.duration || state.duration) : 0;
  return { time: t, ended, wrapped };
}

/** rAF driver that feeds deltas into tick(); used by Stage/Timeline UI. */
export class PlaybackDriver {
  private raf = 0;
  private last = 0;
  constructor(
    private getState: () => ClockState,
    private onTime: (t: number, ended: boolean) => void,
  ) {}

  start(): void {
    this.stop();
    this.last = performance.now();
    const step = (now: number) => {
      const dt = now - this.last;
      this.last = now;
      const st = this.getState();
      const r = tick(st, dt);
      if (r.time !== st.time || r.ended) this.onTime(r.time, r.ended);
      if (!r.ended && this.getState().playing) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
