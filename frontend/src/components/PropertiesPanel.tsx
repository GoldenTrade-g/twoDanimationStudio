/** Right-hand panel: layers, object properties, colors, presets. */
import { useState } from 'react';
import type { DrawableObject } from '@studio/shared';
import { useEditorState, useStore } from '../state/useStore';
import { rgbaToCss, hexToRgba, rgbaToHex } from '../util';
import { TOOLS } from '../state/store';
import { instantiateAsset, buildCharacterObjects, defaultCharacterSpec } from './characterBuilder';

const PALETTE = ['#22223b', '#ffffff', '#e5484d', '#f6a44b', '#ffd166', '#7bc96f', '#4ea8de', '#9a6cff', '#6b4226', '#ffd9b3'];

export function PropertiesPanel(): JSX.Element {
  const store = useStore();
  const st = useEditorState();
  const scene = st.project.scenes.find((s) => s.id === st.project.activeSceneId);
  const layer = store.activeLayer();
  const selected = (scene?.layers.flatMap((l) => l.objects) ?? []).filter((o) => st.selectedObjectIds.includes(o.id));
  const obj = selected.length === 1 ? selected[0] : null;

  return (
    <aside className="sidepanel" aria-label="Properties panel">
      {/* Brush / tool options */}
      <section className="card" aria-label="Tool settings">
        <h3>{TOOLS.find((t) => t.id === st.tool)?.label ?? 'Tool'} options</h3>
        <div className="row">
          <label className="grow">Stroke
            <input type="color" value={st.strokeColor} aria-label="Stroke color"
              onChange={(e) => store.ui({ strokeColor: e.target.value })} /></label>
          <label className="grow">Fill
            <input type="color" value={st.fillColor} aria-label="Fill color"
              onChange={(e) => store.ui({ fillColor: e.target.value })} /></label>
        </div>
        <div className="row wrap" role="group" aria-label="Palette">
          {PALETTE.map((c) => (
            <button key={c} className="btn small" style={{ background: c, width: 26, height: 22, borderRadius: 6 }}
              aria-label={`Use color ${c}`}
              onClick={() => store.ui({ strokeColor: c })}
              onContextMenu={(e) => { e.preventDefault(); store.ui({ fillColor: c }); }} />
          ))}
        </div>
        <label>Size {st.brushSize}px
          <input type="range" min={1} max={80} value={st.brushSize} aria-label="Brush size"
            onChange={(e) => store.ui({ brushSize: Number(e.target.value) })} /></label>
        <label>Opacity {Math.round(st.brushOpacity * 100)}%
          <input type="range" min={5} max={100} value={st.brushOpacity * 100} aria-label="Brush opacity"
            onChange={(e) => store.ui({ brushOpacity: Number(e.target.value) / 100 })} /></label>
        <label>Line width {st.strokeWidth}px
          <input type="range" min={1} max={24} value={st.strokeWidth} aria-label="Line width"
            onChange={(e) => store.ui({ strokeWidth: Number(e.target.value) })} /></label>
        <label>Fill tolerance {st.fillTolerance}
          <input type="range" min={0} max={120} value={st.fillTolerance} aria-label="Flood fill tolerance"
            onChange={(e) => store.ui({ fillTolerance: Number(e.target.value) })} /></label>
      </section>

      {/* Layers */}
      <section className="card" aria-label="Layers">
        <h3>Layers</h3>
        <div className="layers-list" data-testid="layers-list">
          {[...(scene?.layers ?? [])].reverse().map((l, revIdx) => {
            const idx = (scene?.layers.length ?? 0) - 1 - revIdx;
            return (
              <div key={l.id} className={`layer-row${st.selectedLayerId === l.id ? ' selected' : ''}`}
                onClick={() => store.ui({ selectedLayerId: l.id })} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') store.ui({ selectedLayerId: l.id }); }}
                aria-label={`Layer ${l.name}`}>
                <button className="btn small" title={l.visible ? 'Hide layer' : 'Show layer'} aria-label="Toggle visibility"
                  onClick={(e) => { e.stopPropagation(); store.patchLayer(l.id, { visible: !l.visible }, 'Toggle layer visibility'); }}>
                  {l.visible ? '👁' : '–'}
                </button>
                <button className="btn small" title={l.locked ? 'Unlock' : 'Lock'} aria-label="Toggle lock"
                  onClick={(e) => { e.stopPropagation(); store.patchLayer(l.id, { locked: !l.locked }, 'Toggle layer lock'); }}>
                  {l.locked ? '🔒' : '🔓'}
                </button>
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                <input type="number" min={0} max={100} defaultValue={Math.round(l.opacity * 100)} style={{ width: 52 }}
                  title="Layer opacity %" aria-label={`${l.name} opacity`}
                  onBlur={(e) => store.patchLayer(l.id, { opacity: Math.min(1, Math.max(0, Number(e.target.value) / 100)) }, 'Layer opacity')} />
                <button className="btn small" title="Move up" aria-label="Move layer up" disabled={idx >= (scene?.layers.length ?? 0) - 1}
                  onClick={(e) => { e.stopPropagation(); store.moveLayer(l.id, 1); }}>▲</button>
                <button className="btn small" title="Move down" aria-label="Move layer down" disabled={idx <= 0}
                  onClick={(e) => { e.stopPropagation(); store.moveLayer(l.id, -1); }}>▼</button>
                <button className="btn small danger" title="Delete layer" aria-label="Delete layer"
                  onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete layer “${l.name}”?`)) store.deleteLayer(l.id); }}>✕</button>
              </div>
            );
          })}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => store.addLayer()}>+ Add layer</button>
          {layer && (
            <button className="btn small" onClick={() => {
              const n = window.prompt('Rename layer', layer.name);
              if (n) store.patchLayer(layer.id, { name: n }, 'Rename layer');
            }}>Rename</button>
          )}
        </div>
      </section>

      {/* Object properties */}
      <section className="card" aria-label="Object properties">
        <h3>Object {obj ? `(${obj.kind})` : ''}</h3>
        {!obj && selected.length === 0 && <div className="muted">Select an object with the Select tool to edit it.</div>}
        {selected.length > 1 && <div className="muted">{selected.length} objects selected — actions apply to all.</div>}
        {obj && (
          <>
            <div className="row">
              <label className="grow">X <input type="number" value={Math.round(obj.transform.x)} aria-label="Position X"
                onChange={(e) => store.updateObjects([obj.id], (o) => ({ ...o, transform: { ...o.transform, x: Number(e.target.value) } }), 'Set X')} /></label>
              <label className="grow">Y <input type="number" value={Math.round(obj.transform.y)} aria-label="Position Y"
                onChange={(e) => store.updateObjects([obj.id], (o) => ({ ...o, transform: { ...o.transform, y: Number(e.target.value) } }), 'Set Y')} /></label>
            </div>
            <div className="row">
              <label className="grow">Scale <input type="number" step={0.05} value={obj.transform.scaleX} aria-label="Scale"
                onChange={(e) => store.updateObjects([obj.id], (o) => ({ ...o, transform: { ...o.transform, scaleX: Number(e.target.value), scaleY: Number(e.target.value) } }), 'Set scale')} /></label>
              <label className="grow">Rotate° <input type="number" value={Math.round(obj.transform.rotation)} aria-label="Rotation"
                onChange={(e) => store.updateObjects([obj.id], (o) => ({ ...o, transform: { ...o.transform, rotation: Number(e.target.value) } }), 'Set rotation')} /></label>
            </div>
            <div className="row">
              <label className="grow">Opacity {Math.round(obj.opacity * 100)}%
                <input type="range" min={0} max={100} value={obj.opacity * 100} aria-label="Object opacity"
                  onChange={(e) => store.updateObjects([obj.id], (o) => ({ ...o, opacity: Number(e.target.value) / 100 }), 'Set opacity')} /></label>
            </div>
            {'fill' in obj && obj.fill && (
              <div className="row">
                <label>Fill
                  <input type="color" value={rgbaToHex(obj.fill)} aria-label="Object fill color"
                    onChange={(e) => store.updateObjects([obj.id], (o) => (o.fill ? { ...o, fill: hexToRgba(e.target.value, o.fill.a) } : o), 'Set fill color')} /></label>
                <span className="muted">{rgbaToCss(obj.fill)}</span>
              </div>
            )}
            <div className="row wrap">
              <button className="btn small" onClick={() => store.duplicateSelected()} title="Ctrl+D">Duplicate</button>
              <button className="btn small danger" onClick={() => store.deleteSelected()} title="Del">Delete</button>
              <button className="btn small" onClick={() => store.reorderObject(obj.id, 1)}>Forward</button>
              <button className="btn small" onClick={() => store.reorderObject(obj.id, -1)}>Backward</button>
              {selected.length > 1 && <button className="btn small" onClick={() => store.groupSelected()}>Group</button>}
              {obj.parentId && <button className="btn small" onClick={() => store.updateObjects([obj.id], (o) => ({ ...o, parentId: null }), 'Ungroup')}>Detach</button>}
            </div>
            <div className="row wrap" aria-label="Motion presets">
              <label className="muted">Preset:</label>
              <select aria-label="Motion preset" defaultValue="" onChange={(e) => { if (e.target.value) store.applyMotionPreset(obj.id, e.target.value); e.target.value = ''; }}>
                <option value="">Choose…</option>
                {['fade-in', 'fade-out', 'move-right', 'slide-up', 'rotate', 'scale-pop', 'bounce', 'blink', 'walk-cycle'].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </section>

      {/* Asset library */}
      <section className="card" aria-label="Asset library">
        <h3>Assets</h3>
        {st.project.assets.length === 0 && <div className="muted">No saved assets yet.</div>}
        <div className="row wrap">
          {st.project.assets.map((a) => (
            <button key={a.id} className="chip" title={`Place “${a.name}” at canvas center`}
              onClick={() => {
                if (!layer || layer.kind !== 'vector' || layer.locked) { store.status('Select an unlocked vector layer first.'); return; }
                const objs = a.kind === 'character' && a.objects ? instantiateAsset(a, (scene?.width ?? 1280) / 2, (scene?.height ?? 720) / 2) : [];
                if (objs.length > 0) {
                  store.run({ label: `Place asset ${a.name}`, apply: (p) => {
                    const sc = p.scenes.find((x) => x.id === p.activeSceneId);
                    const ly = sc?.layers.find((l) => l.id === layer.id);
                    if (ly) ly.objects.push(...objs);
                  } });
                  store.ui({ selectedObjectIds: objs.map((o) => o.id) });
                } else if (a.dataUrl) {
                  store.addObject({
                    id: crypto.randomUUID(), name: a.name, kind: 'image',
                    transform: { x: ((scene?.width ?? 1280) / 2) - 200, y: ((scene?.height ?? 720) / 2) - 150, scaleX: 1, scaleY: 1, rotation: 0 },
                    opacity: 1, visible: true, parentId: null, pivot: null, fill: null, stroke: null, strokeWidth: 0, strokeCap: 'butt', assetId: a.id,
                    size: { width: 400, height: 300 },
                  } as DrawableObject);
                }
              }}>
              {a.kind === 'character' ? '🧍' : a.kind === 'background' ? '🖼' : '📦'} {a.name}
            </button>
          ))}
        </div>
        <div className="row wrap">
          <button className="btn small" onClick={() => {
            const spec = defaultCharacterSpec();
            const { objects } = buildCharacterObjects(spec);
            if (!layer || layer.kind !== 'vector' || layer.locked) { store.status('Select an unlocked vector layer first.'); return; }
            const cx = (scene?.width ?? 1280) / 2, cy = (scene?.height ?? 720) / 2;
            for (const o of objects) { o.transform.x += cx; o.transform.y += cy; }
            store.run({ label: 'Add character', apply: (p) => {
              const sc = p.scenes.find((x) => x.id === p.activeSceneId);
              const ly = sc?.layers.find((l) => l.id === layer.id);
              if (ly) ly.objects.push(...objects);
            } });
            store.ui({ selectedObjectIds: objects.map((o) => o.id) });
          }}>+ Quick character</button>
          <button className="btn small" onClick={() => {
            if (!obj) { store.status('Select objects to save as an asset.'); return; }
            const name = window.prompt('Asset name', 'My asset');
            if (!name) return;
            const ids = st.selectedObjectIds;
            const objs = (scene?.layers.flatMap((l) => l.objects) ?? []).filter((o) => ids.includes(o.id)).map((o) => structuredClone(o));
            store.addAsset({ id: crypto.randomUUID(), name, kind: 'prop', tags: [], createdAt: Date.now(), dataUrl: null, objects: objs, characterSpec: null, rig: null, rasterOnly: false });
            store.status(`Saved asset “${name}”.`);
          }}>Save selection as asset</button>
        </div>
      </section>
      <div style={{ height: 8 }} />
    </aside>
  );
}
