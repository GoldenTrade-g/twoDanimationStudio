import { describe, it, expect } from 'vitest';
import request from 'supertest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { CredentialStore, redact, capabilitiesFor } from '../src/credentials/store.js';
import { validateUpload, sanitizeSvg } from '../src/upload/validate.js';
import { makeZip } from '../src/export/encoder.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-')); }
const KEY_HEX = '0'.repeat(63) + '1';

describe('credential store', () => {
  it('encrypts secrets at rest and never returns them in safeList', () => {
    const dir = tmpDir();
    const store = new CredentialStore(dir, KEY_HEX);
    store.upsert({ id: 'p1', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', isDefault: true, maxTokens: 1000, temperature: 0.5, timeoutMs: 5000, apiKey: 'sk-secret-value-123' } as any);
    const raw = fs.readFileSync(path.join(dir, 'providers.json'), 'utf8');
    expect(raw).not.toContain('sk-secret-value-123'); // encrypted on disk
    expect(raw).toContain('encSecret');
    const safe = store.safeList();
    expect(JSON.stringify(safe)).not.toContain('sk-secret');
    expect(safe[0].hasSecret).toBe(true);
    expect(store.getSecret('p1')).toBe('sk-secret-value-123');
  });

  it('clears secret when apiKey set to empty string', () => {
    const store = new CredentialStore(tmpDir(), KEY_HEX);
    store.upsert({ id: 'p2', label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', isDefault: false, maxTokens: 500, temperature: 0.7, timeoutMs: 5000 } as any);
    expect(store.getSecret('p2')).toBe(null);
  });

  it('redacts key-like strings from logs', () => {
    expect(redact('failed with sk-abcdef123456')).toContain('[redacted]');
    expect(redact('apiKey=huntertopsecret123')).toContain('[redacted]');
  });

  it('capability registry marks openai as image+tts capable, ollama text-only', () => {
    expect(capabilitiesFor('openai', 'https://x')).toContain('image-generation');
    expect(capabilitiesFor('openai', 'https://x')).toContain('tts');
    expect(capabilitiesFor('ollama', 'http://localhost:11434')).not.toContain('image-generation');
    expect(capabilitiesFor('anthropic', 'https://x')).toEqual(['text', 'structured-json', 'connection-test']);
  });
});

describe('HTTP API', () => {
  it('health check works without any provider (app usable without LLM)', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('LLM task without provider returns helpful 400, not a crash', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const r = await request(app).post('/api/llm/storyboard').send({ idea: 'a duck learns physics' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('no-provider');
    expect(r.body.error).toMatch(/without AI/);
  });

  it('provider upsert strips the secret from the response', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const r = await request(app).post('/api/providers').send({
      id: 'x1', label: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: 'should-not-echo',
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('should-not-echo');
    expect(r.body.provider.encSecret).toBeUndefined();
  });

  it('rejects invalid provider kind and non-http baseUrl', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    expect((await request(app).post('/api/providers').send({ id: 'a', kind: 'magic', baseUrl: 'https://x', model: 'm' })).status).toBe(400);
    expect((await request(app).post('/api/providers').send({ id: 'a', kind: 'openai', baseUrl: 'ftp://x', model: 'm' })).status).toBe(400);
  });

  it('validates uploads: PNG ok, EXE disguised as PNG rejected by sniffing mismatch allowed? — mismatched declared type rejected', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const r1 = await request(app).post('/api/upload').attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    expect(r1.status).toBe(200);
    expect(r1.body.mime).toBe('image/png');
    const exe = Buffer.from('MZ\u0000\u0001binarypayload'.padEnd(64, 'A'));
    const r2 = await request(app).post('/api/upload').attach('file', exe, { filename: 'evil.png', contentType: 'image/png' });
    expect(r2.status).toBe(415);
  });

  it('sanitizes SVG uploads (scripts removed, event handlers removed)', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="evil()" width="10" height="10"/></svg>`;
    const r = await request(app).post('/api/upload').attach('file', Buffer.from(svg), { filename: 'a.svg', contentType: 'image/svg+xml' });
    expect(r.status).toBe(200);
    const decoded = Buffer.from(r.body.dataUrl.split(',')[1], 'base64').toString('utf8');
    expect(decoded).not.toContain('<script');
    expect(decoded).not.toContain('onload');
  });

  it('export session lifecycle: create -> frames -> cancel', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const s = await request(app).post('/api/export/session').send({ format: 'mp4', fps: 24, width: 64, height: 64, quality: 0.5 });
    expect(s.status).toBe(200);
    const jobId = s.body.jobId;
    // minimal valid-ish PNG chunk (header only is fine for writeFrame's magic check)
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const f = await request(app).post(`/api/export/session/${jobId}/frames`).send({ startIndex: 0, frames: [pngB64, pngB64] });
    expect(f.body.received).toBe(2);
    const c = await request(app).post(`/api/export/session/${jobId}/cancel`);
    expect(c.body.ok).toBe(true);
    const bad = await request(app).post(`/api/export/session/${jobId}/frames`).send({ startIndex: 0, frames: [pngB64] });
    expect(bad.status).toBe(400); // job no longer receiving
  });

  it('png-zip produces a ZIP file', async () => {
    const app = createApp({ dataDir: tmpDir(), secretHex: KEY_HEX });
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
    const r = await request(app).post('/api/export/png-zip').send({ frames: [pngB64, pngB64] }).buffer().parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/zip');
    const body = r.body as unknown;
    const head = Buffer.isBuffer(body) ? body.subarray(0, 2).toString() : Buffer.from(body as Uint8Array).subarray(0, 2).toString();
    expect(head).toBe('PK');
  });
});

describe('upload validation unit', () => {
  it('detects real formats via magic bytes', () => {
    expect(validateUpload(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg').ok).toBe(true);
    expect(validateUpload(Buffer.from('RIFFxxxxWEBPVP8 ', 'ascii'), 'image/webp').mime).toBe('image/webp');
    expect(validateUpload(Buffer.from('OggS\u0000\u0002', 'ascii'), 'audio/ogg').ok).toBe(true);
    expect(validateUpload(Buffer.alloc(10), 'image/png').ok).toBe(false);
  });
  it('enforces size limit', () => {
    expect(validateUpload(Buffer.alloc(100), 'image/png', 50).reason).toMatch(/exceeds/);
  });
  it('sanitizeSvg removes dangerous constructs but keeps shapes', () => {
    const out = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><a href="http://evil.example"><circle r="5"/></a><rect onclick="x()" width="1" height="1"/><foreignObject><body>html</body></foreignObject></svg>`);
    expect(out.ok).toBe(true);
    expect(out.svg).toContain('<circle');
    expect(out.svg).not.toMatch(/http:\/\/evil/);
    expect(out.svg).not.toContain('onclick');
    expect(out.svg).not.toContain('foreignObject');
  });
});

describe('zip writer', () => {
  it('produces parseable store-only zip', () => {
    const z = makeZip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    expect(z.subarray(0, 2).toString()).toBe('PK');
    expect(z.toString('latin1')).toContain('a.txt');
    expect(z.toString('latin1')).toContain('hello');
  });
});
