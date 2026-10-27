/**
 * FFmpeg-backed export pipeline.
 * Client renders deterministic frames (PNG) and streams them in chunks to /api/export/session,
 * then calls finalize with an optional audio manifest; server encodes MP4 (H.264/AAC), GIF, or
 * returns the PNG sequence as a zip-less directory download (tar via ffmpeg not needed — we zip
 * with a tiny store-only ZIP writer). Progress & cancel supported.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface AudioManifestItem {
  /** data URL of the audio file (mp3/wav/ogg/m4a) */
  dataUrl: string;
  startTime: number;   // seconds on the output timeline
  trimStart: number;
  duration: number;
  gain: number;        // 0..2
  fadeIn: number;
  fadeOut: number;
}

export interface EncodeJob {
  id: string;
  dir: string;
  framesDir: string;
  format: 'mp4' | 'gif';
  fps: number;
  width: number;
  height: number;
  quality: number;      // 0..1
  status: 'receiving' | 'encoding' | 'done' | 'error' | 'cancelled';
  error?: string;
  outputFile?: string;
  frameCount: number;
  proc?: ReturnType<typeof spawn>;
  createdAt: number;
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const jobs = new Map<string, EncodeJob>();

export async function checkFfmpeg(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(FFMPEG, ['-version'], (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    return { ok: true, version: out.split('\n')[0] };
  } catch {
    return { ok: false, error: 'FFmpeg not found. Install it (e.g. `apt install ffmpeg`) or set FFMPEG_PATH.' };
  }
}

export function createJob(opts: { format: 'mp4' | 'gif'; fps: number; width: number; height: number; quality: number }): EncodeJob {
  const id = crypto.randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `studio-export-${id.slice(0, 8)}-`));
  const framesDir = path.join(dir, 'frames');
  fs.mkdirSync(framesDir);
  const job: EncodeJob = { id, dir, framesDir, ...opts, status: 'receiving', frameCount: 0, createdAt: Date.now() };
  jobs.set(id, job);
  // cleanup old jobs (>2h)
  for (const [jid, j] of jobs) {
    if (Date.now() - j.createdAt > 2 * 3600_000) { cancelJob(jid); cleanupJob(jid); }
  }
  return job;
}

export function getJob(id: string): EncodeJob | undefined { return jobs.get(id); }

export function writeFrame(job: EncodeJob, index: number, pngBase64: string): void {
  if (job.status !== 'receiving') throw new Error(`Job ${job.id} is not receiving frames (${job.status})`);
  const buf = Buffer.from(pngBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (buf.length === 0 || buf.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('Chunk is not a PNG image.');
  const name = `frame${String(index).padStart(6, '0')}.png`;
  fs.writeFileSync(path.join(job.framesDir, name), buf);
  job.frameCount = Math.max(job.frameCount, index + 1);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.proc) { try { job.proc.kill('SIGKILL'); } catch { /* ignore */ } }
  if (job.status === 'receiving' || job.status === 'encoding') job.status = 'cancelled';
  return true;
}

export function cleanupJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function buildAudioInputs(job: EncodeJob, items: AudioManifestItem[]): { files: string[]; filter: string; inputs: string[] } {
  const files: string[] = [];
  const inputs: string[] = [];
  const labels: string[] = [];
  items.forEach((it, i) => {
    const m = /^data:audio\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(it.dataUrl);
    if (!m) throw new Error(`Audio clip "${'clip' + i}" has unsupported encoding.`);
    const ext = m[1] === 'mpeg' ? 'mp3' : m[1] === 'wav' || m[1] === 'x-wav' ? 'wav' : m[1] === 'ogg' ? 'ogg' : m[1] === 'mp4' ? 'm4a' : m[1];
    const f = path.join(job.dir, `audio${i}.${ext}`);
    fs.writeFileSync(f, Buffer.from(m[2], 'base64'));
    files.push(f);
    // input opts: seek + loop off; delay applied via adelay filter
    inputs.push('-i', f);
    const gain = Math.max(0, Math.min(2, it.gain ?? 1));
    const fadeParts: string[] = [];
    if (it.fadeIn > 0) fadeParts.push(`afade=t=in:st=${it.trimStart}:d=${it.fadeIn}`);
    if (it.fadeOut > 0) fadeParts.push(`afade=t=out:st=${Math.max(0, it.trimStart + it.duration - it.fadeOut)}:d=${it.fadeOut}`);
    const chain = [`[${i + 1}:a]atrim=start=${it.trimStart}:duration=${it.duration},asetpts=PTS-STARTPTS`,
      ...(fadeParts.length ? [fadeParts.join(',')] : []),
      `volume=${gain}`, `adelay=${Math.round(Math.max(0, it.startTime) * 1000)}|${Math.round(Math.max(0, it.startTime) * 1000)}`
    ].join(',');
    labels.push(`${chain}[a${i}]`);
  });
  let filter = labels.join(';');
  if (labels.length > 1) filter += `;${labels.map((_, i) => `[a${i}]`).join('')}amix=inputs=${labels.length}:normalize=0[mix]`;
  else if (labels.length === 1) filter = filter.replace(/\[a0\]$/, '[mix]');
  return { files, filter, inputs };
}

export async function finalize(jobId: string, audio: AudioManifestItem[]): Promise<{ outputFile: string }> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Unknown export job.');
  if (job.status === 'cancelled') throw new Error('Export was cancelled.');
  if (job.frameCount === 0) throw new Error('No frames were received for this export.');
  job.status = 'encoding';

  const out = path.join(job.dir, job.format === 'mp4' ? 'output.mp4' : 'output.gif');
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];

  const validAudio = audio.filter(a => a.duration > 0.01);
  let audioMix = '';
  if (job.format === 'mp4' && validAudio.length > 0) {
    const built = buildAudioInputs(job, validAudio);
    args.push(...built.inputs);
    args.push('-filter_complex', built.filter, '-map', '[mix]', '-c:a', 'aac', '-b:a', '160k');
    audioMix = 'mixed ' + built.files.length + ' audio clips';
  }

  const pattern = path.join(job.framesDir, 'frame%06d.png');
  const videoArgs: string[] = ['-framerate', String(job.fps), '-i', pattern];
  if (job.format === 'mp4') {
    const crf = Math.round(30 - 20 * job.quality); // quality 1 -> crf10, 0 -> crf30
    videoArgs.push(
      '-vf', `scale=${job.width}:${job.height}:force_original_aspect_ratio=decrease,pad=${job.width}:${job.height}:(ow-iw)/2:(oh-ih)/2,fps=${job.fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    if (!validAudio.length) videoArgs.push('-an');
  } else {
    // GIF: palettegen + paletteuse for good colors at reasonable size
    const pal = path.join(job.dir, 'palette.png');
    const gifScale = Math.min(job.width, 720);
    const gifH = Math.round(job.height * (gifScale / job.width));
    const vf = `fps=${Math.min(job.fps, 30)},scale=${gifScale}:${gifH}:flags=lanczos`;
    await runFfmpeg([...args, ...videoArgs, '-vf', `${vf},palettegen=stats_mode=diff`, pal]);
    videoArgs.push('-i', pal,
      '-filter_complex', `[0:v]${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
      '-map', '[x]', '-loop', '0', '-pix_fmt', 'auto');
    audioMix = '(GIF has no audio)';
  }
  args.push(...videoArgs);
  args.push(out);

  await runFfmpeg(args, job);
  job.status = 'done';
  job.outputFile = out;
  return { outputFile: out };
}

function runFfmpeg(args: string[], job?: EncodeJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) job.proc = proc;
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.on('error', (e) => {
      if (job) job.status = 'error';
      reject(new Error(e.message.includes('ENOENT') ? 'FFmpeg binary not found.' : `FFmpeg failed: ${e.message}`));
    });
    proc.on('close', (code) => {
      if (job?.status === 'cancelled') { reject(new Error('Export cancelled.')); return; }
      if (code === 0) resolve();
      else {
        if (job) job.status = 'error';
        reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-500)}`));
      }
    });
  });
}

/** Store-only ZIP writer for PNG sequences (no deps). */
export function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); // stored, no flags
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // date placeholder
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(e.data.length, 20); cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
