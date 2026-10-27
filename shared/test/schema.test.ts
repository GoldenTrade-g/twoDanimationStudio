import { describe, it, expect } from 'vitest';
import { validateProject, validateStoryboardResult, validateAnimationPlanResult, parseJsonLoose, sanitizeText } from '../src/schema';
import { migrateProject, normalizeForValidation } from '../src/migrate';
import { CURRENT_SCHEMA_VERSION } from '../src/types';

function makeProject() {
  const obj = {
    id: 'o1', name: 'rect', kind: 'rect',
    transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, visible: true, parentId: null, pivot: null,
    fill: { r: 255, g: 0, b: 0, a: 1 }, stroke: null, strokeWidth: 2, strokeCap: 'round', assetId: null,
    origin: { x: 0, y: 0 }, size: { width: 100, height: 50 }, radius: 4,
  };
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'p1', name: 'Test', createdAt: 1, updatedAt: 1, fps: 24, width: 1280, height: 720,
    scenes: [{
      id: 's1', name: 'Scene 1', description: '', duration: 3, fps: 24, width: 1280, height: 720,
      backgroundColor: { r: 255, g: 255, b: 255, a: 1 },
      layers: [{ id: 'l1', name: 'BG', kind: 'vector', visible: true, locked: false, opacity: 1, parallaxDepth: 1, objects: [obj], rasterAssetId: null }],
      animations: [{ objectId: 'o1', tracks: { x: [{ id: 'k1', time: 0, prop: 'x', value: 10, interpolation: 'linear' }, { id: 'k2', time: 1, prop: 'x', value: 300, interpolation: 'easeInOut' }] } }],
      drawingFrames: [], audioClips: [], subtitles: [],
      camera: { x: 0, y: 0, zoom: 1, keyframes: [] },
      transitionIn: { type: 'cut', duration: 0.5 }, category: 'mixed',
    }],
    activeSceneId: 's1', storyboard: [], assets: [],
    settings: { aspectRatio: '16:9', safeAreas: { titleSafe: 0.05, actionSafe: 0.025 }, gridVisible: false, gridSize: 50, snapping: true, onionSkin: false, theme: 'dark' },
  };
}

describe('project validation', () => {
  it('accepts a well-formed project', () => {
    const r = validateProject(makeProject());
    expect(r.ok).toBe(true);
    expect(r.value!.scenes[0].layers[0].objects).toHaveLength(1);
  });

  it('rejects missing scenes and bad colors', () => {
    const p = makeProject();
    (p as any).scenes = [];
    expect(validateProject(p).ok).toBe(false);
    const p2 = makeProject();
    ((p2 as any).scenes[0].backgroundColor = { r: 300, g: 0, b: 0, a: 1 });
    const r = validateProject(p2);
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/0\.\.255/);
  });

  it('detects dangling references (image -> missing asset)', () => {
    const p = makeProject();
    (p as any).scenes[0].layers[0].objects.push({
      id: 'img1', name: 'i', kind: 'image', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      opacity: 1, visible: true, parentId: null, pivot: null, fill: null, stroke: null, strokeWidth: 0, strokeCap: 'round',
      assetId: 'missing-asset', size: { width: 10, height: 10 },
    });
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/missing asset/);
  });

  it('repairs dangling parent ids instead of failing', () => {
    const p = makeProject();
    (p as any).scenes[0].layers[0].objects[0].parentId = 'ghost';
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(r.value!.scenes[0].layers[0].objects[0].parentId).toBe(null);
  });

  it('rejects invalid keyframe values and unknown props', () => {
    const p = makeProject();
    (p as any).scenes[0].animations[0].tracks.x[0].value = 'not-a-color';
    expect(validateProject(p).ok).toBe(false);
    const p2 = makeProject();
    (p2 as any).scenes[0].animations[0].tracks['bogus'] = [];
    const r = validateProject(p2);
    expect(r.ok).toBe(false);
  });

  it('rejects future schema versions', () => {
    const p = makeProject();
    (p as any).schemaVersion = 99;
    expect(() => migrateProject(p)).toThrow(/newer than supported/);
  });

  it('sanitizes control characters in text fields', () => {
    const p = makeProject();
    (p as any).name = 'Bad\u0000Name';
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(r.value!.name).toBe('BadName');
    expect(sanitizeText('<script>x</script>\u0001')).toBe('<script>x</script>');
  });
});

describe('migrations', () => {
  it('migrates v1 -> current adding new fields', () => {
    const old = makeProject();
    (old as any).schemaVersion = 1;
    delete (old as any).scenes[0].camera;
    delete (old as any).scenes[0].transitionIn;
    delete (old as any).scenes[0].subtitles;
    delete (old as any).scenes[0].drawingFrames;
    delete (old as any).settings.safeAreas;
    const m = migrateProject(old);
    expect(m.applied).toEqual([2, 3]);
    expect(m.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const v = validateProject(normalizeForValidation(old));
    expect(v.ok).toBe(true);
  });

  it('is idempotent for current version', () => {
    const p = makeProject();
    const m = migrateProject(p);
    expect(m.applied).toEqual([]);
    expect(m.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('LLM response validation (untrusted data)', () => {
  it('parses JSON wrapped in markdown fences', () => {
    const raw = parseJsonLoose('Here you go:\n```json\n{"a":1}\n```\nHope that helps!');
    expect(raw).toEqual({ a: 1 });
  });

  it('extracts balanced JSON from prose', () => {
    const raw = parseJsonLoose('prefix {"cards":[{"title":"x","nested":{"y":2}}]} suffix');
    expect((raw as any).cards[0].nested.y).toBe(2);
  });

  it('returns null on garbage', () => {
    expect(parseJsonLoose('total nonsense no json')).toBe(null);
  });

  it('validates and clamps storyboard results', () => {
    const sb = validateStoryboardResult({
      title: 'My Tale',
      cards: [
        { sceneNumber: 1, title: 'Intro', description: 'd', durationSeconds: 4, characters: ['Hero'], location: 'Park', framing: 'wide', movement: 'pan', dialogue: 'Hi', soundCues: 'birds', transition: 'fade' },
        { sceneNumber: 2, title: 'Bad', framing: 'invalid-framing', durationSeconds: 9999, transition: 'explode' },
      ],
    });
    expect(sb.ok).toBe(true);
    const cards = sb.value!.cards;
    expect(cards[1].framing).toBe('medium');       // defaulted
    expect(cards[1].durationSeconds).toBe(120);    // clamped
    expect(cards[1].transition).toBe('cut');       // defaulted
  });

  it('rejects storyboard without cards array', () => {
    expect(() => validateStoryboardResult({ title: 'oops' })).toThrowError(/cards/);
  });

  it('drops steps with unknown properties but keeps valid ones', () => {
    const plan = validateAnimationPlanResult({
      steps: [
        { objectIdHint: 'hero', property: 'x', fromTime: 0, toTime: 1, fromValue: 0, toValue: 100, interpolation: 'linear' },
        { objectIdHint: 'hero', property: 'teleport', fromValue: 0, toValue: 5 },
      ],
    }, 's1');
    expect(plan.ok).toBe(true);
    expect(plan.value!.steps).toHaveLength(1);
  });

  it('fails when required times are missing', () => {
    const plan = validateAnimationPlanResult({ steps: [{ property: 'x', fromValue: 1, toValue: 2 }] }, 's1');
    expect(plan.ok).toBe(false);
  });
});
