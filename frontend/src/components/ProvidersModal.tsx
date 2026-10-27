/** Provider settings modal: configure LLM providers (keys live ONLY on the server), test connections, set default. */
import { useEffect, useState } from 'react';
import type { SafeProviderInfo, LLMProviderConfig } from '@studio/shared';
import { api, ApiError, type ProviderDraft } from '../llm/client';

const KINDS = ['openai', 'anthropic', 'gemini', 'ollama', 'llama-server', 'custom-http'] as const;
const DEFAULT_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta', ollama: 'http://localhost:11434',
  'llama-server': 'http://localhost:8080', 'custom-http': '',
};
const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-4-20250514', gemini: 'gemini-2.0-flash',
  ollama: 'llama3.2', 'llama-server': 'local', 'custom-http': '',
};

export function ProvidersModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [providers, setProviders] = useState<SafeProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>({
    id: '', label: 'My Ollama', kind: 'ollama', baseUrl: DEFAULT_URL.ollama, model: DEFAULT_MODEL.ollama, apiKey: '',
  });

  const refresh = async (): Promise<void> => {
    try { setProviders(await api.listProviders()); setError(null); }
    catch (e) { setError(e instanceof ApiError ? `${e.message} — is the backend running? (npm run dev starts it on :8787)` : String(e)); }
  };
  useEffect(() => { void refresh(); }, []);

  const save = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const d: ProviderDraft = { ...draft, apiKey: draft.apiKey || undefined };
      await api.saveProvider(d);
      setDraft({ ...draft, apiKey: '' });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const test = async (p: LLMProviderConfig): Promise<void> => {
    setBusy(true); setError(null);
    try { const r = await api.testProvider(p.id); p.isDefault && r; alert(r.ok ? `✔ ${r.message}\nSample: ${r.sample ?? '—'}` : `✖ ${r.message}`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-label="LLM provider settings">
      <div className="modal" style={{ maxWidth: 680 }}>
        <div className="row"><h2 style={{ margin: 0 }} className="grow">AI Providers</h2>
          <button className="btn small" onClick={onClose} aria-label="Close">✕</button></div>
        <p className="muted">
          Optional — every studio feature works without AI. API keys are sent once to the local backend and stored encrypted there;
          they never enter the browser bundle, project files, or logs. Prompts/outputs are sent to the selected provider when you use AI features.
        </p>
        {error && <div className="chip bad" role="alert">{error}</div>}
        <table style={{ width: '100%', fontSize: 13 }}>
          <thead><tr><th>Label</th><th>Kind</th><th>Model</th><th>Capabilities</th><th>Key</th><th /></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td>{p.label}{p.isDefault && <span className="chip">default</span>}</td>
                <td>{p.kind}</td><td>{p.model}</td>
                <td>{p.capabilities.map((c) => <span key={c} className="chip" title={c}>{c}</span>)}</td>
                <td>{p.hasSecret ? '🔒 stored' : '—'}</td>
                <td className="row">
                  {!p.isDefault && <button className="btn small" disabled={busy} onClick={() => void api.setDefault(p.id).then(refresh)}>Set default</button>}
                  <button className="btn small" disabled={busy} onClick={() => void test(p)}>Test</button>
                  <button className="btn small danger" disabled={busy} aria-label={`Delete ${p.label}`}
                    onClick={() => { if (confirm(`Remove provider “${p.label}”? The stored key will be deleted.`)) void api.deleteProvider(p.id).then(refresh); }}>✕</button>
                </td>
              </tr>
            ))}
            {providers.length === 0 && !error && <tr><td colSpan={6} className="muted">No providers configured. Add one below, or run Ollama locally for a free private option.</td></tr>}
          </tbody>
        </table>
        <h3>Add / update provider</h3>
        <div className="row wrap" style={{ gap: 8 }}>
          <input placeholder="Label" value={draft.label} aria-label="Provider label" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <select value={draft.kind} aria-label="Provider kind" onChange={(e) => {
            const k = e.target.value as ProviderDraft['kind'];
            setDraft({ ...draft, kind: k, baseUrl: draft.baseUrl || DEFAULT_URL[k], model: draft.model || DEFAULT_MODEL[k] });
          }}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <input placeholder="Base URL" className="grow" style={{ minWidth: 220 }} value={draft.baseUrl} aria-label="Base URL" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          <input placeholder="Model" value={draft.model} aria-label="Model name" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          <input type="password" placeholder="API key (optional, stored server-side)" value={draft.apiKey ?? ''} aria-label="API key"
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          <label className="muted">max tokens <input type="number" min={256} max={32000} step={256} style={{ width: 80 }} defaultValue={2000}
            aria-label="Max tokens" onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) })} /></label>
          <label className="muted">temp <input type="number" min={0} max={2} step={0.1} style={{ width: 60 }} defaultValue={0.4}
            aria-label="Temperature" onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })} /></label>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>Save provider</button>
        </div>
      </div>
    </div>
  );
}
