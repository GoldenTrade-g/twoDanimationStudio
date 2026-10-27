/**
 * Server-side provider credentials store.
 * - Secret API keys are AES-256-GCM encrypted at rest using STUDIO_SECRET_KEY (or an ephemeral key).
 * - Secrets NEVER leave the server: list/get responses strip them, logs redact them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProviderConfig, ProviderKind, LLMCapability } from '../../../shared/src/types.js';

export interface StoredProvider extends LLMProviderConfig {
  /** Encrypted secret blob (iv:tag:ciphertext hex) or null. Never returned to clients. */
  encSecret: string | null;
}

const REDACT = '[redacted]';

export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, REDACT)
    .replace(/(api[_-]?key|authorization|bearer|secret)(["'\s:=]+)[^\s"',}]{6,}/gi, `$1$2${REDACT}`);
}

export class CredentialStore {
  private key: Buffer;
  private file: string;
  private providers = new Map<string, StoredProvider>();

  constructor(dataDir: string, secretHex?: string) {
    this.file = path.join(dataDir, 'providers.json');
    if (secretHex && /^[0-9a-fA-F]{64}$/.test(secretHex)) {
      this.key = Buffer.from(secretHex, 'hex');
    } else {
      // Ephemeral key: stored secrets won't survive restarts; warn in logs (redacted).
      this.key = crypto.randomBytes(32);
      console.warn('[credentials] STUDIO_SECRET_KEY not set — stored API keys will not persist across restarts.');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.file)) {
        const arr = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoredProvider[];
        for (const p of arr) this.providers.set(p.id, p);
      }
    } catch (e) {
      console.error('[credentials] failed to load store:', redact(String(e)));
    }
  }

  private persist() {
    fs.writeFileSync(this.file, JSON.stringify([...this.providers.values()], null, 2), { mode: 0o600 });
  }

  encryptSecret(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':');
  }

  decryptSecret(blob: string): string {
    const [ivHex, tagHex, ctHex] = blob.split(':');
    if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed secret blob');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
  }

  getSecret(id: string): string | null {
    const p = this.providers.get(id);
    if (!p?.encSecret) return null;
    try { return this.decryptSecret(p.encSecret); } catch { return null; }
  }

  /** Client-safe view: no secret material, only hasSecret boolean. */
  safeList(): SafeProvider[] {
    return [...this.providers.values()].map(toSafe);
  }

  get(id: string): StoredProvider | undefined { return this.providers.get(id); }

  upsert(config: Omit<LLMProviderConfig, 'hasSecret'> & { apiKey?: string | null }): StoredProvider {
    const existing = this.providers.get(config.id);
    let encSecret = existing?.encSecret ?? null;
    if (config.apiKey === '' || config.apiKey === null) encSecret = null;
    else if (typeof config.apiKey === 'string' && config.apiKey.length > 0) encSecret = this.encryptSecret(config.apiKey);
    const { apiKey: _drop, ...rest } = config as any;
    const provider: StoredProvider = {
      ...(rest as LLMProviderConfig),
      capabilities: capabilitiesFor(rest.kind as ProviderKind, rest.baseUrl),
      hasSecret: !!encSecret,
      encSecret,
    };
    if (provider.isDefault) for (const p of this.providers.values()) p.isDefault = false;
    this.providers.set(provider.id, provider);
    this.persist();
    return provider;
  }

  remove(id: string): boolean {
    const had = this.providers.delete(id);
    if (had) this.persist();
    return had;
  }

  setDefault(id: string): boolean {
    const p = this.providers.get(id);
    if (!p) return false;
    for (const q of this.providers.values()) q.isDefault = q.id === id;
    this.persist();
    return true;
  }
}

export type SafeProvider = LLMProviderConfig;

export function toSafe(p: StoredProvider): SafeProvider {
  const { encSecret, ...safe } = p as any;
  return safe as SafeProvider;
}

/** Capability registry: what each provider kind can do out of the box. */
export function capabilitiesFor(kind: ProviderKind, baseUrl: string): LLMCapability[] {
  const caps: LLMCapability[] = ['text', 'structured-json', 'connection-test'];
  if (kind === 'openai') caps.push('image-generation', 'tts');
  if (kind === 'gemini') caps.push('image-generation');
  return caps;
}
