/** Storage round-trip + import/migration tests (fake IndexedDB via setup). */
import { describe, it, expect } from 'vitest';
import type { Project } from '@studio/shared';
import { saveProject, loadProject, listProjects, deleteProject, autosave, loadAutosave, clearAutosave, parseProjectJson, serializeProject } from '../storage/db';
import { newProject } from '../state/store';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('IndexedDB project library', () => {
  it('save → list → load → delete round trip preserves the project exactly', async () => {
    const p = newProject('Round Trip');
    p.scenes[0].duration = 3.5;
    await saveProject(p, 'data:image/png;base64,AAA');

    const metas = await listProjects();
    expect(metas.some((m) => m.id === p.id && m.name === 'Round Trip')).toBe(true);

    const loaded = await loadProject(p.id);
    expect(loaded).not.toBeNull();
    const strip = (x: Project) => JSON.parse(JSON.stringify({ ...x, updatedAt: 0 }));
    expect(strip(loaded!)).toEqual(strip(p));

    await deleteProject(p.id);
    expect(await loadProject(p.id)).toBeNull();
  });

  it('autosave journal can be written and recovered', async () => {
    const p = newProject('Auto');
    await autosave(p);
    const back = await loadAutosave();
    expect(back?.id).toBe(p.id);
    await clearAutosave();
    expect(await loadAutosave()).toBeNull();
  });
});

describe('JSON import/export with validation & migration', () => {
  it('serialize → parse round trips a v3 project', () => {
    const p = newProject('JSON RT');
    const parsed = parseProjectJson(serializeProject(p));
    expect(parsed.id).toBe(p.id);
    expect(parsed.schemaVersion).toBe(3);
  });

  it('migrates a v1 project up to v3 on import', () => {
    const v1 = newProject('Old v1');
    (v1 as { schemaVersion: number }).schemaVersion = 1;
    const s = v1.scenes[0] as unknown as Record<string, unknown>;
    delete s.camera; delete s.transitionIn; delete s.subtitles; delete s.drawingFrames;
    delete (v1.settings as Record<string, unknown>).safeAreas;
    for (const l of v1.scenes[0].layers as unknown as Record<string, unknown>[]) delete l.parallaxDepth;
    const migrated = parseProjectJson(JSON.stringify(v1));
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.scenes.length).toBe(1);
    // Migration must produce a structurally valid current-version project
    expect(() => parseProjectJson(serializeProject(migrated))).not.toThrow();
    expect(migrated.settings).toBeTruthy();
  });

  it('rejects non-JSON with an actionable message', () => {
    expect(() => parseProjectJson('<html>not a project</html>')).toThrowError(/valid JSON/i);
  });

  it('rejects garbage objects that are not projects', () => {
    expect(() => parseProjectJson(JSON.stringify({ hello: 'world' }))).toThrowError(/validation/i);
  });

  it('repairs dangling references instead of crashing (untrusted input)', () => {
    const p = newProject('Dangling');
    const scene = p.scenes[0];
    const obj = {
      id: 'o1', name: 'r', kind: 'rect' as const, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      opacity: 1, visible: true, parentId: 'does-not-exist', pivot: null,
      fill: { r: 1, g: 2, b: 3, a: 1 }, stroke: null, strokeWidth: 0, strokeCap: 'round' as const, assetId: null,
      origin: { x: 0, y: 0 }, size: { width: 10, height: 10 }, radius: 0,
    };
    scene.layers[0].objects.push(obj);
    const fixed = parseProjectJson(serializeProject(p as unknown as Project));
    const imported = fixed.scenes[0].layers[0].objects[0];
    expect(imported.parentId === null || fixed.scenes[0].layers.some((l) => l.objects.some((o) => o.id === imported.parentId))).toBe(true);
  });
});
