/**
 * Project schema migration pipeline. Every version bump gets a migration + test.
 * v1: initial (layers without parallaxDepth/drawingFrames, scenes without subtitles)
 * v2: added audioClips fade fields, drawingFrames, parallaxDepth
 * v3: added camera keyframes, transitionIn, storyboard approved flag, safe areas
 */
import { CURRENT_SCHEMA_VERSION } from './types.js';

type AnyObj = Record<string, any>;

const migrations: Record<number, (p: AnyObj) => AnyObj> = {
  // 0 -> 1 was the initial release; treat missing version as 1 with defaults filled by validator.
  1: (p) => { // 1 -> 2
    const proj = structuredCloneish(p);
    proj.schemaVersion = 2;
    for (const s of proj.scenes ?? []) {
      if (!Array.isArray(s.drawingFrames)) s.drawingFrames = [];
      for (const l of s.layers ?? []) if (typeof l.parallaxDepth !== 'number') l.parallaxDepth = 1;
      for (const cl of s.audioClips ?? []) { if (typeof cl.fadeIn !== 'number') cl.fadeIn = 0; if (typeof cl.fadeOut !== 'number') cl.fadeOut = 0; }
    }
    return proj;
  },
  2: (p) => { // 2 -> 3
    const proj = structuredCloneish(p);
    proj.schemaVersion = 3;
    for (const s of proj.scenes ?? []) {
      if (!s.camera) s.camera = { x: 0, y: 0, zoom: 1, keyframes: [] };
      if (!Array.isArray(s.camera.keyframes)) s.camera.keyframes = [];
      if (!s.transitionIn) s.transitionIn = { type: 'cut', duration: 0.5 };
      if (!Array.isArray(s.subtitles)) s.subtitles = [];
    }
    for (const card of proj.storyboard ?? []) if (typeof card.approved !== 'boolean') card.approved = false;
    if (!proj.settings?.safeAreas) proj.settings = { ...(proj.settings ?? {}), safeAreas: { titleSafe: 0.05, actionSafe: 0.025 } };
    return proj;
  },
};

function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export interface MigrationResult { project: AnyObj; fromVersion: number; toVersion: number; applied: number[]; }

/** Migrate any older project JSON up to CURRENT_SCHEMA_VERSION. Throws on unknown future versions. */
export function migrateProject(raw: unknown): MigrationResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('Cannot migrate non-object project');
  const p = structuredCloneish(raw as AnyObj);
  const from = typeof p.schemaVersion === 'number' ? p.schemaVersion : 1;
  if (from > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Project schema v${from} is newer than supported v${CURRENT_SCHEMA_VERSION}. Update the application.`);
  }
  const applied: number[] = [];
  let cur = p;
  for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
    const fn = migrations[v];
    if (!fn) throw new Error(`No migration registered for schema v${v} -> v${v + 1}`);
    cur = fn(cur);
    applied.push(v + 1);
  }
  cur.schemaVersion = CURRENT_SCHEMA_VERSION;
  return { project: cur, fromVersion: from, toVersion: CURRENT_SCHEMA_VERSION, applied };
}

/** Load helper: migrate then default-fill minimal required fields so validateProject can do its job. */
export function normalizeForValidation(raw: unknown): unknown {
  const migrated = migrateProject(raw).project;
  if (!Array.isArray(migrated.scenes) || migrated.scenes.length === 0) {
    // validator requires >=1 scene; give an explicit error upstream instead of inventing content
    migrated.scenes = migrated.scenes ?? [];
  }
  if (typeof migrated.activeSceneId !== 'string' && migrated.scenes[0]?.id) {
    migrated.activeSceneId = migrated.scenes[0].id;
  }
  return migrated;
}
