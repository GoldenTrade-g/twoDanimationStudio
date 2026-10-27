/**
 * Built-in demo project: 2 scenes, a rigged character (editable vector parts),
 * backgrounds with parallax layers, multiple keyframes, subtitles. Opens instantly
 * and plays without any LLM or backend connection.
 */
import type { Project, Scene, DrawableObject, RGBA } from '@studio/shared';
import { CURRENT_SCHEMA_VERSION } from '@studio/shared';
import { newScene } from '../state/store';
import { defaultCharacterSpec, characterAssetFromSpec, instantiateAsset } from '../components/characterBuilder';
import { uid } from '../util';

const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a });
const hex = '#ffd166';

function rect(x: number, y: number, w: number, h: number, fill: RGBA, name: string): DrawableObject {
  return {
    id: uid('obj'), name, kind: 'rect', transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, visible: true, parentId: null, pivot: null,
    fill, stroke: null, strokeWidth: 0, strokeCap: 'round', assetId: null,
    origin: { x: 0, y: 0 }, size: { width: w, height: h }, radius: 0,
  };
}

function ellipse(cx: number, cy: number, rx: number, ry: number, fill: RGBA | null, stroke: RGBA | null, name: string): DrawableObject {
  return {
    id: uid('obj'), name, kind: 'ellipse', transform: { x: cx, y: cy, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1, visible: true, parentId: null, pivot: null,
    fill, stroke, strokeWidth: stroke ? 4 : 0, strokeCap: 'round', assetId: null,
    center: { x: 0, y: 0 }, radiusX: rx, radiusY: ry,
  };
}

export function buildDemoProject(): Project {
  const now = Date.now();
  const width = 960, height = 540, fps = 24;

  // ---- Character asset (rigged, editable parts) ----
  const spec = defaultCharacterSpec();
  spec.shirtColor = hex; spec.expression = 'happy'; spec.hairStyle = 'spiky';
  const heroAsset = characterAssetFromSpec('Hero', spec);

  // ---- Scene 1: park — hero walks in & waves (transform keyframes) ----
  const s1: Scene = newScene('1 · Park Hello', width, height, fps);
  s1.description = 'The hero enters the park and waves hello.';
  s1.duration = 4;
  s1.backgroundColor = rgba(135, 206, 235);
  const bg = s1.layers.find((l) => l.name.toLowerCase().includes('background')) ?? s1.layers[0];
  const chars = s1.layers.find((l) => l.id !== bg.id) ?? s1.layers[0];
  chars.name = 'Characters';
  bg.objects.push(rect(0, 420, width, 120, rgba(76, 175, 80), 'Grass'));
  bg.objects.push(ellipse(150, 180, 60, 40, rgba(255, 255, 255), null, 'Cloud 1'));
  bg.objects.push(ellipse(700, 120, 80, 45, rgba(255, 255, 255), null, 'Cloud 2'));
  bg.objects.push(ellipse(830, 90, 55, 55, rgba(255, 235, 59), rgba(255, 193, 7), 'Sun'));
  bg.objects.push(rect(760, 300, 26, 120, rgba(121, 85, 72), 'Tree trunk'));
  bg.objects.push(ellipse(773, 280, 70, 80, rgba(46, 125, 50), null, 'Tree leaves'));

  const heroObjs = instantiateAsset(heroAsset, 120, 200, 1);
  chars.objects.push(...heroObjs);
  const root = heroObjs.find((o: DrawableObject) => o.parentId === null) ?? heroObjs[0];
  // Keyframes: walk in (x), bounce (y), fade in (opacity)
  s1.animations.push({
    objectId: root.id,
    tracks: {
      x: [
        { id: uid('kf'), time: 0, prop: 'x', value: -180, interpolation: 'linear' },
        { id: uid('kf'), time: 2, prop: 'x', value: 380, interpolation: 'easeOut' },
      ],
      y: [
        { id: uid('kf'), time: 0, prop: 'y', value: 200, interpolation: 'hold' },
        { id: uid('kf'), time: 0.5, prop: 'y', value: 185, interpolation: 'easeInOut' },
        { id: uid('kf'), time: 1.0, prop: 'y', value: 200, interpolation: 'easeInOut' },
        { id: uid('kf'), time: 1.5, prop: 'y', value: 185, interpolation: 'easeInOut' },
        { id: uid('kf'), time: 2.0, prop: 'y', value: 200, interpolation: 'hold' },
      ],
      opacity: [
        { id: uid('kf'), time: 0, prop: 'opacity', value: 0, interpolation: 'linear' },
        { id: uid('kf'), time: 0.5, prop: 'opacity', value: 1, interpolation: 'linear' },
      ],
    },
  });
  const head = heroObjs.find((o) => /head/i.test(o.name));
  if (head) {
    s1.animations.push({
      objectId: head.id,
      tracks: { rotation: [
        { id: uid('kf'), time: 2.2, prop: 'rotation', value: 0, interpolation: 'linear' },
        { id: uid('kf'), time: 2.6, prop: 'rotation', value: 12, interpolation: 'easeInOut' },
        { id: uid('kf'), time: 3.0, prop: 'rotation', value: -8, interpolation: 'easeInOut' },
        { id: uid('kf'), time: 3.4, prop: 'rotation', value: 0, interpolation: 'linear' },
      ] },
    });
  }
  s1.subtitles.push({ id: uid('sub'), text: 'Hi! I just walked into the park.', startTime: 2.2, endTime: 3.8, speaker: 'Hero' });

  // ---- Scene 2: sunset — color animation + scale "jump" ----
  const s2: Scene = newScene('2 · Sunset Jump', width, height, fps);
  s2.description = 'The hero happily jumps as the sun sets.';
  s2.duration = 3;
  s2.backgroundColor = rgba(255, 183, 77);
  s2.transitionIn = { type: 'fade', duration: 0.5 };
  const bg2 = s2.layers.find((l) => l.name.toLowerCase().includes('background')) ?? s2.layers[0];
  const chars2 = s2.layers.find((l) => l.id !== bg2.id) ?? s2.layers[0];
  chars2.name = 'Characters';
  bg2.objects.push(rect(0, 430, width, 110, rgba(141, 110, 99), 'Ground'));
  bg2.objects.push(ellipse(480, 430, 200, 200, rgba(255, 111, 0), null, 'Setting sun'));

  const hero2 = instantiateAsset(heroAsset, 420, 240, 1);
  chars2.objects.push(...hero2);
  const root2 = hero2.find((o) => o.parentId === null) ?? hero2[0];
  s2.animations.push({
    objectId: root2.id,
    tracks: {
      y: [
        { id: uid('kf'), time: 0, prop: 'y', value: 240, interpolation: 'hold' },
        { id: uid('kf'), time: 0.6, prop: 'y', value: 120, interpolation: 'easeOut' },
        { id: uid('kf'), time: 1.2, prop: 'y', value: 240, interpolation: 'bounce' },
        { id: uid('kf'), time: 1.8, prop: 'y', value: 170, interpolation: 'easeOut' },
        { id: uid('kf'), time: 2.4, prop: 'y', value: 240, interpolation: 'hold' },
      ],
      scaleX: [{ id: uid('kf'), time: 1.2, prop: 'scaleX', value: 1, interpolation: 'linear' },
               { id: uid('kf'), time: 1.35, prop: 'scaleX', value: 1.15, interpolation: 'easeOut' },
               { id: uid('kf'), time: 1.5, prop: 'scaleX', value: 1, interpolation: 'linear' }],
      scaleY: [{ id: uid('kf'), time: 1.2, prop: 'scaleY', value: 1, interpolation: 'linear' },
               { id: uid('kf'), time: 1.35, prop: 'scaleY', value: 0.85, interpolation: 'easeOut' },
               { id: uid('kf'), time: 1.5, prop: 'scaleY', value: 1, interpolation: 'linear' }],
    },
  });
  const shirtPart = hero2.find((o) => /torso/i.test(o.name));
  if (shirtPart) {
    s2.animations.push({
      objectId: shirtPart.id,
      tracks: { fill: [
        { id: uid('kf'), time: 0, prop: 'fill', value: hex, interpolation: 'linear' },
        { id: uid('kf'), time: 1.5, prop: 'fill', value: '#ef476f', interpolation: 'easeInOut' },
        { id: uid('kf'), time: 3, prop: 'fill', value: hex, interpolation: 'linear' },
      ] },
    });
  }
  s2.subtitles.push({ id: uid('sub'), text: 'And… jump! (color also animates)', startTime: 0.4, endTime: 2.6, speaker: 'Hero' });

  const storyboard = [
    { scene: s1, card: 1, title: 'Park Hello', description: s1.description, framing: 'wide' as const, dialogue: 'Hi! I just walked into the park.', transition: 'cut' as const },
    { scene: s2, card: 2, title: 'Sunset Jump', description: s2.description, framing: 'medium' as const, dialogue: 'And… jump!', transition: 'fade' as const },
  ].map(({ scene, card, title, description, framing, dialogue, transition }) => ({
    id: uid('card'), sceneNumber: card, title, description, duration: scene.duration,
    characters: ['Hero'], location: title, framing, movement: 'subject moves via keyframes',
    dialogue, soundCues: '', transition, linkedSceneId: scene.id, thumbnailDataUrl: null, approved: true,
  }));

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: uid('proj'), name: 'Demo: Hero Day Out', createdAt: now, updatedAt: now,
    fps, width, height,
    scenes: [s1, s2], activeSceneId: s1.id,
    storyboard, assets: [heroAsset],
    settings: { aspectRatio: '16:9', safeAreas: { titleSafe: 0.05, actionSafe: 0.025 }, gridVisible: false, gridSize: 40, snapping: true, onionSkin: false, theme: 'dark' },
  };
}
