import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

export const imageScheme = 'forge-image';
export const audioScheme = 'forge-audio';
export const videoScheme = 'forge-video';
const previewLifetime = 60 * 60 * 1000;
const documentLifetime = 24 * 60 * 60 * 1000;
const copyPrefix = 'forge-open-';
const ownedDirectory = /^forge-open-[a-zA-Z0-9]{6}$/;
const ownedFile = /^(?:document\.(?:png|jpeg|webp|txt|md|pdf|docx|wav|webm|mp4)|\.forge-export-[a-f0-9-]{36}\.part)$/;
const imageMime = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]);
const videoMime = new Map([['webm', 'video/webm'], ['mp4', 'video/mp4']]);

function mediaRange(header, size) {
  if (header === null) return { start: 0, end: size - 1 };
  const range = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!range || (!range[1] && !range[2])) return undefined;
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (!Number.isSafeInteger(Number(range[1])) || !Number.isSafeInteger(Number(range[2])) || start >= size || start > end) return undefined;
  return { start, end };
}

async function removeCopy(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  for (const name of await readdir(directory)) {
    if (!ownedFile.test(name)) continue;
    const file = path.join(directory, name);
    const entry = await lstat(file);
    if (entry.isFile()) await chmod(file, 0o600);
    if (entry.isFile() || entry.isSymbolicLink()) await unlink(file);
  }
  await rmdir(directory);
}

export class AssetOpen {
  #profile;
  #images = new Map();
  #audio = new Map();
  #videos = new Map();
  #videoGeneration = 0;
  #videoRevisions = new Map();

  constructor(profile) {
    this.#profile = profile;
  }

  async sweep() {
    for (const entry of await readdir(this.#profile, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ownedDirectory.test(entry.name)) continue;
      const directory = path.join(this.#profile, entry.name);
      const info = await lstat(directory).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const remaining = documentLifetime - (Date.now() - info.mtimeMs);
      if (remaining <= 0) await this.discard(directory);
      else this.keepDocument(directory, Math.min(remaining, documentLifetime));
    }
  }

  async copy(format, exportAsset) {
    const directory = await mkdtemp(path.join(this.#profile, copyPrefix));
    const file = path.join(directory, 'document.' + format);
    try {
      const result = await exportAsset(file);
      if (!result.ok) {
        await this.discard(directory);
        return result;
      }
      await chmod(file, 0o400);
      return { ok: true, value: { directory, file, mime: imageMime.get(format) } };
    } catch (error) {
      await this.discard(directory);
      throw error;
    }
  }

  keepDocument(directory, delay = documentLifetime) {
    setTimeout(() => { void this.discard(directory); }, delay).unref();
  }

  async presentImage(copy) {
    const src = imageScheme + '://view/' + randomUUID();
    const timer = setTimeout(() => { void this.releaseImage(src); }, previewLifetime);
    timer.unref();
    this.#images.set(src, { ...copy, timer });
    if (this.#images.size > 4) await this.releaseImage(this.#images.keys().next().value);
    return src;
  }

  async response(request) {
    const image = this.#images.get(request.url);
    if (request.method !== 'GET' || !image) return new Response(null, { status: 404 });
    try {
      const stream = (await open(image.file, 'r')).createReadStream();
      return new Response(Readable.toWeb(stream), {
        headers: {
          'content-type': image.mime,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }

  async releaseImage(src) {
    const image = this.#images.get(src);
    if (!image) return;
    this.#images.delete(src);
    clearTimeout(image.timer);
    await this.discard(image.directory);
  }

  async releaseImages() {
    await Promise.all([...this.#images.keys()].map(src => this.releaseImage(src)));
  }

  async presentAudio(copy) {
    return this.#presentMedia(this.#audio, audioScheme + '://listen/', copy, 'audio/wav');
  }

  async presentVideo(copy, format, nodeId) {
    const mime = videoMime.get(format);
    if (!mime) throw new Error('Video format is unavailable');
    return this.#presentMedia(this.#videos, videoScheme + '://play/', { ...copy, nodeId }, mime);
  }

  async #presentMedia(copies, prefix, copy, mime) {
    const info = await lstat(copy.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Media copy is unavailable');
    const src = prefix + randomUUID();
    const timer = setTimeout(() => { void this.#releaseMedia(copies, src); }, previewLifetime);
    timer.unref();
    copies.set(src, { ...copy, size: info.size, timer, mime, streams: new Set() });
    if (copies.size > 4) await this.#releaseMedia(copies, copies.keys().next().value);
    return src;
  }

  audioResponse(request) {
    return this.#mediaResponse(this.#audio, request);
  }

  videoResponse(request) {
    return this.#mediaResponse(this.#videos, request, { 'access-control-allow-origin': '*' });
  }

  async #mediaResponse(copies, request, extraHeaders = {}) {
    const media = copies.get(request.url);
    if (request.method !== 'GET' || !media) return new Response(null, { status: 404 });
    const range = request.headers.get('range');
    const bounds = mediaRange(range, media.size);
    if (!bounds) return new Response(null, { status: 416, headers: { ...extraHeaders, 'content-range': `bytes */${media.size}` } });
    try {
      const file = await open(media.file, 'r');
      if (copies.get(request.url) !== media) {
        await file.close();
        return new Response(null, { status: 404 });
      }
      const headers = {
        ...extraHeaders,
        'content-type': media.mime,
        'content-length': String(bounds.end - bounds.start + 1),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      if (range !== null) headers['content-range'] = `bytes ${bounds.start}-${bounds.end}/${media.size}`;
      const stream = file.createReadStream(bounds);
      media.streams.add(stream);
      stream.once('close', () => media.streams.delete(stream));
      return new Response(Readable.toWeb(stream), { status: range === null ? 200 : 206, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  }

  releaseAudio(src) {
    return this.#releaseMedia(this.#audio, src);
  }

  releaseVideo(src) {
    return this.#releaseMedia(this.#videos, src);
  }

  async #releaseMedia(copies, src) {
    const media = copies.get(src);
    if (!media) return;
    copies.delete(src);
    clearTimeout(media.timer);
    await Promise.all([...media.streams].map(stream => new Promise(resolve => {
      if (stream.closed) resolve();
      else {
        stream.once('close', resolve);
        stream.destroy();
      }
    })));
    await this.discard(media.directory);
  }

  videoRevision(nodeId) {
    return this.#videoGeneration + ':' + (this.#videoRevisions.get(nodeId) ?? 0);
  }

  async invalidateVideos(nodeId) {
    if (nodeId) this.#videoRevisions.set(nodeId, (this.#videoRevisions.get(nodeId) ?? 0) + 1);
    else {
      this.#videoGeneration++;
      this.#videoRevisions.clear();
    }
    await Promise.all([...this.#videos].filter(([, entry]) => !nodeId || entry.nodeId === nodeId)
      .map(([src]) => this.releaseVideo(src)));
  }

  async clearPreviews() {
    await Promise.all([this.releaseImages(), this.invalidateVideos(), ...[...this.#audio.keys()].map(src => this.releaseAudio(src))]);
  }

  async discard(directory) {
    // A viewer can hold a Windows file handle past its expiry. Startup retries owned copies.
    await removeCopy(directory).catch(() => {});
  }
}
