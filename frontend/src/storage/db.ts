/**
 * Local-first persistence: IndexedDB (via idb) project library + autosave journal,
 * plus JSON import/export with schema validation & migration through @studio/shared.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { Project } from '@studio/shared';
import { validateProject, migrateProject, normalizeForValidation } from '@studio/shared';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  thumbnailDataUrl: string | null;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB('animation-studio', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('autosave')) db.createObjectStore('autosave', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

export async function saveProject(project: Project, thumbnailDataUrl: string | null = null): Promise<void> {
  const db = await getDB();
  const p = { ...project, updatedAt: Date.now() };
  await db.put('projects', { id: p.id, project: p, thumbnailDataUrl });
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await getDB();
  const all = (await db.getAll('projects')) as { id: string; project: Project; thumbnailDataUrl: string | null }[];
  return all
    .map((r) => ({ id: r.id, name: r.project.name, updatedAt: r.project.updatedAt, thumbnailDataUrl: r.thumbnailDataUrl }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<Project | null> {
  const db = await getDB();
  const rec = (await db.get('projects', id)) as { project: Project } | undefined;
  return rec ? rec.project : null;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('projects', id);
}

export async function autosave(project: Project): Promise<void> {
  const db = await getDB();
  await db.put('autosave', { id: 'current', project });
}

export async function loadAutosave(): Promise<Project | null> {
  try {
    const db = await getDB();
    const rec = (await db.get('autosave', 'current')) as { project: Project } | undefined;
    return rec ? rec.project : null;
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  const db = await getDB();
  await db.delete('autosave', 'current').catch(() => undefined);
}

/** Parse + validate + migrate an exported project JSON file. Throws with actionable message on failure. */
export function parseProjectJson(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON. Make sure you select a “.json” project exported from this studio.');
  }
  // Migrate first if it's an older schema version but looks like a project.
  let obj = raw;
  if (obj && typeof obj === 'object' && 'schemaVersion' in (obj as object)) {
    const v = Number((obj as { schemaVersion: number }).schemaVersion);
    if (Number.isFinite(v) && v < 3) {
      obj = migrateProject(obj).project;
    }
  }
  const norm = normalizeForValidation(obj);
  const result = validateProject(norm);
  if (!result.ok || !result.value) {
    throw new Error(`Project failed validation:\n- ${result.issues.slice(0, 8).join('\n- ')}`);
  }
  return result.value;
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}
