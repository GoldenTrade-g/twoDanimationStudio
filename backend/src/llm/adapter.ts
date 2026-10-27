/**
 * Provider-neutral LLM adapter.
 * One internal interface (generateText / generateJSON / testConnection / tts / image) with
 * per-kind implementations for OpenAI-compatible APIs, Anthropic, Gemini, Ollama, llama-server,
 * and custom HTTP endpoints. Handles timeouts, retries with backoff on 429/5xx, malformed JSON,
 * and maps provider errors to safe, user-facing messages (never leaking secrets).
 */
import type { StoredProvider } from '../credentials/store.js';
import { parseJsonLoose, validateStoryboardResult, validateAnimationPlanResult } from '../../../shared/src/schema.js';

export class LLMError extends Error {
  status: number; kind: 'rate-limit' | 'timeout' | 'auth' | 'bad-request' | 'unavailable' | 'parse' | 'network' | 'unknown';
  retryable: boolean;
  constructor(message: string, status = 0, kind: LLMError['kind'] = 'unknown', retryable = false) {
    super(message); this.name = 'LLMError'; this.status = status; this.kind = kind; this.retryable = retryable;
  }
}

export interface ChatRequest {
  providerId: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** If set, response is validated against this structured task schema after parsing. */
  task?: 'storyboard' | 'animation-plan' | 'script' | 'ideas' | 'free';
  sceneId?: string; // for animation-plan validation context
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 60_000;

function timeoutMs(p: StoredProvider): number { return p.timeoutMs > 0 ? p.timeoutMs : DEFAULT_TIMEOUT; }

async function fetchWithTimeout(url: string, init: RequestInit, ms: number, outer?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const onOuter = () => ctrl.abort();
  outer?.addEventListener('abort', onOuter);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (outer?.aborted) throw new LLMError('Request cancelled by user.', 0, 'unknown', false);
    if (e?.name === 'AbortError') throw new LLMError(`Provider request timed out after ${Math.round(ms / 1000)}s.`, 0, 'timeout', true);
    throw new LLMError(`Network error reaching provider: ${e?.message ?? e}`, 0, 'network', true);
  } finally {
    clearTimeout(t);
    outer?.removeEventListener('abort', onOuter);
  }
}

function mapHttpError(status: number, bodyText: string): LLMError {
  // Never include the raw body if it might echo credentials; truncate aggressively.
  const snippet = bodyText.slice(0, 300).replace(/[\r\n]+/g, ' ');
  if (status === 429) return new LLMError('Rate limited by provider (429). Retry in a moment.', 429, 'rate-limit', true);
  if (status === 401 || status === 403) return new LLMError('Authentication failed — check the API key configured on the server.', status, 'auth', false);
  if (status >= 500) return new LLMError(`Provider unavailable (${status}).`, status, 'unavailable', true);
  return new LLMError(`Provider returned ${status}: ${snippet}`, status, 'bad-request', false);
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 700): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const retryable = e instanceof LLMError ? e.retryable : RETRYABLE_STATUSES.has(e?.status ?? 0);
      if (!retryable || i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---------- Per-provider request builders ----------
interface BuiltCall { url: string; headers: Record<string, string>; body: object; extract(res: any): string; }

function buildCall(p: StoredProvider, apiKey: string | null, system: string, prompt: string, maxTokens: number, temperature: number): BuiltCall {
  const base = p.baseUrl.replace(/\/+$/, '');
  switch (p.kind) {
    case 'openai':
    case 'llama-server':
    case 'custom-http': {
      // llama-server & custom-http use the OpenAI-compatible surface when supported.
      return {
        url: `${base}/chat/completions`,
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: { model: p.model, max_tokens: maxTokens, temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
        extract: (res) => res.choices?.[0]?.message?.content ?? '',
      };
    }
    case 'ollama': {
      return {
        url: `${base}/api/chat`,
        headers: { 'content-type': 'application/json' },
        body: { model: p.model, stream: false, options: { temperature, num_predict: maxTokens }, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
        extract: (res) => res.message?.content ?? '',
      };
    }
    case 'anthropic': {
      return {
        url: `${base}/v1/messages`,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' },
        body: { model: p.model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: prompt }] },
        extract: (res) => (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
      };
    }
    case 'gemini': {
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(apiKey ?? '')}`,
        headers: { 'content-type': 'application/json' },
        body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } },
        extract: (res) => (res.candidates?.[0]?.content?.parts ?? []).map((x: any) => x.text ?? '').join(''),
      };
    }
  }
}

// ---------- Core generate ----------
export async function generateText(p: StoredProvider, apiKey: string | null, req: ChatRequest): Promise<string> {
  const call = buildCall(p, apiKey, req.system ?? 'You are a helpful assistant for a 2D animation studio.', req.prompt,
    req.maxTokens ?? p.maxTokens ?? 1200, req.temperature ?? p.temperature ?? 0.7);
  return withRetry(async () => {
    const res = await fetchWithTimeout(call.url, { method: 'POST', headers: call.headers, body: JSON.stringify(call.body) }, timeoutMs(p), req.signal);
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
    const json: any = await res.json();
    const text = call.extract(json);
    if (typeof text !== 'string' || !text.trim()) {
      throw new LLMError('Provider returned an empty response.', 0, 'parse', true);
    }
    return text;
  });
}

export interface JsonResult { text: string; data: unknown | null; }

export async function generateJSON(p: StoredProvider, apiKey: string | null, req: ChatRequest): Promise<JsonResult> {
  const text = await generateText(p, apiKey, req);
  const data = parseJsonLoose(text);
  if (data === null) throw new LLMError('Model response was not valid JSON. Try again or lower temperature.', 0, 'parse', true);
  return { text, data };
}

/** Task-level API with schema validation of untrusted model output. */
export async function generateStructured(p: StoredProvider, apiKey: string | null, req: ChatRequest): Promise<{ data: unknown; issues: string[] }> {
  const { data } = await generateJSON(p, apiKey, req);
  if (req.task === 'storyboard') {
    const v = validateStoryboardResult(data);
    if (!v.ok) throw new LLMError('Storyboard JSON failed schema validation: ' + v.issues.join('; '), 0, 'parse', true);
    return { data: v.value, issues: [] };
  }
  if (req.task === 'animation-plan') {
    const v = validateAnimationPlanResult(data, req.sceneId ?? '');
    if (!v.ok) throw new LLMError('Animation plan JSON failed schema validation: ' + v.issues.join('; '), 0, 'parse', true);
    return { data: v.value, issues: v.issues };
  }
  return { data, issues: [] };
}

export async function testConnection(p: StoredProvider, apiKey: string | null): Promise<{ ok: boolean; message: string; sample?: string }> {
  try {
    const reply = await generateText(p, apiKey, {
      providerId: p.id, prompt: 'Reply with exactly: OK', maxTokens: 8, temperature: 0,
    });
    return { ok: true, message: 'Connection successful.', sample: reply.slice(0, 80) };
  } catch (e: any) {
    if (e instanceof LLMError) return { ok: false, message: e.message };
    return { ok: false, message: 'Connection test failed.' };
  }
}

// ---------- Optional capability adapters ----------
export async function generateImage(p: StoredProvider, apiKey: string | null, prompt: string, size = '1024x1024', signal?: AbortSignal): Promise<string /* data URL */> {
  if (!p.capabilities.includes('image-generation')) throw new LLMError(`Provider "${p.label}" does not support image generation.`, 0, 'bad-request', false);
  const base = p.baseUrl.replace(/\/+$/, '');
  return withRetry(async () => {
    let res: Response;
    if (p.kind === 'openai') {
      res = await fetchWithTimeout(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, size, response_format: 'b64_json' }),
      }, timeoutMs(p), signal);
      if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
      const j: any = await res.json();
      const b64 = j.data?.[0]?.b64_json;
      if (!b64) throw new LLMError('Image provider returned no data.', 0, 'parse', false);
      return `data:image/png;base64,${b64}`;
    }
    if (p.kind === 'gemini') {
      res = await fetchWithTimeout(`${base}/v1beta/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(apiKey ?? '')}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }, timeoutMs(p), signal);
      if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
      const j: any = await res.json();
      const part = (j.candidates?.[0]?.content?.parts ?? []).find((x: any) => x.inlineData);
      if (!part) throw new LLMError('Gemini returned no image inline data.', 0, 'parse', false);
      return `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}`;
    }
    throw new LLMError('Image generation not implemented for this provider kind.', 0, 'bad-request', false);
  });
}

export async function textToSpeech(p: StoredProvider, apiKey: string | null, text: string, voice = 'alloy', signal?: AbortSignal): Promise<string /* data URL */> {
  if (!p.capabilities.includes('tts')) throw new LLMError(`Provider "${p.label}" does not support speech generation.`, 0, 'bad-request', false);
  const base = p.baseUrl.replace(/\/+$/, '');
  return withRetry(async () => {
    const res = await fetchWithTimeout(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: 'tts-1', input: text.slice(0, 4000), voice, response_format: 'mp3' }),
    }, timeoutMs(p), signal);
    if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:audio/mpeg;base64,${buf.toString('base64')}`;
  });
}
