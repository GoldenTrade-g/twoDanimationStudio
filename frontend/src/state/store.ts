/**
 * Editor store: immutable project state + command-based undo/redo history.
 * Framework-agnostic (testable without React); UI subscribes via useSyncExternalStore.
 */
import type {
  Project, Scene, Layer, DrawableObject, StoryboardCard, Asset, Keyframe,
  ObjectAnimation, AudioClip, Subtitle, RGBA, Id,
} from '@studio/shared';
import { CURRENT_SCHEMA_VERSION } from '@studio/shared';
import { uid, deepClone, clamp } from '../util';
import { upsertKeyframe, removeKeyframe } from '../engine/interpolation';

export interface Command {
  label: string;
  /** Mutates a draft copy of the project (called on structuredClone of current). */
  apply: (draft: Project) => void;
  coalesceKey?: string; // consecutive commands with same key merge (e.g. dragging)
}

export interface EditorState {
  project: Project;
  selectedLayerId: Id | null;
  selectedObjectIds: Id[];
  time: number;              // seconds within active scene
  playing: boolean;
  playbackSpeed: number;     // 0.25..4
  loop: boolean;
  zoom: number;              // view scale
  pan: { x: number; y: number };
  tool: ToolId;
  brushSize: number;
  brushOpacity: number;      // 0..1
  fillColor: string;         // hex
  strokeColor: string;       // hex
  strokeWidth: number;
  fillTolerance: number;
  past: SnapshotEntry[];
  future: SnapshotEntry[];
  dirtySinceSave: number;    // ts of last mutation
  statusMessage: string | null;
}

interface SnapshotEntry { before: Project; after: Project; label: string; coalesceKey?: string; }

export type ToolId =
  | 'select' | 'move' | 'pencil' | 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse'
  | 'polygon' | 'text' | 'fill' | 'eyedropper' | 'lasso' | 'hand';

export const TOOLS: { id: ToolId; label: string; shortcut: string; hint: string }[] = [
  { id: 'select', label: 'Select', shortcut: 'V', hint: 'Click objects to select; drag to move selection.' },
  { id: 'move', label: 'Move', shortcut: 'M', hint: 'Drag to move selected objects or clicked object.' },
  { id: 'pencil', label: 'Pencil', shortcut: 'P', hint: 'Freehand drawing, thin crisp strokes.' },
  { id: 'brush', label: 'Brush', shortcut: 'B', hint: 'Freehand drawing, adjustable size & opacity.' },
  { id: 'eraser', label: 'Eraser', shortcut: 'E', hint: 'Erase drawn strokes on vector layers.' },
  { id: 'line', label: 'Line', shortcut: 'L', hint: 'Straight line. Hold Shift while releasing for 45° snap.' },
  { id: 'rect', label: 'Rectangle', shortcut: 'R', hint: 'Drag to draw a rectangle (fillable).' },
  { id: 'ellipse', label: 'Ellipse', shortcut: 'O', hint: 'Drag to draw an ellipse/circle.' },
  { id: 'polygon', label: 'Polygon', shortcut: 'G', hint: 'Click points, double-click or Enter to close.' },
  { id: 'text', label: 'Text', shortcut: 'T', hint: 'Click to place a text object.' },
  { id: 'fill', label: 'Fill Bucket', shortcut: 'F', hint: 'Flood-fill enclosed regions on raster layers / closed shapes.' },
  { id: 'eyedropper', label: 'Eyedropper', shortcut: 'I', hint: 'Pick a color from the canvas.' },
  { id: 'lasso', label: 'Lasso', shortcut: 'A', hint: 'Drag a marquee to multi-select objects.' },
  { id: 'hand', label: 'Pan', shortcut: 'H', hint: 'Drag to pan the view (Space also works).' },
];

export function newScene(name: string, width: number, height: number, fps: number): Scene {
  const bgLayer: Layer = {
    id: uid('layer'), name: 'Background', kind: 'vector', visible: true, locked: false,
    opacity: 1, parallaxDepth: 0.2, objects: [], rasterAssetId: null,
  };
  const charLayer: Layer = {
    id: uid('layer'), name: 'Characters', kind: 'vector', visible: true, locked: false,
    opacity: 1, parallaxDepth: 1, objects: [], rasterAssetId: null,
  };
  return {
    id: uid('scene'), name, description: '', duration: 4, fps, width, height,
    backgroundColor: { r: 245, g: 245, b: 250, a: 1 },
    layers: [bgLayer, charLayer],
    animations: [], drawingFrames: [], audioClips: [], subtitles: [],
    camera: { x: 0, y: 0, zoom: 1, keyframes: [] },
    transitionIn: { type: 'cut', duration: 0.5 },
    category: 'mixed',
  };
}

export function newProject(name = 'Untitled'): Project {
  const scene = newScene('Scene 1', 1280, 720, 24);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: uid('proj'), name, createdAt: Date.now(), updatedAt: Date.now(),
    fps: 24, width: 1280, height: 720,
    scenes: [scene], activeSceneId: scene.id,
    storyboard: [], assets: [],
    settings: {
      aspectRatio: '16:9', safeAreas: { titleSafe: 0.05, actionSafe: 0.025 },
      gridVisible: false, gridSize: 32, snapping: false, onionSkin: false, theme: 'dark',
    },
  };
}

type Listener = () => void;

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<Listener>();
  private lastCoalesce: { key: string; index: number } | null = null;

  constructor(project?: Project) {
    const p = project ?? newProject();
    this.state = {
      project: p,
      selectedLayerId: firstScene(p)?.layers[1]?.id ?? firstScene(p)?.layers[0]?.id ?? null,
      selectedObjectIds: [],
      time: 0, playing: false, playbackSpeed: 1, loop: true,
      zoom: 0.6, pan: { x: 0, y: 0 },
      tool: 'pencil', brushSize: 6, brushOpacity: 1,
      fillColor: '#ffd166', strokeColor: '#22223b', strokeWidth: 3, fillTolerance: 32,
      past: [], future: [], dirtySinceSave: 0, statusMessage: null,
    };
  }

  getState = (): EditorState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  // ---------- Project mutations (with history) ----------
  run(cmd: Command): void {
    const before = this.state.project;
    const draft = deepClone(before);
    cmd.apply(draft);
    draft.updatedAt = Date.now();
    const entry: SnapshotEntry = { before, after: draft, label: cmd.label, coalesceKey: cmd.coalesceKey };
    let past = this.state.past;
    if (cmd.coalesceKey && this.lastCoalesce && this.lastCoalesce.key === cmd.coalesceKey && past.length > 0) {
      // merge into previous entry (keep its `before`, update `after`)
      const idx = past.length - 1;
      past = past.slice();
      past[idx] = { ...past[idx], after: draft };
      this.lastCoalesce = { key: cmd.coalesceKey, index: idx };
    } else {
      past = [...past, entry];
      if (past.length > 200) past = past.slice(past.length - 200);
      this.lastCoalesce = cmd.coalesceKey ? { key: cmd.coalesceKey, index: past.length - 1 } : null;
    }
    this.set({ project: draft, past, future: [], dirtySinceSave: Date.now() });
  }

  /** Non-history UI state. */
  ui(patch: Partial<EditorState>): void { this.set(patch); }

  undo(): void {
    const past = this.state.past;
    if (past.length === 0) return;
    const entry = past[past.length - 1];
    this.lastCoalesce = null;
    this.set({ project: entry.before, past: past.slice(0, -1), future: [...this.state.future, entry], dirtySinceSave: Date.now() });
  }

  redo(): void {
    const future = this.state.future;
    if (future.length === 0) return;
    const entry = future[future.length - 1];
    this.lastCoalesce = null;
    this.set({ project: entry.after, past: [...this.state.past, entry], future: future.slice(0, -1), dirtySinceSave: Date.now() });
  }

  canUndo(): boolean { return this.state.past.length > 0; }
  canRedo(): boolean { return this.state.future.length > 0; }

  status(msg: string | null): void { this.set({ statusMessage: msg }); }

  loadProject(p: Project): void {
    const s = firstScene(p);
    this.set({
      project: deepClone(p), selectedLayerId: s?.layers[1]?.id ?? s?.layers[0]?.id ?? null,
      selectedObjectIds: [], time: 0, playing: false, past: [], future: [], dirtySinceSave: 0,
    });
  }

  // ---------- Convenience mutators ----------
  activeScene(): Scene | undefined { return this.state.project.scenes.find((s) => s.id === this.state.project.activeSceneId); }

  activeLayer(): Layer | undefined {
    const sc = this.activeScene();
    if (!sc) return undefined;
    return sc.layers.find((l) => l.id === this.state.selectedLayerId) ?? sc.layers[0];
  }

  addObject(obj: DrawableObject, layerId?: Id): void {
    this.run({
      label: `Add ${obj.kind}`,
      apply: (p) => {
        const sc = sceneOf(p);
        const layer = sc.layers.find((l) => l.id === (layerId ?? this.state.selectedLayerId)) ?? sc.layers[0];
        if (layer.kind !== 'vector') throw new Error('Cannot add vector objects to a raster layer.');
        layer.objects.push(obj);
      },
    });
    this.set({ selectedObjectIds: [obj.id] });
  }

  updateObjects(ids: Id[], fn: (o: DrawableObject) => DrawableObject, label: string, coalesceKey?: string): void {
    this.run({
      label, coalesceKey,
      apply: (p) => {
        const sc = sceneOf(p);
        for (const layer of sc.layers) layer.objects = layer.objects.map((o) => (ids.includes(o.id) ? fn(o) : o));
        for (const df of sc.drawingFrames) df.objects = df.objects.map((o) => (ids.includes(o.id) ? fn(o) : o));
      },
    });
  }

  deleteSelected(): void {
    const ids = this.state.selectedObjectIds;
    if (ids.length === 0) return;
    this.run({
      label: `Delete ${ids.length} object(s)`,
      apply: (p) => {
        const sc = sceneOf(p);
        const kill = (arr: DrawableObject[]) => arr.filter((o) => !ids.includes(o.id)).map((o) => (o.parentId && ids.includes(o.parentId) ? { ...o, parentId: null } : o));
        for (const layer of sc.layers) layer.objects = kill(layer.objects);
        for (const df of sc.drawingFrames) df.objects = kill(df.objects);
        sc.animations = sc.animations.filter((a) => !ids.includes(a.objectId));
      },
    });
    this.set({ selectedObjectIds: [] });
  }

  duplicateSelected(): void {
    const ids = this.state.selectedObjectIds;
    if (ids.length === 0) return;
    const newIds: Id[] = [];
    this.run({
      label: 'Duplicate',
      apply: (p) => {
        const sc = sceneOf(p);
        const layer = sc.layers.find((l) => l.id === this.state.selectedLayerId) ?? sc.layers[0];
        const src = layer.objects.filter((o) => ids.includes(o.id));
        const map = new Map<Id, Id>();
        for (const o of src) map.set(o.id, uid('obj'));
        newIds.push(...src.map((o) => map.get(o.id)!));
        for (const o of src) {
          const c = deepClone(o);
          c.id = map.get(o.id)!;
          c.transform = { ...c.transform, x: c.transform.x + 24, y: c.transform.y + 24 };
          if (c.parentId && map.has(c.parentId)) c.parentId = map.get(c.parentId)!;
          layer.objects.push(c);
        }
      },
    });
    this.set({ selectedObjectIds: newIds });
  }

  reorderObject(id: Id, delta: number): void {
    this.run({
      label: 'Reorder layer objects',
      apply: (p) => {
        const sc = sceneOf(p);
        const layer = sc.layers.find((l) => l.id === this.state.selectedLayerId) ?? sc.layers[0];
        const i = layer.objects.findIndex((o) => o.id === id);
        if (i < 0) return;
        const j = clamp(i + delta, 0, layer.objects.length - 1);
        const arr = layer.objects.slice();
        const [it] = arr.splice(i, 1);
        arr.splice(j, 0, it);
        layer.objects = arr;
      },
    });
  }

  groupSelected(): void {
    const ids = this.state.selectedObjectIds;
    if (ids.length < 2) return;
    this.run({
      label: 'Group',
      apply: (p) => {
        const sc = sceneOf(p);
        const layer = sc.layers.find((l) => l.id === this.state.selectedLayerId) ?? sc.layers[0];
        const objs = layer.objects.filter((o) => ids.includes(o.id));
        const root = uid('grp');
        layer.objects.push(makeGroupRect(root, objs));
        for (const o of layer.objects) if (ids.includes(o.id) && o.id !== root) o.parentId = root;
      },
    });
  }

  ungroupSelected(): void {
    const ids = this.state.selectedObjectIds;
    this.run({
      label: 'Ungroup',
      apply: (p) => {
        const sc = sceneOf(p);
        for (const layer of sc.layers) {
          layer.objects = layer.objects.filter((o) => !(ids.includes(o.id) && o.name === 'Group'));
          for (const o of layer.objects) if (o.parentId && ids.includes(o.parentId)) o.parentId = null;
        }
      },
    });
  }

  // ---------- Layers ----------
  addLayer(name = 'Layer'): void {
    const id = uid('layer');
    this.run({
      label: 'Add layer',
      apply: (p) => {
        const sc = sceneOf(p);
        sc.layers.push({ id, name, kind: 'vector', visible: true, locked: false, opacity: 1, parallaxDepth: 1, objects: [], rasterAssetId: null });
      },
    });
    this.set({ selectedLayerId: id });
  }

  patchLayer(id: Id, patch: Partial<Layer>, label = 'Edit layer'): void {
    this.run({ label, apply: (p) => { const sc = sceneOf(p); const l = sc.layers.find((x) => x.id === id); if (l) Object.assign(l, patch); } });
  }

  deleteLayer(id: Id): void {
    this.run({
      label: 'Delete layer',
      apply: (p) => {
        const sc = sceneOf(p);
        sc.layers = sc.layers.filter((l) => l.id !== id);
        sc.drawingFrames = sc.drawingFrames.filter((d) => d.layerId !== id);
      },
    });
    const sc = this.activeScene();
    this.set({ selectedLayerId: sc?.layers[0]?.id ?? null, selectedObjectIds: [] });
  }

  moveLayer(id: Id, delta: number): void {
    this.run({
      label: 'Reorder layer',
      apply: (p) => {
        const sc = sceneOf(p);
        const i = sc.layers.findIndex((l) => l.id === id);
        if (i < 0) return;
        const j = clamp(i + delta, 0, sc.layers.length - 1);
        const arr = sc.layers.slice();
        const [it] = arr.splice(i, 1);
        arr.splice(j, 0, it);
        sc.layers = arr;
      },
    });
  }

  // ---------- Scenes ----------
  addScene(name?: string): void {
    const sc = newScene(name ?? `Scene ${this.state.project.scenes.length + 1}`, this.state.project.width, this.state.project.height, this.state.project.fps);
    this.run({ label: 'Add scene', apply: (p) => { p.scenes.push(sc); } });
    this.selectScene(sc.id);
  }

  selectScene(id: Id): void {
    this.run({ label: 'Switch scene', apply: (p) => { p.activeSceneId = id; } });
    const sc = this.state.project.scenes.find((s) => s.id === id);
    this.set({ time: 0, playing: false, selectedObjectIds: [], selectedLayerId: sc?.layers[1]?.id ?? sc?.layers[0]?.id ?? null });
  }

  deleteScene(id: Id): void {
    this.run({
      label: 'Delete scene',
      apply: (p) => {
        p.scenes = p.scenes.filter((s) => s.id !== id);
        if (p.activeSceneId === id && p.scenes.length > 0) p.activeSceneId = p.scenes[0].id;
        p.storyboard = p.storyboard.map((c) => (c.linkedSceneId === id ? { ...c, linkedSceneId: null } : c));
      },
    });
  }

  duplicateScene(id: Id): void {
    const newId = uid('scene');
    this.run({
      label: 'Duplicate scene',
      apply: (p) => {
        const src = p.scenes.find((s) => s.id === id);
        if (!src) return;
        const copy = deepClone(src);
        const remap = new Map<Id, Id>();
        copy.id = newId;
        copy.name = `${src.name} (copy)`;
        for (const l of copy.layers) { const nl = uid('layer'); remap.set(l.id, nl); l.id = nl; for (const o of l.objects) { const no = uid('obj'); remap.set(o.id, no); o.id = no; } }
        for (const o of copy.layers.flatMap((l) => l.objects)) {
          if (o.parentId && remap.has(o.parentId)) o.parentId = remap.get(o.parentId)!;
        }
        copy.animations = copy.animations.map((a) => ({ ...a, objectId: remap.get(a.objectId) ?? a.objectId }));
        copy.drawingFrames = copy.drawingFrames.map((d) => ({ ...d, id: uid('df'), layerId: remap.get(d.layerId) ?? d.layerId, objects: d.objects.map((o) => ({ ...o, id: remap.get(o.id) ?? o.id })) }));
        const idx = p.scenes.findIndex((s) => s.id === id);
        p.scenes.splice(idx + 1, 0, copy);
      },
    });
  }

  moveScene(id: Id, delta: number): void {
    this.run({
      label: 'Reorder scene',
      apply: (p) => {
        const i = p.scenes.findIndex((s) => s.id === id);
        if (i < 0) return;
        const j = clamp(i + delta, 0, p.scenes.length - 1);
        const arr = p.scenes.slice();
        const [it] = arr.splice(i, 1);
        arr.splice(j, 0, it);
        p.scenes = arr;
      },
    });
  }

  patchScene(id: Id, patch: Partial<Scene>, label = 'Edit scene'): void {
    this.run({ label, apply: (p) => { const s = p.scenes.find((x) => x.id === id); if (s) Object.assign(s, patch); } });
  }

  // ---------- Keyframes ----------
  setKeyframe(objectId: Id, prop: keyof typeof KEY_PROPS, value: number | string | boolean, interpolation: Keyframe['interpolation'] = 'linear'): void {
    const time = roundTime(this.state.time, this.state.project.fps);
    const kf: Keyframe = { id: uid('kf'), time, prop, value, interpolation };
    this.run({
      label: `Keyframe ${prop}`,
      apply: (p) => {
        const sc = sceneOf(p, p.activeSceneId);
        let anim = sc.animations.find((a) => a.objectId === objectId);
        if (!anim) { anim = { objectId, tracks: {} }; sc.animations.push(anim); }
        const idx = sc.animations.indexOf(anim);
        sc.animations[idx] = upsertKeyframe(anim, prop, kf);
      },
    });
  }

  deleteKeyframe(objectId: Id, prop: string, kfId: Id): void {
    this.run({
      label: 'Delete keyframe',
      apply: (p) => {
        const sc = sceneOf(p);
        const anim = sc.animations.find((a) => a.objectId === objectId);
        if (!anim) return;
        const next = removeKeyframe(anim, prop, kfId);
        const idx = sc.animations.indexOf(anim);
        if (Object.keys(next.tracks).length === 0) sc.animations.splice(idx, 1);
        else sc.animations[idx] = next;
      },
    });
  }

  moveKeyframe(objectId: Id, prop: string, kfId: Id, newTime: number): void {
    this.run({
      label: 'Move keyframe', coalesceKey: `kf-${kfId}`,
      apply: (p) => {
        const sc = sceneOf(p);
        const anim = sc.animations.find((a) => a.objectId === objectId);
        if (!anim) return;
        const list = (anim.tracks[prop] ?? []).map((k) => (k.id === kfId ? { ...k, time: roundTime(newTime, p.fps) } : k));
        list.sort((a, b) => a.time - b.time);
        sc.animations[sc.animations.indexOf(anim)] = { ...anim, tracks: { ...anim.tracks, [prop]: list } };
      },
    });
  }

  applyMotionPreset(objectId: Id, preset: string): void {
    const sc = this.activeScene();
    if (!sc) return;
    const dur = sc.duration;
    const obj = sc.layers.flatMap((l) => l.objects).find((o) => o.id === objectId);
    if (!obj) return;
    const t = obj.transform;
    const cmds: [number, string, number | string | boolean][] = [];
    switch (preset) {
      case 'fade-in': cmds.push([0, 'opacity', 0], [Math.min(1, dur / 2), 'opacity', 1]); break;
      case 'fade-out': cmds.push([dur - Math.min(1, dur / 2), 'opacity', 1], [dur, 'opacity', 0]); break;
      case 'move-right': cmds.push([0, 'x', t.x], [dur, 'x', t.x + 300]); break;
      case 'slide-up': cmds.push([0, 'y', t.y + 120, ], [dur, 'y', t.y]); break;
      case 'rotate': cmds.push([0, 'rotation', t.rotation], [dur, 'rotation', t.rotation + 360]); break;
      case 'scale-pop': cmds.push([0, 'scaleX', 0.2], [0, 'scaleY', 0.2], [dur * 0.3, 'scaleX', 1.15], [dur * 0.3, 'scaleY', 1.15], [dur * 0.5, 'scaleX', 1], [dur * 0.5, 'scaleY', 1]); break;
      case 'bounce': {
        cmds.push([0, 'y', t.y], [dur * 0.25, 'y', t.y - 120], [dur * 0.5, 'y', t.y], [dur * 0.7, 'y', t.y - 50], [dur * 0.9, 'y', t.y]);
        break;
      }
      case 'blink': {
        const half = Math.max(0.2, dur / 2);
        cmds.push([0, 'visible', true], [half, 'visible', false], [half + 0.2, 'visible', true]);
        break;
      }
      case 'walk-cycle': {
        // Approximation: horizontal travel + slight vertical bob (documented as approximation).
        cmds.push([0, 'x', t.x], [dur, 'x', t.x + 240]);
        const step = dur / 8;
        for (let i = 0; i <= 8; i++) cmds.push([i * step, 'y', t.y + (i % 2 === 0 ? 0 : -8)]);
        break;
      }
      default: return;
    }
    // Batch all preset keyframes in ONE history entry:
    this.run({
      label: `Preset: ${preset}`,
      apply: (p) => {
        const s = sceneOf(p);
        let anim = s.animations.find((a) => a.objectId === objectId);
        if (!anim) { anim = { objectId, tracks: {} }; s.animations.push(anim); }
        for (const [time, prop, value] of cmds) {
          const kf: Keyframe = { id: uid('kf'), time: roundTime(time, p.fps), prop: prop as Keyframe['prop'], value, interpolation: prop === 'visible' ? 'hold' : 'easeInOut' };
          anim = upsertKeyframe(anim, prop, kf);
          s.animations[s.animations.findIndex((a) => a.objectId === objectId)] = anim;
        }
      },
    });
  }

  // ---------- Drawing frames (frame-by-frame) ----------
  commitDrawingFrame(layerId: Id, objects: DrawableObject[], exposure = 1): void {
    const fps = this.activeScene()?.fps ?? 12;
    const index = Math.floor(this.state.time * fps + 1e-6);
    this.run({
      label: `Add drawing frame ${index}`,
      apply: (p) => {
        const sc = sceneOf(p);
        sc.drawingFrames = sc.drawingFrames.filter((d) => !(d.layerId === layerId && d.index === index));
        sc.drawingFrames.push({ id: uid('df'), index, exposure, layerId, objects: deepClone(objects) });
      },
    });
  }

  // ---------- Audio & subtitles ----------
  addAudioClip(clip: AudioClip): void {
    this.run({ label: 'Add audio clip', apply: (p) => { sceneOf(p).audioClips.push(clip); } });
  }
  patchAudioClip(id: Id, patch: Partial<AudioClip>, label = 'Edit audio clip', coalesceKey?: string): void {
    this.run({ label, coalesceKey, apply: (p) => { const sc = sceneOf(p); const c = sc.audioClips.find((x) => x.id === id); if (c) Object.assign(c, patch); } });
  }
  deleteAudioClip(id: Id): void {
    this.run({ label: 'Delete audio clip', apply: (p) => { const sc = sceneOf(p); sc.audioClips = sc.audioClips.filter((c) => c.id !== id); } });
  }
  addSubtitle(sub: Subtitle): void {
    this.run({ label: 'Add subtitle', apply: (p) => { sceneOf(p).subtitles.push(sub); } });
  }
  patchSubtitle(id: Id, patch: Partial<Subtitle>, label = 'Edit subtitle'): void {
    this.run({ label, apply: (p) => { const sc = sceneOf(p); const s = sc.subtitles.find((x) => x.id === id); if (s) Object.assign(s, patch); } });
  }
  deleteSubtitle(id: Id): void {
    this.run({ label: 'Delete subtitle', apply: (p) => { const sc = sceneOf(p); sc.subtitles = sc.subtitles.filter((s) => s.id !== id); } });
  }

  // ---------- Assets ----------
  addAsset(asset: Asset): void {
    this.run({ label: `Save asset “${asset.name}”`, apply: (p) => { p.assets.push(asset); } });
  }
  deleteAsset(id: Id): void {
    this.run({ label: 'Delete asset', apply: (p) => { p.assets = p.assets.filter((a) => a.id !== id); } });
  }

  // ---------- Storyboard ----------
  patchStoryboard(cards: StoryboardCard[], label = 'Edit storyboard'): void {
    this.run({ label, apply: (p) => { p.storyboard = cards; } });
  }

  /** Create a scene from an approved storyboard card and link them. */
  instantiateStoryboardCard(cardId: Id): Id | null {
    const createdId = uid('scene');
    this.run({
      label: 'Create scene from storyboard',
      apply: (p) => {
        const card = p.storyboard.find((c) => c.id === cardId);
        if (!card) return;
        const sc = newScene(card.title || `Scene ${card.sceneNumber}`, p.width, p.height, p.fps);
        sc.id = createdId;
        sc.duration = clamp(card.duration || 4, 0.5, 120);
        sc.description = card.description;
        sc.transitionIn = { type: card.transition, duration: 0.5 };
        // simple staging: place a placeholder character ellipse + location background rect
        const layer = sc.layers[1];
        layer.objects.push({
          id: uid('obj'), name: card.characters[0] ?? 'Character', kind: 'ellipse',
          transform: { x: p.width * 0.5, y: p.height * 0.62, scaleX: 1, scaleY: 1, rotation: 0 },
          opacity: 1, visible: true, parentId: null, pivot: null,
          fill: { r: 255, g: 209, b: 102, a: 1 }, stroke: { r: 34, g: 34, b: 59, a: 1 }, strokeWidth: 3, strokeCap: 'round', assetId: null,
          center: { x: 0, y: 0 }, radiusX: 60, radiusY: 90,
        } as DrawableObject);
        // background band
        const bg = sc.layers[0];
        bg.objects.push({
          id: uid('obj'), name: 'BG', kind: 'rect',
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          opacity: 1, visible: true, parentId: null, pivot: null,
          fill: { r: 180, g: 220, b: 255, a: 1 }, stroke: null, strokeWidth: 0, strokeCap: 'butt', assetId: null,
          origin: { x: 0, y: 0 }, size: { width: p.width, height: p.height }, radius: 0,
        } as DrawableObject);
        p.scenes.push(sc);
        p.storyboard = p.storyboard.map((c) => (c.id === cardId ? { ...c, linkedSceneId: createdId, approved: true } : c));
      },
    });
    return createdId;
  }
}

const KEY_PROPS = { x: 1, y: 1, scaleX: 1, scaleY: 1, rotation: 1, opacity: 1, fill: 1, visible: 1 } as const;

function makeGroupRect(id: Id, objs: DrawableObject[]): DrawableObject {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objs) {
    const b = o.transform; // rough: use transform position
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x); maxY = Math.max(maxY, b.y);
  }
  return {
    id, name: 'Group', kind: 'rect',
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, visible: true, parentId: null, pivot: null,
    fill: null, stroke: null, strokeWidth: 0, strokeCap: 'butt', assetId: null,
    origin: { x: minX, y: minY }, size: { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }, radius: 0,
  } as DrawableObject;
}

function firstScene(p: Project): Scene | undefined { return p.scenes[0]; }

function sceneOf(p: Project, id?: Id): Scene {
  const sc = p.scenes.find((s) => s.id === (id ?? p.activeSceneId));
  if (!sc) throw new Error('No active scene.');
  return sc;
}

export function roundTime(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}
