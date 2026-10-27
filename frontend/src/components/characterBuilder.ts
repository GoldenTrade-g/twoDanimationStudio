/** Character builder: generates editable vector body-part objects + a simple rig. */
import type { Asset, CharacterSpec, CharacterRig, DrawableObject, CharacterPart } from '@studio/shared';
import { uid } from '../util';
import { hexToRgba } from '../util';

export function defaultCharacterSpec(): CharacterSpec {
  return {
    bodyShape: 'round', skinColor: '#ffd9b3', headSize: 1, torsoSize: 1, limbLength: 1,
    eyeStyle: 'cartoon', mouthStyle: 'smile', hairStyle: 'short',
    shirtColor: '#4ea8de', pantsColor: '#3d5a80', expression: 'happy',
  };
}

function base(id: string, name: string): Omit<DrawableObject, 'kind'> & { id: string; name: string } {
  return {
    id, name, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, visible: true,
    parentId: null, pivot: null, fill: null, stroke: hexToRgba('#22223b', 1), strokeWidth: 2.5,
    strokeCap: 'round', assetId: null,
  } as never;
}

/** Build all parts in local coordinates around origin (feet at y≈+170). */
export function buildCharacterObjects(spec: CharacterSpec): { objects: DrawableObject[]; rig: CharacterRig } {
  const skin = hexToRgba(spec.skinColor, 1);
  const shirt = hexToRgba(spec.shirtColor, 1);
  const pants = hexToRgba(spec.pantsColor, 1);
  const dark = hexToRgba('#2b2d42', 1);
  const white = hexToRgba('#ffffff', 1);

  const mk = <K extends DrawableObject>(name: string, kind: K['kind'], extra: Partial<K>): K => {
    const id = uid('obj');
    const o = { ...base(id, name), kind, ...extra } as unknown as K;
    return o;
  };

  const headR = 46 * spec.headSize;
  const torsoW = (spec.bodyShape === 'slim' ? 46 : spec.bodyShape === 'square' ? 64 : 56) * spec.torsoSize;
  const torsoH = (spec.bodyShape === 'slim' ? 92 : 80) ;
  const limb = spec.limbLength;

  const head = mk<DrawableObject>('Head', 'ellipse', { fill: skin, center: { x: 0, y: -headR - torsoH / 2 + 6 }, radiusX: headR, radiusY: headR });
  const torso = mk<DrawableObject>('Torso', spec.bodyShape === 'square' ? 'rect' : 'ellipse', {
    fill: shirt,
    ...(spec.bodyShape === 'square'
      ? { origin: { x: -torsoW / 2, y: -torsoH / 2 }, size: { width: torsoW, height: torsoH }, radius: 8 }
      : { center: { x: 0, y: 0 }, radiusX: torsoW / 2, radiusY: torsoH / 2 }),
  });

  const eyeY = -headR - torsoH / 2 + 2;
  const mkEye = (side: -1 | 1, name: string) =>
    spec.eyeStyle === 'dots'
      ? mk<DrawableObject>(name, 'ellipse', { fill: dark, stroke: null, strokeWidth: 0, center: { x: side * headR * 0.35, y: eyeY }, radiusX: 4, radiusY: 4 })
      : mk<DrawableObject>(name, 'ellipse', { fill: white, center: { x: side * headR * 0.35, y: eyeY }, radiusX: spec.eyeStyle === 'ovals' ? 6 : 8, radiusY: spec.eyeStyle === 'ovals' ? 9 : 10 });

  const eyeL = mkEye(-1, 'Eye L');
  const eyeR = mkEye(1, 'Eye R');
  const pupilOffset = spec.expression === 'surprised' ? -2 : 1;
  const pupil = (side: -1 | 1, name: string) => mk<DrawableObject>(name, 'ellipse', { fill: dark, stroke: null, strokeWidth: 0, center: { x: side * headR * 0.35, y: eyeY + pupilOffset }, radiusX: 3, radiusY: spec.expression === 'surprised' ? 4 : 3 });
  const pupL = pupil(-1, 'Pupil L');
  const pupR = pupil(1, 'Pupil R');

  const browY = eyeY - (spec.expression === 'angry' ? 14 : 12);
  const brow = (side: -1 | 1, name: string, tilt: number) => mk<DrawableObject>(name, 'line', {
    stroke: dark, strokeWidth: 3,
    from: { x: side * headR * 0.55 - 10, y: browY + tilt }, to: { x: side * headR * 0.55 + 10, y: browY - tilt },
  });
  const angryTilt = spec.expression === 'angry' ? 5 : spec.expression === 'sad' ? -4 : 0;
  const browL = brow(-1, 'Brow L', angryTilt);
  const browR = brow(1, 'Brow R', -angryTilt);

  const mouthY = -headR - torsoH / 2 + 6 + headR * 0.55;
  let mouth: DrawableObject;
  if (spec.mouthStyle === 'open' || spec.expression === 'surprised') {
    mouth = mk<DrawableObject>('Mouth', 'ellipse', { fill: hexToRgba('#5c3742', 1), center: { x: 0, y: mouthY }, radiusX: 8, radiusY: 11 });
  } else {
    // smile/frown arc via polygon points
    const dir = spec.mouthStyle === 'frown' || spec.expression === 'sad' ? -1 : 1;
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const x = -16 + 32 * t;
      const y = mouthY + dir * Math.sin(Math.PI * t) * 8;
      pts.push({ x, y });
    }
    mouth = mk<DrawableObject>('Mouth', 'polygon', { points: pts, closed: false, fill: null, stroke: dark, strokeWidth: 3 });
  }

  const hairColor = hexToRgba('#6b4226', 1);
  const hairTop = -headR - torsoH / 2 - headR + 8;
  let hair: DrawableObject | null = null;
  if (spec.hairStyle !== 'none') {
    if (spec.hairStyle === 'spiky') {
      hair = mk<DrawableObject>('Hair', 'polygon', {
        points: [
          { x: -headR * 0.9, y: hairTop + 16 }, { x: -headR * 0.5, y: hairTop - 12 }, { x: -headR * 0.1, y: hairTop + 8 },
          { x: headR * 0.3, y: hairTop - 14 }, { x: headR * 0.7, y: hairTop + 6 }, { x: headR * 0.9, y: hairTop - 6 },
          { x: headR * 0.9, y: hairTop + 22 }, { x: -headR * 0.9, y: hairTop + 22 },
        ], closed: true, fill: hairColor,
      });
    } else if (spec.hairStyle === 'long') {
      hair = mk<DrawableObject>('Hair', 'rect', { origin: { x: -headR - 4, y: hairTop }, size: { width: headR * 2 + 8, height: headR * 2 + torsoH * 0.9 }, radius: 18, fill: hairColor });
    } else if (spec.hairStyle === 'bun') {
      hair = mk<DrawableObject>('Hair', 'ellipse', { center: { x: 0, y: hairTop + 6 }, radiusX: headR * 0.95, radiusY: headR * 0.5, fill: hairColor });
    } else {
      hair = mk<DrawableObject>('Hair', 'ellipse', { center: { x: 0, y: hairTop + 14 }, radiusX: headR * 1.02, radiusY: headR * 0.55, fill: hairColor });
    }
  }

  const armLen = 62 * limb, legLen = 66 * limb;
  const mkLimb = (name: string, x: number, y: number, len: number, vertical: boolean, color: typeof skin) =>
    mk<DrawableObject>(name, 'rect', {
      origin: { x: vertical ? x - 7 : x, y: vertical ? y : y - 7 },
      size: { width: vertical ? 14 : len, height: vertical ? len : 14 },
      radius: 7, fill: color,
    });

  const armL = mkLimb('Arm L', -torsoW / 2 - 16, -torsoH / 2 + 6, armLen, false, shirt);
  const armR = mkLimb('Arm R', torsoW / 2 + 2, -torsoH / 2 + 6, armLen, false, shirt);
  const handL = mk<DrawableObject>('Hand L', 'ellipse', { fill: skin, center: { x: -torsoW / 2 - 16 + armLen, y: -torsoH / 2 + 13 }, radiusX: 8, radiusY: 8 });
  const handR = mk<DrawableObject>('Hand R', 'ellipse', { fill: skin, center: { x: torsoW / 2 + 2 + armLen, y: -torsoH / 2 + 13 }, radiusX: 8, radiusY: 8 });
  const legL = mkLimb('Leg L', -torsoW / 4 - 7, torsoH / 2 - 4, legLen, true, pants);
  const legR = mkLimb('Leg R', torsoW / 4 - 7, torsoH / 2 - 4, legLen, true, pants);
  const footL = mk<DrawableObject>('Foot L', 'ellipse', { fill: dark, center: { x: -torsoW / 4, y: torsoH / 2 + legLen }, radiusX: 12, radiusY: 7 });
  const footR = mk<DrawableObject>('Foot R', 'ellipse', { fill: dark, center: { x: torsoW / 4, y: torsoH / 2 + legLen }, radiusX: 12, radiusY: 7 });

  // Hair drawn behind head: order matters — push hair first.
  const objects: DrawableObject[] = [];
  if (hair) objects.push(hair);
  objects.push(torso, armL, armR, legL, legR, footL, footR, handL, handR, head, eyeL, eyeR, pupL, pupR, browL, browR, mouth);

  // Rig hierarchy: root = torso; head/arms/legs are children; hands/feet attach to limbs.
  const part = (role: string, object: DrawableObject, parentPartId: string | null, pivot: { x: number; y: number }): CharacterPart => ({
    id: uid('part'), role, object, parentPartId, pivot,
  });
  const torsoPart = part('torso', torso, null, { x: 0, y: torsoH / 2 });
  const parts: CharacterPart[] = [
    torsoPart,
    part('head', head, torsoPart.id, { x: 0, y: -torsoH / 2 + 10 }),
    part('armL', armL, torsoPart.id, { x: -torsoW / 2, y: -torsoH / 2 + 12 }),
    part('armR', armR, torsoPart.id, { x: torsoW / 2, y: -torsoH / 2 + 12 }),
    part('legL', legL, torsoPart.id, { x: -torsoW / 4, y: torsoH / 2 - 6 }),
    part('legR', legR, torsoPart.id, { x: torsoW / 4, y: torsoH / 2 - 6 }),
  ];
  const rig: CharacterRig = { parts, rootPartId: torsoPart.id };

  // Wire parentId so the renderer's hierarchy moves children with parents.
  const pidOf = new Map<string, string>();
  for (const p of parts) pidOf.set(p.object.id, p.id);
  const objParent = new Map<string, string | null>();
  for (const p of parts) objParent.set(p.object.id, null);
  head.parentId = torso.id;
  armL.parentId = torso.id; armR.parentId = torso.id;
  legL.parentId = torso.id; legR.parentId = torso.id;
  handL.parentId = armL.id; handR.parentId = armR.id;
  footL.parentId = legL.id; footR.parentId = legR.id;
  eyeL.parentId = head.id; eyeR.parentId = head.id;
  pupL.parentId = head.id; pupR.parentId = head.id;
  browL.parentId = head.id; browR.parentId = head.id;
  mouth.parentId = head.id;
  if (hair) hair.parentId = head.id;

  return { objects, rig };
}

export function characterAssetFromSpec(name: string, spec: CharacterSpec): Asset {
  const { objects, rig } = buildCharacterObjects(spec);
  return {
    id: uid('asset'), name, kind: 'character', tags: ['character'], createdAt: Date.now(),
    dataUrl: null, objects, characterSpec: spec, rig, rasterOnly: false,
  };
}

/** Instantiate an asset's objects into fresh copies placed at scene position. */
export function instantiateAsset(asset: Asset, x: number, y: number, scale = 1): DrawableObject[] {
  if (!asset.objects) return [];
  const idMap = new Map<string, string>();
  const clones = asset.objects.map((o) => {
    const c = structuredClone(o);
    const nid = uid('obj');
    idMap.set(o.id, nid);
    c.id = nid;
    c.assetId = asset.id;
    c.transform = { ...c.transform, x: c.transform.x + x, y: c.transform.y + y, scaleX: c.transform.scaleX * scale, scaleY: c.transform.scaleY * scale };
    return c;
  });
  for (const c of clones) if (c.parentId && idMap.has(c.parentId)) c.parentId = idMap.get(c.parentId)!;
  return clones;
}
