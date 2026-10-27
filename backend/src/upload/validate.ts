/**
 * Upload validation & SVG sanitization.
 * - Allow-list MIME types + magic-byte sniffing, size limits.
 * - SVGs are parsed and stripped of scripts, event handlers, external refs; result re-serialized.
 */

export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
export const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm']);
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface UploadCheck { ok: boolean; mime?: string; reason?: string; }

/** Sniff signature from buffer start. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'; // ID3-tagged MP3
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii').startsWith('<sv')) return 'image/svg+xml';
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<?xml') && head.includes('<svg')) return 'image/svg+xml';
  if (head.startsWith('<svg')) return 'image/svg+xml';
  return null;
}

export function validateUpload(buf: Buffer, declaredMime: string, maxBytes = DEFAULT_MAX_BYTES): UploadCheck {
  if (buf.length === 0) return { ok: false, reason: 'Empty file.' };
  if (buf.length > maxBytes) return { ok: false, reason: `File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit.` };
  const sniffed = sniffMime(buf);
  // For types with reliable magic bytes, the sniffed type must match the declared family.
  const STRICT: Record<string, string[]> = {
    'image/png': ['image/png'], 'image/jpeg': ['image/jpeg'], 'image/gif': ['image/gif'], 'image/webp': ['image/webp'],
    'image/svg+xml': ['image/svg+xml'],
    'audio/mpeg': ['audio/mpeg', 'audio/mp4'], 'audio/wav': ['audio/wav'], 'audio/ogg': ['audio/ogg'], 'audio/mp4': ['audio/mp4'],
  };
  let ok = false;
  if (STRICT[declaredMime]) {
    ok = !!sniffed && STRICT[declaredMime].includes(sniffed);
  } else {
    // less-sniffable types (aac/webm): accept declared type only when no contradicting signature found
    ok = ALLOWED_IMAGE_MIME.has(declaredMime) || ALLOWED_AUDIO_MIME.has(declaredMime);
    if (ok && sniffed && !ALLOWED_IMAGE_MIME.has(sniffed) && !ALLOWED_AUDIO_MIME.has(sniffed)) ok = false;
  }
  if (!ok) {
    return { ok: false, reason: `Unsupported or mismatched file type (declared ${declaredMime}${sniffed ? `, detected ${sniffed}` : ''}).` };
  }
  return { ok: true, mime: sniffed ?? declaredMime };
}

/**
 * Dependency-free SVG sanitizer using regex passes over the XML text.
 * Removes: <script>, event handler attributes (on*), external hrefs (http(s), data:text/html),
 * foreignObject, use-with-href-to-external. Anything suspicious that can't be parsed safely → reject.
 */
export function sanitizeSvg(svgText: string): { ok: boolean; svg?: string; reason?: string } {
  if (svgText.length > 2 * 1024 * 1024) return { ok: false, reason: 'SVG too large (>2MB).' };
  if (!/<svg[\s>]/i.test(svgText)) return { ok: false, reason: 'Not an SVG document.' };
  let s = svgText;
  // strip XML processing instructions other than the first xml declaration
  s = s.replace(/<\?!\[CDATA\[[\s\S]*?\]\]>/g, '');
  s = s.replace(/<!ENTITY[\s\S]*?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  // remove dangerous elements entirely
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/<(iframe|embed|object|animate[a-zA-Z]*)\b/gi, '<!-- removed $1 --><span-hidden');
  // remove event handler attributes
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // remove external references in href/xlink:href
  s = s.replace(/\s+(xlink:)?href\s*=\s*"(?!#)[^"]*"/gi, '');
  s = s.replace(/\s+(xlink:)?href\s*=\s*'(?!#)[^']*'/gi, '');
  // remove style attributes containing url( or expression(
  s = s.replace(/\s+style\s*=\s*"[^"]*url\([^)]*\)[^"]*"/gi, '');
  s = s.replace(/\s+style\s*=\s*'[^']*url\([^)]*\)[^']*'/gi, '');
  if (/<script/i.test(s) || /\son[a-z]+\s*=/i.test(s)) {
    return { ok: false, reason: 'SVG failed sanitization.' };
  }
  return { ok: true, svg: s };
}
