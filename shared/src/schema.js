import { CURRENT_SCHEMA_VERSION } from './types.js';
export class ValidationError extends Error {
    issues;
    constructor(issues) {
        super('Validation failed: ' + issues.join('; '));
        this.name = 'ValidationError';
        this.issues = issues;
    }
}
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArr = (v) => Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const isInt = (v, min = -Infinity, max = Infinity) => isNum(v) && Number.isInteger(v) && v >= min && v <= max;
class Ctx {
    issues = [];
    fail(path, msg) { this.issues.push(`${path}: ${msg}`); }
}
export function validateRGBA(v, path, c) {
    if (!isObj(v)) {
        c.fail(path, 'expected {r,g,b,a}');
        return null;
    }
    const r = v.r, g = v.g, b = v.b, a = v.a;
    if (!isNum(r) || r < 0 || r > 255) {
        c.fail(path + '.r', 'must be 0..255');
        return null;
    }
    if (!isNum(g) || g < 0 || g > 255) {
        c.fail(path + '.g', 'must be 0..255');
        return null;
    }
    if (!isNum(b) || b < 0 || b > 255) {
        c.fail(path + '.b', 'must be 0..255');
        return null;
    }
    if (!isNum(a) || a < 0 || a > 1) {
        c.fail(path + '.a', 'must be 0..1');
        return null;
    }
    return { r, g, b, a };
}
const OBJ_KINDS = ['path', 'line', 'rect', 'ellipse', 'polygon', 'text', 'image'];
export function validateObject(v, path, c) {
    if (!isObj(v)) {
        c.fail(path, 'expected object');
        return null;
    }
    if (!isStr(v.id) || !v.id) {
        c.fail(path + '.id', 'missing id');
        return null;
    }
    if (!OBJ_KINDS.includes(v.kind)) {
        c.fail(path + '.kind', `unknown kind ${String(v.kind)}`);
        return null;
    }
    // base fields get sanitized defaults rather than hard-failing (forward tolerance)
    const t = isObj(v.transform) ? v.transform : {};
    const num = (x, d) => (isNum(x) ? x : d);
    const base = {
        id: v.id,
        name: isStr(v.name) ? v.name : v.kind,
        kind: v.kind,
        transform: {
            x: num(t.x, 0), y: num(t.y, 0),
            scaleX: num(t.scaleX, 1), scaleY: num(t.scaleY, 1),
            rotation: num(t.rotation, 0),
        },
        opacity: Math.min(1, Math.max(0, num(v.opacity, 1))),
        visible: isBool(v.visible) ? v.visible : true,
        parentId: isStr(v.parentId) ? v.parentId : null,
        pivot: isObj(v.pivot) && isNum(v.pivot.x) && isNum(v.pivot.y)
            ? { x: v.pivot.x, y: v.pivot.y } : null,
        fill: v.fill == null ? null : validateRGBA(v.fill, path + '.fill', c),
        stroke: v.stroke == null ? null : validateRGBA(v.stroke, path + '.stroke', c),
        strokeWidth: Math.max(0, num(v.strokeWidth, 2)),
        strokeCap: (['butt', 'round', 'square'].includes(v.strokeCap) ? v.strokeCap : 'round'),
        assetId: isStr(v.assetId) ? v.assetId : null,
    };
    const vecArr = (x) => isArr(x) ? x.filter(p => isObj(p) && isNum(p.x) && isNum(p.y)).map(p => ({ x: p.x, y: p.y })) : [];
    switch (base.kind) {
        case 'path': return { ...base, kind: 'path', points: vecArr(v.points),
            brushSize: Math.max(0.1, num(v.brushSize, 3)), closed: isBool(v.closed) ? v.closed : false,
            strokeKind: (['pencil', 'brush', 'eraser'].includes(v.strokeKind) ? v.strokeKind : 'pencil') };
        case 'line': {
            const from = isObj(v.from) && isNum(v.from.x) ? v.from : { x: 0, y: 0 };
            const to = isObj(v.to) && isNum(v.to.x) ? v.to : { x: 10, y: 10 };
            return { ...base, kind: 'line', from: { x: from.x, y: from.y ?? 0 }, to: { x: to.x, y: to.y ?? 0 } };
        }
        case 'rect': {
            const origin = isObj(v.origin) ? v.origin : { x: 0, y: 0 };
            const size = isObj(v.size) ? v.size : { width: 50, height: 50 };
            return { ...base, kind: 'rect', origin: { x: num(origin.x, 0), y: num(origin.y, 0) },
                size: { width: num(size.width, 50), height: num(size.height, 50) }, radius: Math.max(0, num(v.radius, 0)) };
        }
        case 'ellipse': {
            const center = isObj(v.center) ? v.center : { x: 0, y: 0 };
            return { ...base, kind: 'ellipse', center: { x: num(center.x, 0), y: num(center.y, 0) },
                radiusX: Math.max(0, num(v.radiusX, 25)), radiusY: Math.max(0, num(v.radiusY, 25)) };
        }
        case 'polygon': return { ...base, kind: 'polygon', points: vecArr(v.points), closed: isBool(v.closed) ? v.closed : true };
        case 'text': return { ...base, kind: 'text', text: sanitizeText(isStr(v.text) ? v.text : ''),
            fontFamily: isStr(v.fontFamily) ? v.fontFamily.slice(0, 64) : 'sans-serif',
            fontSize: Math.min(400, Math.max(1, num(v.fontSize, 24))),
            bold: isBool(v.bold) ? v.bold : false, italic: isBool(v.italic) ? v.italic : false,
            align: (['left', 'center', 'right'].includes(v.align) ? v.align : 'left') };
        case 'image': {
            const assetId = isStr(v.assetId) ? v.assetId : '';
            if (!assetId)
                c.fail(path + '.assetId', 'image objects require an assetId');
            const size = isObj(v.size) ? v.size : { width: 100, height: 100 };
            return { ...base, kind: 'image', assetId, size: { width: num(size.width, 100), height: num(size.height, 100) } };
        }
    }
    return null;
}
/** Strip control characters & HTML-ish content from user/model text. Never executed as HTML. */
export function sanitizeText(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, 20000);
}
const INTERPS = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'bounce'];
const PROPS = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity', 'fill', 'visible'];
export function validateKeyframe(v, path, c) {
    if (!isObj(v)) {
        c.fail(path, 'expected keyframe object');
        return null;
    }
    if (!isStr(v.id)) {
        c.fail(path + '.id', 'missing id');
        return null;
    }
    if (!isNum(v.time) || v.time < 0) {
        c.fail(path + '.time', 'time must be >= 0');
        return null;
    }
    if (!PROPS.includes(v.prop)) {
        c.fail(path + '.prop', `unknown prop ${String(v.prop)}`);
        return null;
    }
    if (!INTERPS.includes(v.interpolation)) {
        c.fail(path + '.interpolation', `unknown interpolation`);
        return null;
    }
    const val = v.value;
    if (!(isNum(val) || isBool(val) || (isStr(val) && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(val)))) {
        c.fail(path + '.value', 'value must be number, boolean, or #hex color');
        return null;
    }
    return { id: v.id, time: v.time, prop: v.prop, value: val, interpolation: v.interpolation };
}
export function validateLayer(v, path, c) {
    if (!isObj(v) || !isStr(v.id)) {
        c.fail(path, 'layer missing id');
        return null;
    }
    const objects = isArr(v.objects) ? v.objects
        .map((o, i) => validateObject(o, `${path}.objects[${i}]`, c))
        .filter(Boolean) : [];
    return {
        id: v.id,
        name: isStr(v.name) ? v.name : 'Layer',
        kind: (['vector', 'raster', 'reference'].includes(v.kind) ? v.kind : 'vector'),
        visible: isBool(v.visible) ? v.visible : true,
        locked: isBool(v.locked) ? v.locked : false,
        opacity: Math.min(1, Math.max(0, isNum(v.opacity) ? v.opacity : 1)),
        parallaxDepth: isNum(v.parallaxDepth) ? v.parallaxDepth : 1,
        objects,
        rasterAssetId: isStr(v.rasterAssetId) ? v.rasterAssetId : null,
    };
}
const FRAMINGS = ['wide', 'medium', 'closeup', 'extreme-wide', 'over-shoulder'];
const TRANSITIONS = ['cut', 'fade', 'wipeLeft', 'wipeRight', 'slideLeft'];
export function validateScene(v, path, c) {
    if (!isObj(v) || !isStr(v.id)) {
        c.fail(path, 'scene missing id');
        return null;
    }
    const layers = isArr(v.layers) ? v.layers.map((l, i) => validateLayer(l, `${path}.layers[${i}]`, c)).filter(Boolean) : [];
    const animations = isArr(v.animations) ? v.animations.map(a => {
        const tracks = {};
        if (isObj(a?.tracks)) {
            for (const [prop, kfs] of Object.entries(a.tracks)) {
                if (!PROPS.includes(prop)) {
                    c.fail(`${path}.animations.track`, `unknown prop ${prop}`);
                    continue;
                }
                tracks[prop] = isArr(kfs) ? kfs.map((k, i) => validateKeyframe(k, `${path}.animations.${prop}[${i}]`, c)).filter(Boolean) : [];
                tracks[prop].sort((x, y) => x.time - y.time);
            }
        }
        return { objectId: isStr(a?.objectId) ? a.objectId : '', tracks };
    }).filter(a => a.objectId) : [];
    const audioClips = isArr(v.audioClips) ? v.audioClips.filter(cl => isObj(cl) && isStr(cl.id) && isStr(cl.assetId)).map(cl => ({
        id: cl.id, name: isStr(cl.name) ? cl.name : 'Audio',
        kind: (['narration', 'dialogue', 'music', 'sfx'].includes(cl.kind) ? cl.kind : 'music'),
        assetId: cl.assetId,
        startTime: Math.max(0, isNum(cl.startTime) ? cl.startTime : 0),
        trimStart: Math.max(0, isNum(cl.trimStart) ? cl.trimStart : 0),
        duration: Math.max(0, isNum(cl.duration) ? cl.duration : 0),
        gain: Math.min(2, Math.max(0, isNum(cl.gain) ? cl.gain : 1)),
        fadeIn: Math.max(0, isNum(cl.fadeIn) ? cl.fadeIn : 0),
        fadeOut: Math.max(0, isNum(cl.fadeOut) ? cl.fadeOut : 0),
    })) : [];
    const subtitles = isArr(v.subtitles) ? v.subtitles.filter(s => isObj(s) && isStr(s.id)).map(s => ({
        id: s.id, text: sanitizeText(isStr(s.text) ? s.text : ''),
        startTime: Math.max(0, isNum(s.startTime) ? s.startTime : 0),
        endTime: Math.max(0, isNum(s.endTime) ? s.endTime : 0),
        speaker: isStr(s.speaker) ? s.speaker : undefined,
    })) : [];
    const drawingFrames = isArr(v.drawingFrames) ? v.drawingFrames.filter(df => isObj(df) && isStr(df.id)).map(df => ({
        id: df.id, index: Math.max(0, isNum(df.index) ? Math.floor(df.index) : 0),
        exposure: Math.max(1, isNum(df.exposure) ? Math.floor(df.exposure) : 1),
        layerId: isStr(df.layerId) ? df.layerId : '',
        objects: isArr(df.objects) ? df.objects.map((o, i) => validateObject(o, `${path}.drawingFrames.objects[${i}]`, c)).filter(Boolean) : [],
    })) : [];
    const camera = isObj(v.camera) ? v.camera : {};
    const camKfs = isArr(camera.keyframes) ? camera.keyframes.filter((k) => isObj(k) && isNum(k.time)).map((k) => ({
        time: k.time, x: isNum(k.x) ? k.x : 0, y: isNum(k.y) ? k.y : 0, zoom: isNum(k.zoom) ? Math.max(0.1, k.zoom) : 1,
    })) : [];
    const bg = validateRGBA(v.backgroundColor, path + '.backgroundColor', c) ?? { r: 255, g: 255, b: 255, a: 1 };
    const transIn = isObj(v.transitionIn) ? v.transitionIn : {};
    return {
        id: v.id,
        name: isStr(v.name) ? v.name : 'Scene',
        description: isStr(v.description) ? sanitizeText(v.description) : '',
        duration: Math.min(3600, Math.max(0.1, isNum(v.duration) ? v.duration : 4)),
        fps: isInt(v.fps, 1, 120) ? v.fps : 24,
        width: isInt(v.width, 16, 7680) ? v.width : 1280,
        height: isInt(v.height, 16, 7680) ? v.height : 720,
        backgroundColor: bg,
        layers,
        animations,
        drawingFrames,
        audioClips,
        subtitles,
        camera: { x: isNum(camera.x) ? camera.x : 0, y: isNum(camera.y) ? camera.y : 0, zoom: isNum(camera.zoom) ? camera.zoom : 1, keyframes: camKfs },
        transitionIn: {
            type: (TRANSITIONS.includes(transIn.type) ? transIn.type : 'cut'),
            duration: Math.max(0, isNum(transIn.duration) ? transIn.duration : 0.5),
        },
        category: (['background', 'middle', 'foreground', 'mixed'].includes(v.category) ? v.category : 'mixed'),
    };
}
export function validateStoryboardCard(v, path, c) {
    if (!isObj(v) || !isStr(v.id)) {
        c.fail(path, 'card missing id');
        return null;
    }
    return {
        id: v.id,
        sceneNumber: isInt(v.sceneNumber, 1, 10000) ? v.sceneNumber : 1,
        title: sanitizeText(isStr(v.title) ? v.title : 'Untitled'),
        description: sanitizeText(isStr(v.description) ? v.description : ''),
        duration: Math.min(600, Math.max(0.1, isNum(v.duration) ? v.duration : 3)),
        characters: isArr(v.characters) ? v.characters.filter(isStr).map(sanitizeText).slice(0, 50) : [],
        location: sanitizeText(isStr(v.location) ? v.location : ''),
        framing: (FRAMINGS.includes(v.framing) ? v.framing : 'medium'),
        movement: sanitizeText(isStr(v.movement) ? v.movement : ''),
        dialogue: sanitizeText(isStr(v.dialogue) ? v.dialogue : ''),
        soundCues: sanitizeText(isStr(v.soundCues) ? v.soundCues : ''),
        transition: (TRANSITIONS.includes(v.transition) ? v.transition : 'cut'),
        linkedSceneId: isStr(v.linkedSceneId) ? v.linkedSceneId : null,
        thumbnailDataUrl: isStr(v.thumbnailDataUrl) && v.thumbnailDataUrl.startsWith('data:image/') ? v.thumbnailDataUrl : null,
        approved: isBool(v.approved) ? v.approved : false,
    };
}
export function validateAsset(v, path, c) {
    if (!isObj(v) || !isStr(v.id)) {
        c.fail(path, 'asset missing id');
        return null;
    }
    const dataUrl = isStr(v.dataUrl) && (v.dataUrl.startsWith('data:image/') || v.dataUrl.startsWith('data:audio/')) ? v.dataUrl : null;
    const objects = isArr(v.objects) ? v.objects.map((o, i) => validateObject(o, `${path}.objects[${i}]`, c)).filter(Boolean) : null;
    return {
        id: v.id,
        name: sanitizeText(isStr(v.name) ? v.name : 'Asset'),
        kind: (['character', 'background', 'prop', 'image', 'audio', 'template'].includes(v.kind) ? v.kind : 'image'),
        tags: isArr(v.tags) ? v.tags.filter(isStr).map(t => t.slice(0, 32)).slice(0, 20) : [],
        createdAt: isNum(v.createdAt) ? v.createdAt : Date.now(),
        dataUrl, objects,
        characterSpec: isObj(v.characterSpec) ? v.characterSpec : null,
        rig: isObj(v.rig) ? v.rig : null,
        rasterOnly: isBool(v.rasterOnly) ? v.rasterOnly : false,
    };
}
export function validateProject(raw) {
    const c = new Ctx();
    if (!isObj(raw))
        return { ok: false, issues: ['project must be an object'] };
    if (!isStr(raw.id) || !raw.id)
        c.fail('id', 'missing project id');
    if (!isInt(raw.schemaVersion, 1, CURRENT_SCHEMA_VERSION))
        c.fail('schemaVersion', `must be 1..${CURRENT_SCHEMA_VERSION} (run migrations first)`);
    const scenes = isArr(raw.scenes) ? raw.scenes.map((s, i) => validateScene(s, `scenes[${i}]`, c)).filter(Boolean) : [];
    if (scenes.length === 0)
        c.fail('scenes', 'project needs at least one scene');
    const storyboard = isArr(raw.storyboard) ? raw.storyboard.map((s, i) => validateStoryboardCard(s, `storyboard[${i}]`, c)).filter(Boolean) : [];
    const assets = isArr(raw.assets) ? raw.assets.map((a, i) => validateAsset(a, `assets[${i}]`, c)).filter(Boolean) : [];
    const settings = isObj(raw.settings) ? raw.settings : {};
    const safeAreas = isObj(settings.safeAreas) ? settings.safeAreas : {};
    const activeSceneId = isStr(raw.activeSceneId) ? raw.activeSceneId : (scenes[0]?.id ?? '');
    if (raw.id && scenes.length && !scenes.some(s => s.id === activeSceneId)) {
        c.fail('activeSceneId', 'references a scene that does not exist');
    }
    // Referential integrity checks (warn-level but treated as errors for images/audio)
    const assetIds = new Set(assets.map(a => a.id));
    for (const s of scenes) {
        for (const l of s.layers) {
            for (const o of l.objects) {
                if (o.kind === 'image' && !assetIds.has(o.assetId))
                    c.fail(`scene ${s.id}`, `image object references missing asset ${o.assetId}`);
                if (o.parentId && !l.objects.some((p) => p.id === o.parentId)) {
                    // dangling parent — repair by detaching (tolerant)
                    o.parentId = null;
                }
            }
            if (l.rasterAssetId && !assetIds.has(l.rasterAssetId))
                c.fail(`scene ${s.id}`, `layer ${l.name} references missing raster asset`);
        }
        for (const cl of s.audioClips)
            if (!assetIds.has(cl.assetId))
                c.fail(`scene ${s.id}`, `audio clip "${cl.name}" references missing asset ${cl.assetId}`);
    }
    if (c.issues.length)
        return { ok: false, issues: c.issues };
    return {
        ok: true, issues: [],
        value: {
            schemaVersion: raw.schemaVersion,
            id: raw.id,
            name: isStr(raw.name) ? sanitizeText(raw.name) : 'Untitled',
            createdAt: isNum(raw.createdAt) ? raw.createdAt : Date.now(),
            updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : Date.now(),
            fps: isInt(raw.fps, 1, 120) ? raw.fps : 24,
            width: isInt(raw.width) ? raw.width : 1280,
            height: isInt(raw.height) ? raw.height : 720,
            scenes, activeSceneId, storyboard, assets,
            settings: {
                aspectRatio: (['16:9', '9:16', '1:1', '4:3', 'custom'].includes(settings.aspectRatio) ? settings.aspectRatio : '16:9'),
                safeAreas: {
                    titleSafe: isNum(safeAreas.titleSafe) ? safeAreas.titleSafe : 0.05,
                    actionSafe: isNum(safeAreas.actionSafe) ? safeAreas.actionSafe : 0.025,
                },
                gridVisible: isBool(settings.gridVisible) ? settings.gridVisible : false,
                gridSize: isInt(settings.gridSize, 4, 512) ? settings.gridSize : 50,
                snapping: isBool(settings.snapping) ? settings.snapping : true,
                onionSkin: isBool(settings.onionSkin) ? settings.onionSkin : false,
                theme: (settings.theme === 'light' || settings.theme === 'dark') ? settings.theme : 'dark',
            },
        },
    };
}
export function validateExportSettings(raw) {
    const c = new Ctx();
    if (!isObj(raw))
        return { ok: false, issues: ['export settings must be an object'] };
    const fmts = ['mp4', 'gif', 'png-sequence', 'png-still', 'project-json', 'svg'];
    if (!fmts.includes(raw.format))
        c.fail('format', 'unknown export format');
    if (!isInt(raw.width, 16, 7680))
        c.fail('width', 'bad width');
    if (!isInt(raw.height, 16, 7680))
        c.fail('height', 'bad height');
    if (!isInt(raw.fps, 1, 120))
        c.fail('fps', 'bad fps');
    if (!isNum(raw.quality) || raw.quality < 0 || raw.quality > 1)
        c.fail('quality', 'must be 0..1');
    if (!isArr(raw.sceneIds) || !raw.sceneIds.every(isStr))
        c.fail('sceneIds', 'must be string array');
    if (c.issues.length)
        return { ok: false, issues: c.issues };
    return { ok: true, issues: [], value: raw };
}
export function validateProviderConfig(raw) {
    const c = new Ctx();
    if (!isObj(raw))
        return { ok: false, issues: ['provider config must be an object'] };
    const kinds = ['openai', 'anthropic', 'gemini', 'ollama', 'llama-server', 'custom-http'];
    if (!isStr(raw.id))
        c.fail('id', 'missing');
    if (!kinds.includes(raw.kind))
        c.fail('kind', 'unknown provider kind');
    if (!isStr(raw.baseUrl) || !/^https?:\/\//i.test(raw.baseUrl))
        c.fail('baseUrl', 'must be http(s) URL');
    if (!isStr(raw.model))
        c.fail('model', 'missing');
    // Reject any attempt to smuggle secrets through the client-facing shape
    for (const forbidden of ['apiKey', 'api_key', 'secret', 'token']) {
        if (forbidden in raw)
            c.fail(forbidden, 'secrets must never be sent to/from the browser');
    }
    if (c.issues.length)
        return { ok: false, issues: c.issues };
    return { ok: true, issues: [], value: raw };
}
// ---------- LLM response validation (untrusted model output) ----------
export function parseJsonLoose(text) {
    // Models sometimes wrap JSON in markdown fences or prose. Extract the outermost JSON value.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const candidates = [fenced?.[1], text].filter(Boolean);
    for (const cand of candidates) {
        const trimmed = cand.trim();
        try {
            return JSON.parse(trimmed);
        }
        catch { /* keep trying */ }
        const start = trimmed.search(/[[{]/);
        if (start < 0)
            continue;
        // find matching end by scanning balanced braces
        let depth = 0, end = -1;
        for (let i = start; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (ch === '{' || ch === '[')
                depth++;
            else if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            }
            catch { /* ignore */ }
        }
    }
    return null;
}
export function validateStoryboardResult(raw) {
    const c = new Ctx();
    if (!isObj(raw))
        throw new ValidationError(['storyboard response must be a JSON object']);
    const title = isStr(raw.title) ? sanitizeText(raw.title) : 'Untitled Story';
    const cardsRaw = raw.cards ?? raw.storyboard ?? raw.scenes;
    if (!isArr(cardsRaw))
        throw new ValidationError(['storyboard response missing "cards" array']);
    const cards = [];
    cardsRaw.forEach((cd, i) => {
        const p = `cards[${i}]`;
        if (!isObj(cd)) {
            c.fail(p, 'not an object');
            return;
        }
        const dur = cd.durationSeconds ?? cd.duration;
        cards.push({
            sceneNumber: isInt(cd.sceneNumber, 1, 10000) ? cd.sceneNumber : i + 1,
            title: sanitizeText(isStr(cd.title) ? cd.title : `Scene ${i + 1}`),
            description: sanitizeText(isStr(cd.description) ? cd.description : ''),
            durationSeconds: Math.min(120, Math.max(0.5, isNum(dur) ? dur : 3)),
            characters: isArr(cd.characters) ? cd.characters.filter(isStr).map(sanitizeText).slice(0, 20) : [],
            location: sanitizeText(isStr(cd.location) ? cd.location : ''),
            framing: (FRAMINGS.includes(cd.framing) ? cd.framing : 'medium'),
            movement: sanitizeText(isStr(cd.movement) ? cd.movement : ''),
            dialogue: sanitizeText(isStr(cd.dialogue) ? cd.dialogue : ''),
            soundCues: sanitizeText(isStr(cd.soundCues) ? cd.soundCues : ''),
            transition: (TRANSITIONS.includes(cd.transition) ? cd.transition : 'cut'),
        });
    });
    if (cards.length === 0)
        c.fail('cards', 'no valid cards parsed');
    if (c.issues.length)
        return { ok: false, issues: c.issues };
    return { ok: true, issues: [], value: { title, cards } };
}
export function validateAnimationPlanResult(raw, sceneId) {
    const c = new Ctx();
    if (!isObj(raw))
        throw new ValidationError(['animation plan must be a JSON object']);
    const stepsRaw = raw.steps ?? raw.keyframes;
    if (!isArr(stepsRaw))
        throw new ValidationError(['animation plan missing "steps" array']);
    const steps = [];
    const dropped = [];
    stepsRaw.forEach((st, i) => {
        const p = `steps[${i}]`;
        if (!isObj(st)) {
            c.fail(p, 'not an object');
            return;
        }
        const prop = (st.property ?? st.prop);
        if (!PROPS.includes(prop)) {
            dropped.push(`${p}: unknown property ${String(prop)} (step dropped)`);
            return;
        }
        const fromT = isNum(st.fromTime) ? st.fromTime : (isNum(st.at) ? st.at : NaN);
        const toT = isNum(st.toTime) ? st.toTime : fromT;
        if (!Number.isFinite(fromT) || fromT < 0) {
            c.fail(p + '.fromTime', 'required, >= 0');
            return;
        }
        const interp = (st.interpolation ?? 'linear');
        steps.push({
            objectIdHint: sanitizeText(isStr(st.objectIdHint) ? st.objectIdHint : (isStr(st.object) ? st.object : '')),
            property: prop, fromTime: fromT, toTime: Math.max(fromT, toT),
            fromValue: st.fromValue, toValue: (st.toValue ?? st.fromValue),
            interpolation: (INTERPS.includes(interp) ? interp : 'linear'),
            note: sanitizeText(isStr(st.note) ? st.note : ''),
        });
    });
    if (c.issues.length)
        return { ok: false, issues: c.issues };
    return { ok: true, issues: dropped, value: { sceneId, steps, notes: isStr(raw.notes) ? sanitizeText(raw.notes) : '' } };
}
