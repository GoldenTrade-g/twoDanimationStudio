/**
 * Simple 2D Animation Studio — versioned project data model.
 * All IDs are stable strings (uuid-like). References are explicit IDs, never object graphs.
 */

export const CURRENT_SCHEMA_VERSION = 3;

export type Id = string;

// ---------- Geometry & color ----------
export interface Vec2 { x: number; y: number; }
export interface Size { width: number; height: number; }

/** RGBA with r,g,b in 0..255 and a in 0..1 */
export interface RGBA { r: number; g: number; b: number; a: number; }

export interface Transform {
  x: number;          // translation X (px, scene coords)
  y: number;          // translation Y
  scaleX: number;
  scaleY: number;
  rotation: number;   // degrees
}

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

// ---------- Drawable objects (vector, retained editable in the model) ----------
export type StrokeCap = 'butt' | 'round' | 'square';

export interface BaseObject {
  id: Id;
  name: string;
  kind: 'path' | 'line' | 'rect' | 'ellipse' | 'polygon' | 'text' | 'image';
  transform: Transform;
  opacity: number;         // 0..1
  visible: boolean;
  /** Parent object id for character rigs / groups. null = top-level in layer. */
  parentId: Id | null;
  /** Pivot for rotation/scale, in local coords (defaults to bbox center). */
  pivot: Vec2 | null;
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
  strokeCap: StrokeCap;
  /** If set, object is an instance of a library asset. */
  assetId: Id | null;
}

export interface PathObject extends BaseObject {
  kind: 'path';
  /** Polyline points in local coordinates. brushSize gives visual thickness for freehand. */
  points: Vec2[];
  brushSize: number;
  closed: boolean;
  /** 'pencil' | 'brush' | 'eraser' — eraser paths use destination-out compositing. */
  strokeKind: 'pencil' | 'brush' | 'eraser';
}

export interface LineObject extends BaseObject {
  kind: 'line';
  from: Vec2;
  to: Vec2;
}

export interface RectObject extends BaseObject {
  kind: 'rect';
  origin: Vec2;   // local top-left
  size: Size;
  radius: number; // corner radius
}

export interface EllipseObject extends BaseObject {
  kind: 'ellipse';
  center: Vec2;
  radiusX: number;
  radiusY: number;
}

export interface PolygonObject extends BaseObject {
  kind: 'polygon';
  points: Vec2[];
  closed: boolean;
}

export interface TextObject extends BaseObject {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
}

export interface ImageObject extends BaseObject {
  kind: 'image';
  assetId: Id;      // required for images
  size: Size;       // draw size in local coords
}

export type DrawableObject =
  | PathObject | LineObject | RectObject | EllipseObject
  | PolygonObject | TextObject | ImageObject;

// ---------- Layers ----------
export type LayerKind = 'vector' | 'raster' | 'reference';

export interface Layer {
  id: Id;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number;             // 0..1
  /** Parallax depth: 1 = foreground, 0.5 = midground, 0.2 = background. */
  parallaxDepth: number;
  /** Vector layers hold editable objects. */
  objects: DrawableObject[];
  /** Raster/reference layers reference a bitmap asset (data stored in Asset.dataUrl). */
  rasterAssetId: Id | null;
}

// ---------- Keyframes & animation ----------
export type Interpolation = 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bounce';
export type AnimatableProp = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity' | 'fill' | 'visible';

export interface Keyframe {
  id: Id;
  time: number;               // seconds from scene start
  prop: AnimatableProp;
  value: number | string | boolean; // numbers, '#rrggbb' colors, booleans
  interpolation: Interpolation;
}

/** One animatable object's keyframes grouped by property. */
export interface ObjectAnimation {
  objectId: Id;
  tracks: Record<string, Keyframe[]>; // prop -> sorted keyframes
}

export interface TimelineTrack {
  id: Id;
  name: string;
  kind: 'object' | 'audio' | 'subtitle';
  targetId: Id;              // object id / audio clip id / subtitle id
  muted?: boolean;
}

// ---------- Audio & subtitles ----------
export interface AudioClip {
  id: Id;
  name: string;
  kind: 'narration' | 'dialogue' | 'music' | 'sfx';
  assetId: Id;               // audio asset
  startTime: number;         // seconds on scene timeline
  trimStart: number;         // seconds into source
  duration: number;          // seconds to play
  gain: number;              // 0..2
  fadeIn: number;            // seconds
  fadeOut: number;           // seconds
}

export interface Subtitle {
  id: Id;
  text: string;
  startTime: number;
  endTime: number;
  speaker?: string;
}

// ---------- Camera & transitions ----------
export interface CameraKeyframe { time: number; x: number; y: number; zoom: number; }

export interface Camera {
  x: number; y: number; zoom: number;
  keyframes: CameraKeyframe[];
}

export type TransitionType = 'cut' | 'fade' | 'wipeLeft' | 'wipeRight' | 'slideLeft';

export interface Transition {
  type: TransitionType;
  duration: number; // seconds
}

// ---------- Frame-by-frame drawing exposure ----------
export interface DrawingFrame {
  id: Id;
  index: number;          // frame number at scene fps
  exposure: number;       // how many frames this drawing holds
  layerId: Id;
  objects: DrawableObject[];
}

// ---------- Scenes ----------
export type SceneCategory = 'background' | 'middle' | 'foreground' | 'mixed';

export interface Scene {
  id: Id;
  name: string;
  description: string;
  duration: number;        // seconds
  fps: number;             // 12 | 24 | 30 | custom
  width: number;
  height: number;
  backgroundColor: RGBA;
  layers: Layer[];
  animations: ObjectAnimation[];
  drawingFrames: DrawingFrame[];
  audioClips: AudioClip[];
  subtitles: Subtitle[];
  camera: Camera;
  transitionIn: Transition;
  category: SceneCategory;
}

// ---------- Storyboard ----------
export type CameraFraming = 'wide' | 'medium' | 'closeup' | 'extreme-wide' | 'over-shoulder';

export interface StoryboardCard {
  id: Id;
  sceneNumber: number;
  title: string;
  description: string;
  duration: number;              // seconds
  characters: string[];          // character asset ids or names
  location: string;
  framing: CameraFraming;
  movement: string;              // camera/subject movement note
  dialogue: string;
  soundCues: string;
  transition: TransitionType;
  linkedSceneId: Id | null;      // scene created from this card
  thumbnailDataUrl: string | null;
  approved: boolean;
}

// ---------- Assets ----------
export type AssetKind = 'character' | 'background' | 'prop' | 'image' | 'audio' | 'template';

export interface CharacterPart {
  id: Id;
  role: 'head' | 'torso' | 'eyeL' | 'eyeR' | 'eyebrowL' | 'eyebrowR' | 'mouth' | 'hair' | 'armL' | 'armR' | 'legL' | 'legR' | 'handL' | 'handR' | 'footL' | 'footR' | string;
  object: DrawableObject;
  parentPartId: Id | null;
  pivot: Vec2;                    // joint pivot in part-local coords
}

export interface CharacterRig {
  parts: CharacterPart[];
  rootPartId: Id;
}

export interface CharacterSpec {
  bodyShape: 'round' | 'slim' | 'square';
  skinColor: string;
  headSize: number;      // multiplier
  torsoSize: number;
  limbLength: number;
  eyeStyle: 'dots' | 'ovals' | 'cartoon';
  mouthStyle: 'smile' | 'flat' | 'open' | 'frown';
  hairStyle: 'none' | 'short' | 'long' | 'spiky' | 'bun';
  shirtColor: string;
  pantsColor: string;
  expression: 'neutral' | 'happy' | 'sad' | 'surprised' | 'angry';
}

export interface Asset {
  id: Id;
  name: string;
  kind: AssetKind;
  tags: string[];
  createdAt: number;
  /** For image/audio/raster: data URL. */
  dataUrl: string | null;
  /** For vector assets: serializable object list (editable!). */
  objects: DrawableObject[] | null;
  characterSpec: CharacterSpec | null;
  rig: CharacterRig | null;
  /** true when asset came from AI/image-gen and is a flattened raster (not auto-vectorized). */
  rasterOnly: boolean;
}

// ---------- Project ----------
export type AspectRatioName = '16:9' | '9:16' | '1:1' | '4:3' | 'custom';

export interface SafeAreaGuides {
  titleSafe: number;    // fraction inset (e.g. 0.05)
  actionSafe: number;
}

export interface ProjectSettings {
  aspectRatio: AspectRatioName;
  safeAreas: SafeAreaGuides;
  gridVisible: boolean;
  gridSize: number;
  snapping: boolean;
  onionSkin: boolean;
  theme: 'light' | 'dark';
}

export interface Project {
  schemaVersion: number;
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  fps: number;
  width: number;
  height: number;
  scenes: Scene[];
  activeSceneId: Id;
  storyboard: StoryboardCard[];
  assets: Asset[];
  settings: ProjectSettings;
}

// ---------- LLM provider configuration (NO secret values ever stored client-side) ----------
export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'llama-server' | 'custom-http';

export type LLMCapability =
  | 'text' | 'structured-json' | 'image-generation' | 'tts' | 'connection-test';

export interface LLMProviderConfig {
  id: Id;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasSecret: boolean;          // true if server holds an API key for this provider
  capabilities: LLMCapability[];
  isDefault: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

/** Response shape returned to the browser — secrets stripped by design. */
export interface SafeProviderInfo extends LLMProviderConfig {}

// ---------- Export ----------
export type ExportFormat = 'mp4' | 'gif' | 'png-sequence' | 'png-still' | 'project-json' | 'svg';

export interface ExportSettings {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  quality: number;             // 0..1 (crf mapping for mp4, palette for gif)
  includeAudio: boolean;
  sceneIds: Id[];              // subset or all
  transparentPng: boolean;
}

// ---------- Structured LLM schemas ----------
export interface ScriptResult { title: string; logline: string; scenes: { heading: string; action: string; dialogue: { speaker: string; line: string }[] }[]; }

export interface StoryboardResult {
  title: string;
  cards: {
    sceneNumber: number;
    title: string;
    description: string;
    durationSeconds: number;
    characters: string[];
    location: string;
    framing: CameraFraming;
    movement: string;
    dialogue: string;
    soundCues: string;
    transition: TransitionType;
  }[];
}

export interface AnimationPlanResult {
  sceneId: Id;
  steps: {
    objectIdHint: string;
    property: AnimatableProp;
    fromTime: number;
    toTime: number;
    fromValue: number | string | boolean;
    toValue: number | string | boolean;
    interpolation: Interpolation;
    note: string;
  }[];
  notes: string;
}
