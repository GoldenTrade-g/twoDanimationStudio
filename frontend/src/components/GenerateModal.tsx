/**
 * AI generation wizard (optional path — everything here is manual-editable afterwards).
 * idea/script → storyboard (review/approve) → scenes → animation plan → keyframes.
 * All model output is validated by @studio/shared before use; nothing is auto-applied destructively.
 */
import { useState } from 'react';
import type { StoryboardResult, AnimationPlanResult, StoryboardCard } from '@studio/shared';
import { validateStoryboardResult, validateAnimationPlanResult, parseJsonLoose } from '@studio/shared';
import { api, ApiError } from '../llm/client';
import { useStore, useEditorState } from '../state/storeBridge';
import { uid } from '../util';

type Step = 1 | 2 | 3 | 4;

export function GenerateModal({ onClose }: { onClose: () => void }): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Step 1 inputs
  const [idea, setIdea] = useState('A lonely robot learns to dance in a junkyard and makes friends with a stray cat.');
  const [style, setStyle] = useState('flat cartoon');
  const [duration, setDuration] = useState(30);
  const [numScenes, setNumScenes] = useState(4);
  const [language, setLanguage] = useState('en');
  const [aspect, setAspect] = useState('16:9');
  const [systemOverride, setSystemOverride] = useState('');

  // Results pending approval
  const [cards, setCards] = useState<StoryboardCard[] | null>(null);
  const [plan, setPlan] = useState<AnimationPlanResult | null>(null);

  const genStoryboard = async (): Promise<void> => {
    setBusy(true); setError(null); setNote(null);
    try {
      const raw = await api.storyboard({
        idea, style, language, targetDurationSec: duration, numScenes, aspect,
        systemOverride: systemOverride || undefined,
      });
      // Defense in depth: if the proxy returned a string/JSON text, parse+validate again.
      const result: StoryboardResult = typeof raw === 'string'
        ? (parseJsonLoose(raw) as StoryboardResult)
        : raw;
      const v = validateStoryboardResult(result);
      if (!v.ok || !v.value) throw new Error(`Model response failed schema validation:\n- ${v.issues.slice(0, 6).join('\n- ')}`);
      const mapped: StoryboardCard[] = v.value.cards.map((c, i) => ({
        id: uid('card'), sceneNumber: c.sceneNumber || i + 1, title: c.title || `Scene ${i + 1}`,
        description: c.description, duration: Math.min(60, Math.max(0.5, c.durationSeconds || 4)),
        characters: c.characters ?? [], location: c.location ?? '', framing: c.framing ?? 'medium',
        movement: c.movement ?? '', dialogue: c.dialogue ?? '', soundCues: c.soundCues ?? '',
        transition: c.transition ?? 'cut', linkedSceneId: null, thumbnailDataUrl: null, approved: false,
      }));
      setCards(mapped);
      setStep(2);
    } catch (e) {
      setError(e instanceof ApiError
        ? `${e.message}${e.kind === 'no-provider' ? ' — configure a provider in Settings → AI Providers, or build your storyboard manually on the Storyboard tab.' : ''}`
        : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const approveIntoProject = (): void => {
    if (!cards) return;
    if (!confirm(`Replace the current storyboard (${st.project.storyboard.length} card(s)) with ${cards.length} generated card(s)? Scenes are NOT deleted.`)) return;
    store.patchStoryboard(cards, 'Apply generated storyboard');
    setNote('Storyboard applied. Review cards on the Storyboard tab, approve each, then “Create scene” from a card.');
    setStep(3);
  };

  const patchCard = (id: string, p: Partial<StoryboardCard>): void =>
    setCards((cs) => cs?.map((c) => (c.id === id ? { ...c, ...p } : c)) ?? cs);

  const moveCard = (id: string, delta: number): void => {
    setCards((cs) => {
      if (!cs) return cs;
      const arr = cs.slice();
      const i = arr.findIndex((c) => c.id === id);
      const j = Math.min(arr.length - 1, Math.max(0, i + delta));
      const [it] = arr.splice(i, 1);
      arr.splice(j, 0, it);
      return arr.map((c, k) => ({ ...c, sceneNumber: k + 1 }));
    });
  };

  const genPlan = async (): Promise<void> => {
    const scene = st.project.scenes.find((s) => s.id === st.project.activeSceneId);
    if (!scene) { setError('Open a scene first (create one from an approved storyboard card).'); return; }
    setBusy(true); setError(null); setNote(null);
    try {
      const objects = scene.layers.flatMap((l) => l.objects).map((o) => ({ id: o.id, name: o.name, kind: o.kind }));
      const raw = await api.animationPlan({
        sceneDescription: `${scene.name}: ${scene.description}`, objects,
        durationSec: scene.duration, sceneId: scene.id,
        systemOverride: systemOverride || undefined,
      });
      const result = typeof raw === 'string' ? parseJsonLoose(raw) : raw;
      const v = validateAnimationPlanResult(result, scene.id);
      if (!v.ok || !v.value) throw new Error(`Animation plan failed validation:\n- ${v.issues.slice(0, 6).join('\n- ')}`);
      setPlan(v.value);
      setStep(4);
    } catch (e) {
      setError(e instanceof ApiError
        ? `${e.message}${e.kind === 'no-provider' ? ' — no LLM configured. You can still add keyframes manually on the timeline.' : ''}`
        : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const applyPlan = (): void => {
    if (!plan) return;
    const scene = st.project.scenes.find((s) => s.id === st.project.activeSceneId);
    if (!scene) return;
    const allObjs = scene.layers.flatMap((l) => l.objects);
    let applied = 0, skipped = 0;
    for (const stepKf of plan.steps) {
      // Match object by exact id or fuzzy name hint — never invent ids.
      const obj = allObjs.find((o) => o.id === stepKf.objectIdHint)
        ?? allObjs.find((o) => o.name.toLowerCase().includes(stepKf.objectIdHint.toLowerCase()));
      if (!obj) { skipped++; continue; }
      const t0 = Math.min(scene.duration, Math.max(0, stepKf.fromTime));
      const t1 = Math.min(scene.duration, Math.max(t0, stepKf.toTime));
      store.ui({ time: t0 });
      store.setKeyframe(obj.id, stepKf.property, stepKf.fromValue, stepKf.interpolation);
      if (t1 > t0) {
        store.ui({ time: t1 });
        store.setKeyframe(obj.id, stepKf.property, stepKf.toValue, stepKf.interpolation);
      }
      applied++;
    }
    setNote(`Applied ${applied} keyframe pair(s)${skipped ? `, skipped ${skipped} unknown object(s)` : ''}. Undo (Ctrl+Z) restores the previous state.`);
    setPlan(null);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-label="AI generation wizard">
      <div className="modal" style={{ maxWidth: 760 }}>
        <div className="row"><h2 style={{ margin: 0 }} className="grow">AI Storyboard Wizard</h2>
          <button className="btn small" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="row muted" style={{ gap: 6, marginBottom: 8 }}>
          {['1 Idea', '2 Review storyboard', '3 Compose scenes', '4 Animation plan'].map((label, i) => (
            <span key={label} className={`chip${step === i + 1 ? ' primary' : ''}`}>{label}</span>
          ))}
        </div>
        {error && <div className="chip bad" role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
        {note && <div className="chip ok" role="status">{note}</div>}

        {step === 1 && (
          <div className="col" style={{ gap: 8 }}>
            <label>Story idea / script<textarea rows={5} value={idea} aria-label="Story idea" onChange={(e) => setIdea(e.target.value)} /></label>
            <div className="row wrap" style={{ gap: 8 }}>
              <label>Style <input value={style} style={{ width: 140 }} aria-label="Style" onChange={(e) => setStyle(e.target.value)} /></label>
              <label>Target duration (s) <input type="number" min={5} max={600} value={duration} style={{ width: 70 }} aria-label="Target duration" onChange={(e) => setDuration(Number(e.target.value))} /></label>
              <label>Scenes <input type="number" min={1} max={20} value={numScenes} style={{ width: 60 }} aria-label="Number of scenes" onChange={(e) => setNumScenes(Number(e.target.value))} /></label>
              <label>Language <input value={language} style={{ width: 60 }} aria-label="Language" onChange={(e) => setLanguage(e.target.value)} /></label>
              <label>Aspect
                <select value={aspect} aria-label="Aspect ratio" onChange={(e) => setAspect(e.target.value)}>
                  {['16:9', '9:16', '1:1', '4:3'].map((a) => <option key={a}>{a}</option>)}
                </select></label>
            </div>
            <details><summary className="muted">Advanced: custom system instructions (optional)</summary>
              <textarea rows={3} style={{ width: '100%' }} value={systemOverride} aria-label="System prompt override"
                placeholder="Overrides the default task instructions. Output must remain valid JSON per the documented schema."
                onChange={(e) => setSystemOverride(e.target.value)} /></details>
            <div><button className="btn primary" disabled={busy || !idea.trim()} onClick={() => void genStoryboard()}>
              {busy ? 'Generating… (may take up to a minute)' : 'Generate draft storyboard'}
            </button> <span className="muted">Nothing is written to your project until you approve it.</span></div>
          </div>
        )}

        {step === 2 && cards && (
          <div className="col" style={{ gap: 8 }}>
            <div className="story-grid" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {cards.map((c, i) => (
                <div key={c.id} className="story-card">
                  <input value={c.title} aria-label="Generated card title" onChange={(e) => patchCard(c.id, { title: e.target.value })} />
                  <textarea rows={2} value={c.description} aria-label="Generated card description" onChange={(e) => patchCard(c.id, { description: e.target.value })} />
                  <div className="muted">📍{c.location || '—'} · 🎥 {c.framing} · ⏱ {c.duration}s · 💬 {c.dialogue || '—'}</div>
                  <div className="row">
                    <button className="btn small" disabled={i === 0} onClick={() => moveCard(c.id, -1)} aria-label="Move earlier">←</button>
                    <button className="btn small" disabled={i === cards.length - 1} onClick={() => moveCard(c.id, 1)} aria-label="Move later">→</button>
                    <button className="btn small" onClick={() => patchCard(c.id, { approved: !c.approved })}>{c.approved ? 'Unapprove' : '✔ Approve'}</button>
                    <button className="btn small danger" onClick={() => setCards(cards.filter((x) => x.id !== c.id))} aria-label="Delete card">✕</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="row">
              <span className="muted grow">Total ≈ {cards.reduce((a, c) => a + c.duration, 0).toFixed(1)}s</span>
              <button className="btn" onClick={() => setStep(1)}>← Back</button>
              <button className="btn primary" onClick={approveIntoProject}>Approve & apply to project</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="col" style={{ gap: 8 }}>
            <p>Each approved card lives on the Storyboard tab. Use <b>“Create scene →”</b> on a card to build an editable scene from it
              (background + character layers are pre-created). Draw or place characters manually, or import/generate artwork —
              note that AI-generated images are flat rasters, not automatically editable vector rigs.</p>
            <div className="row">
              <button className="btn" onClick={() => setStep(1)}>← Regenerate</button>
              <button className="btn primary" onClick={() => { setStep(4); }}>Next: animation plan for the active scene</button>
              <button className="btn" onClick={onClose}>Done for now</button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="col" style={{ gap: 8 }}>
            {!plan ? (
              <>
                <p className="muted">Generates keyframe suggestions for the <b>currently open scene</b> ({st.project.scenes.find((s) => s.id === st.project.activeSceneId)?.name ?? 'none'}).
                  Suggestions map onto existing objects by name; unknown objects are skipped, never invented.</p>
                <div className="row">
                  <button className="btn" onClick={() => setStep(3)}>← Back</button>
                  <button className="btn primary" disabled={busy} onClick={() => void genPlan()}>{busy ? 'Planning…' : 'Generate animation plan'}</button>
                </div>
              </>
            ) : (
              <>
                <table style={{ width: '100%', fontSize: 12 }}>
                  <thead><tr><th>Object hint</th><th>Property</th><th>From</th><th>To</th><th>Values</th><th>Ease</th><th>Note</th></tr></thead>
                  <tbody>{plan.steps.map((s, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td>{s.objectIdHint}</td><td>{s.property}</td><td>{s.fromTime}s</td><td>{s.toTime}s</td>
                      <td>{String(s.fromValue)} → {String(s.toValue)}</td><td>{s.interpolation}</td><td className="muted">{s.note}</td>
                    </tr>))}</tbody>
                </table>
                {plan.notes && <div className="muted">{plan.notes}</div>}
                <div className="row">
                  <button className="btn" onClick={() => setPlan(null)}>← Regenerate</button>
                  <button className="btn primary" onClick={applyPlan}>Apply as editable keyframes</button>
                  <button className="btn" onClick={onClose}>Skip (manual animation)</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
