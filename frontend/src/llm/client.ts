/**
 * Browser client for the backend LLM proxy. No API secrets ever touch the browser:
 * the server stores encrypted credentials and proxies provider calls.
 */
import type { SafeProviderInfo, StoryboardResult, AnimationPlanResult } from '@studio/shared';

export class ApiError extends Error {
  status: number;
  kind?: string;
  constructor(message: string, status: number, kind?: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let msg = `Request failed (${res.status}).`;
    let kind: string | undefined;
    try {
      const j = (ct.includes('json') ? await res.json() : { error: await res.text() }) as { error?: string; kind?: string };
      msg = j.error ?? msg;
      kind = j.kind;
    } catch { /* keep default message */ }
    throw new ApiError(msg, res.status, kind);
  }
  if (ct.includes('json')) return (await res.json()) as T;
  throw new ApiError('Unexpected non-JSON response.', res.status);
}

export interface ProviderDraft {
  id: string;
  label: string;
  kind: string;
  baseUrl: string;
  model: string;
  apiKey?: string;      // sent once to the server; never echoed back
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  isDefault?: boolean;
}

export const api = {
  health: () => req<{ ok: boolean }>('/api/health'),
  listProviders: () => req<SafeProviderInfo[]>('/api/providers'),
  saveProvider: (d: ProviderDraft) => req<{ ok: boolean; provider: SafeProviderInfo }>('/api/providers', { method: 'POST', json: d }),
  deleteProvider: (id: string) => req<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setDefault: (providerId: string) => req<{ ok: boolean }>('/api/providers/default', { method: 'POST', json: { providerId } }),
  testProvider: (providerId: string) => req<{ ok: boolean; message: string; sample?: string }>('/api/providers/test', { method: 'POST', json: { providerId } }),

  storyboard: (body: { idea: string; style?: string; language?: string; targetDurationSec?: number; numScenes?: number; aspect?: string; providerId?: string; systemOverride?: string }) =>
    req<StoryboardResult>('/api/llm/storyboard', { method: 'POST', json: body }),
  script: (body: { idea: string; providerId?: string }) => req<unknown>('/api/llm/script', { method: 'POST', json: body }),
  ideas: (body: { topic: string; providerId?: string }) => req<{ ideas: string[] } | unknown>('/api/llm/ideas', { method: 'POST', json: body }),
  animationPlan: (body: { sceneDescription: string; objects: { id: string; name: string; kind: string }[]; durationSec: number; sceneId: string; providerId?: string; systemOverride?: string }) =>
    req<AnimationPlanResult>('/api/llm/animation-plan', { method: 'POST', json: body }),
  coach: (body: { summary: string; providerId?: string }) => req<{ steps?: string[]; message?: string } | unknown>('/api/llm/coach', { method: 'POST', json: body }),
  palette: (body: { style: string; providerId?: string }) => req<{ palettes?: { name: string; colors: string[] }[] } | unknown>('/api/llm/palette', { method: 'POST', json: body }),
  fixScene: (body: { summary: string; providerId?: string }) => req<unknown>('/api/llm/fix-scene', { method: 'POST', json: body }),
  image: (body: { prompt: string; size?: string; providerId?: string }) => req<{ dataUrl: string; note: string }>('/api/llm/image', { method: 'POST', json: body }),
  tts: (body: { text: string; voice?: string; providerId?: string }) => req<{ dataUrl: string }>('/api/llm/tts', { method: 'POST', json: body }),

  ffmpegStatus: () => req<{ ok: boolean; version?: string; error?: string }>('/api/export/ffmpeg-status'),
  createSession: (body: { format: 'mp4' | 'gif'; fps: number; width: number; height: number; quality: number }) =>
    req<{ jobId: string }>('/api/export/session', { method: 'POST', json: body }),
  sendFrames: (jobId: string, startIndex: number, frames: string[]) =>
    req<{ ok: boolean; received: number }>(`/api/export/session/${jobId}/frames`, { method: 'POST', json: { startIndex, frames } }),
  finalize: async (jobId: string, audio: unknown[]): Promise<Blob> => {
    const res = await fetch(`/api/export/session/${jobId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio }),
    });
    if (!res.ok) {
      let msg = 'Finalize failed.';
      try { msg = ((await res.json()) as { error: string }).error ?? msg; } catch { /* ignore */ }
      throw new ApiError(msg, res.status);
    }
    return await res.blob();
  },
  cancelSession: (jobId: string) => req<{ ok: boolean }>(`/api/export/session/${jobId}/cancel`, { method: 'POST' }),
  pngZip: async (frames: string[]): Promise<Blob> => {
    const res = await fetch('/api/export/png-zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frames }) });
    if (!res.ok) {
      let msg = 'ZIP failed.';
      try { msg = ((await res.json()) as { error: string }).error ?? msg; } catch { /* ignore */ }
      throw new ApiError(msg, res.status);
    }
    return await res.blob();
  },
  upload: async (file: File): Promise<{ ok: boolean; mime: string; dataUrl: string; bytes: number }> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      let msg = 'Upload rejected.';
      try { msg = ((await res.json()) as { error: string }).error ?? msg; } catch { /* ignore */ }
      throw new ApiError(msg, res.status);
    }
    return (await res.json()) as { ok: boolean; mime: string; dataUrl: string; bytes: number };
  },
};
