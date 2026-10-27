/**
 * Express app factory. Exported separately from listen() so tests can use supertest.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialStore, redact } from './credentials/store.js';
import { generateText, generateStructured, testConnection, generateImage, textToSpeech, LLMError } from './llm/adapter.js';
import { STORYBOARD_SYSTEM, storyboardUserPrompt, ANIMATION_PLAN_SYSTEM, animationPlanUserPrompt, SCRIPT_SYSTEM, IDEAS_SYSTEM, FIX_SCENE_SYSTEM, COACH_SYSTEM, palettePrompt } from './llm/prompts.js';
import { checkFfmpeg, createJob, getJob, writeFrame, finalize, cancelJob, cleanupJob, makeZip, type AudioManifestItem } from './export/encoder.js';
import { validateUpload, sanitizeSvg, DEFAULT_MAX_BYTES } from './upload/validate.js';

export interface AppOptions { dataDir?: string; secretHex?: string; }

export function createApp(opts: AppOptions = {}) {
  const app = express();
  const store = new CredentialStore(opts.dataDir ?? process.env.STUDIO_DATA_DIR ?? './backend/data', opts.secretHex ?? process.env.STUDIO_SECRET_KEY);
  app.use(express.json({ limit: '64mb' })); // frame chunks & audio data URLs are large but bounded

  // CORS for local dev (frontend on vite port)
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', req.headers.origin?.startsWith('http://localhost') ? String(req.headers.origin) : 'http://localhost:5173');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_BYTES) } });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'animation-studio-backend' }));

  // ---------- Providers ----------
  app.get('/api/providers', (_req, res) => res.json(store.safeList()));

  app.post('/api/providers', (req, res) => {
    const b = req.body ?? {};
    if (!b.id || !b.kind || !b.baseUrl || !b.model) return res.status(400).json({ error: 'id, kind, baseUrl and model are required.' });
    const kinds = ['openai', 'anthropic', 'gemini', 'ollama', 'llama-server', 'custom-http'];
    if (!kinds.includes(b.kind)) return res.status(400).json({ error: 'Unknown provider kind.' });
    if (!/^https?:\/\//i.test(String(b.baseUrl))) return res.status(400).json({ error: 'baseUrl must be http(s).' });
    const p = store.upsert({ ...b, maxTokens: Number(b.maxTokens) || 1500, temperature: Number(b.temperature ?? 0.7), timeoutMs: Number(b.timeoutMs) || 60000 });
    res.json({ ok: true, provider: safe(p) });
  });

  app.delete('/api/providers/:id', (req, res) => {
    const removed = store.remove(req.params.id);
    res.json({ ok: removed });
  });

  app.post('/api/providers/default', (req, res) => {
    res.json({ ok: store.setDefault(String(req.body?.providerId ?? '')) });
  });

  app.post('/api/providers/test', async (req, res) => {
    const p = store.get(String(req.body?.providerId ?? ''));
    if (!p) return res.status(404).json({ error: 'Provider not found. Save it first.' });
    const result = await testConnection(p, store.getSecret(p.id));
    res.json(result);
  });

  function safe(p: any) { const { encSecret, ...rest } = p; return rest; }

  // ---------- LLM tasks ----------
  async function withProvider(reqBody: any, handler: (p: any, key: string | null) => Promise<any>, res: any) {
    try {
      let p = reqBody?.providerId ? store.get(reqBody.providerId) : store.safeList().find(x => x.isDefault);
      if (!p && store.safeList().length === 1) p = store.safeList()[0];
      if (!p) return res.status(400).json({ error: 'No LLM provider configured or selected. All studio features still work without AI — configure one in Settings to use this helper.', code: 'no-provider' });
      const stored = store.get(p.id)!;
      const out = await handler(stored, store.getSecret(stored.id));
      res.json(out);
    } catch (e: any) {
      const status = e instanceof LLMError ? (e.kind === 'auth' ? 401 : e.kind === 'rate-limit' ? 429 : 502) : 500;
      console.error('[llm]', redact(String(e?.message ?? e)));
      res.status(status).json({ error: e instanceof LLMError ? e.message : 'Unexpected server error talking to the provider.', kind: e instanceof LLMError ? e.kind : 'unknown' });
    }
  }

  app.post('/api/llm/storyboard', (req, res) => withProvider(req.body, async (p, key) => {
    const { idea, style = 'flat cartoon', language = 'en', targetDurationSec = 30, numScenes = 6, aspect = '16:9', systemOverride } = req.body ?? {};
    if (!idea || typeof idea !== 'string') throw new LLMError('Missing "idea" text.', 0, 'bad-request', false);
    const r = await generateStructured(p, key, {
      providerId: p.id, task: 'storyboard',
      system: systemOverride || STORYBOARD_SYSTEM,
      prompt: storyboardUserPrompt(idea, { style, language, targetDurationSec: Number(targetDurationSec) || 30, numScenes: Number(numScenes) || 6, aspect }),
    });
    return r.data;
  }, res));

  app.post('/api/llm/animation-plan', (req, res) => withProvider(req.body, async (p, key) => {
    const { sceneDescription, objects, durationSec = 4, sceneId = '', systemOverride } = req.body ?? {};
    if (!Array.isArray(objects)) throw new LLMError('Missing objects list.', 0, 'bad-request', false);
    const r = await generateStructured(p, key, {
      providerId: p.id, task: 'animation-plan', sceneId,
      system: systemOverride || ANIMATION_PLAN_SYSTEM,
      prompt: animationPlanUserPrompt(String(sceneDescription ?? ''), objects, Number(durationSec) || 4),
    });
    return r.data;
  }, res));

  app.post('/api/llm/script', (req, res) => withProvider(req.body, async (p, key) => {
    const r = await generateStructured(p, key, { providerId: p.id, task: 'script', system: SCRIPT_SYSTEM, prompt: `Expand this idea into a short script JSON:\n${String(req.body?.idea ?? '').slice(0, 4000)}` });
    return r.data;
  }, res));

  app.post('/api/llm/ideas', (req, res) => withProvider(req.body, async (p, key) => {
    const r = await generateStructured(p, key, { providerId: p.id, task: 'ideas', system: IDEAS_SYSTEM, prompt: `Give me 5 short-animation ideas about: ${String(req.body?.topic ?? 'friendship').slice(0, 500)}` });
    return r.data;
  }, res));

  app.post('/api/llm/fix-scene', (req, res) => withProvider(req.body, async (p, key) => {
    const r = await generateStructured(p, key, { providerId: p.id, task: 'free', system: FIX_SCENE_SYSTEM, prompt: `Scene state summary:\n${String(req.body?.summary ?? '').slice(0, 6000)}` });
    return r.data;
  }, res));

  app.post('/api/llm/coach', (req, res) => withProvider(req.body, async (p, key) => {
    const r = await generateStructured(p, key, { providerId: p.id, task: 'free', system: COACH_SYSTEM, prompt: `Project summary:\n${String(req.body?.summary ?? '').slice(0, 4000)}` });
    return r.data;
  }, res));

  app.post('/api/llm/palette', (req, res) => withProvider(req.body, async (p, key) => {
    const r = await generateStructured(p, key, { providerId: p.id, task: 'free', system: 'Respond with ONLY valid JSON as specified by the user.', prompt: palettePrompt(String(req.body?.style ?? 'flat cartoon')) });
    return r.data;
  }, res));

  app.post('/api/llm/image', (req, res) => withProvider(req.body, async (p, key) => {
    const dataUrl = await generateImage(p, key, String(req.body?.prompt ?? '').slice(0, 2000), String(req.body?.size ?? '1024x1024'));
    return { dataUrl, note: 'Generated image is a flattened raster bitmap. It is editable as an image layer (move/scale/crop/trace), NOT an auto-vectorized character.' };
  }, res));

  app.post('/api/llm/tts', (req, res) => withProvider(req.body, async (p, key) => {
    const dataUrl = await textToSpeech(p, key, String(req.body?.text ?? ''), String(req.body?.voice ?? 'alloy'));
    return { dataUrl };
  }, res));

  // ---------- Upload validation ----------
  app.post('/api/upload', upload.single('file'), (req, res) => {
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'No file part received (multipart field "file").' });
    const check = validateUpload(file.buffer, file.mimetype, Number(process.env.MAX_UPLOAD_BYTES ?? DEFAULT_MAX_BYTES));
    if (!check.ok) return res.status(415).json({ error: check.reason });
    if (check.mime === 'image/svg+xml') {
      const s = sanitizeSvg(file.buffer.toString('utf8'));
      if (!s.ok) return res.status(415).json({ error: s.reason });
      const b64 = Buffer.from(s.svg!, 'utf8').toString('base64');
      return res.json({ ok: true, mime: 'image/svg+xml', sanitized: true, dataUrl: `data:image/svg+xml;base64,${b64}`, bytes: file.buffer.length });
    }
    const b64 = file.buffer.toString('base64');
    res.json({ ok: true, mime: check.mime, dataUrl: `data:${check.mime};base64,${b64}`, bytes: file.buffer.length });
  });

  // ---------- Export ----------
  app.get('/api/export/ffmpeg-status', async (_req, res) => res.json(await checkFfmpeg()));

  app.post('/api/export/session', (req, res) => {
    const { format, fps, width, height, quality } = req.body ?? {};
    if (!['mp4', 'gif'].includes(format)) return res.status(400).json({ error: 'format must be mp4 or gif' });
    const job = createJob({ format, fps: Number(fps) || 24, width: Number(width) || 1280, height: Number(height) || 720, quality: Math.min(1, Math.max(0, Number(quality ?? 0.7))) });
    res.json({ jobId: job.id });
  });

  app.post('/api/export/session/:id/frames', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Unknown export session.' });
    const { startIndex, frames } = req.body ?? {};
    if (!Array.isArray(frames)) return res.status(400).json({ error: 'frames must be an array of base64 PNG strings' });
    try {
      frames.forEach((f: string, i: number) => writeFrame(job, Number(startIndex) + i, f));
      res.json({ ok: true, received: job.frameCount });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/export/session/:id/finalize', async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Unknown export session.' });
    try {
      const audio = (req.body?.audio ?? []) as AudioManifestItem[];
      const { outputFile } = await finalize(job.id, audio);
      const data = fs.readFileSync(outputFile);
      res.setHeader('content-type', job.format === 'mp4' ? 'video/mp4' : 'image/gif');
      res.setHeader('content-disposition', `attachment; filename="animation.${job.format}"`);
      res.send(data);
    } catch (e: any) {
      console.error('[export]', redact(String(e?.message)));
      res.status(500).json({ error: String(e?.message ?? 'Export failed.') });
    } finally {
      setTimeout(() => cleanupJob(job.id), 30_000);
    }
  });

  app.post('/api/export/session/:id/cancel', (req, res) => {
    res.json({ ok: cancelJob(req.params.id) });
  });

  // PNG sequence zip passthrough (client renders frames; server just zips — reliable & fast)
  app.post('/api/export/png-zip', (req, res) => {
    const { frames } = req.body ?? {};
    if (!Array.isArray(frames) || frames.length === 0) return res.status(400).json({ error: 'No frames provided.' });
    try {
      const entries = frames.map((b64: string, i: number) => ({
        name: `frame${String(i).padStart(6, '0')}.png`,
        data: Buffer.from(String(b64).replace(/^data:image\/png;base64,/, ''), 'base64'),
      }));
      const zip = makeZip(entries);
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', 'attachment; filename="frames.zip"');
      res.send(zip);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Error handler: never leak stack/secrets
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('[server-error]', redact(String(err?.message ?? err)));
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
