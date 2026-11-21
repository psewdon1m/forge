import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { loopbackHost, postLoopback } from './loopback-http.mjs';

const provider = 'whisper.cpp';
const route = '/inference';
const defaultPort = 8080;
const audioLimit = 16 * 1024 * 1024;
const textLimit = 64 * 1024;
const replyLimit = 1024 * 1024;
const lifetime = 5 * 60_000;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
const ok = value => ({ ok: true, value });
const error = (code, message) => ({ ok: false, error: { code, message } });

function sameRecording(left, right) {
  return left.asset.assetId === right.asset.assetId && left.asset.versionId === right.asset.versionId &&
    left.asset.bytes === right.asset.bytes && left.asset.sha256 === right.asset.sha256 && left.durationMs === right.durationMs;
}

async function verifiedBytes(file, asset, signal) {
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > audioLimit) throw new Error('Audio exceeds the request limit');
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.allocUnsafe(asset.bytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const audio = bytes.subarray(0, offset);
    if (audio.length !== asset.bytes || sha(audio) !== asset.sha256) throw new Error('The recording did not match its reviewed digest');
    return audio;
  } finally { await handle.close(); }
}

function multipart(audio, language) {
  const boundary = 'forge-' + randomUUID();
  const fields = [['response_format', 'verbose_json'], ['language', language], ['temperature', '0']];
  const prefix = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('') +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  return { body: [Buffer.from(prefix), audio, Buffer.from(`\r\n--${boundary}--\r\n`)], type: 'multipart/form-data; boundary=' + boundary };
}

function parseTranscript(raw, durationMs) {
  let reply;
  try { reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { return undefined; }
  if (reply?.task !== 'transcribe' || typeof reply.language !== 'string' || !/^[a-z -]{1,64}$/i.test(reply.language) ||
    !Number.isFinite(reply.duration) || Math.abs(reply.duration * 1000 - durationMs) > 100 ||
    !Array.isArray(reply.segments) || reply.segments.length > 1024) return undefined;
  let priorEnd = 0;
  let bytes = 0;
  const segments = [];
  for (const item of reply.segments) {
    if (!Number.isFinite(item?.start) || !Number.isFinite(item?.end) || typeof item.text !== 'string' || !item.text.isWellFormed()) return undefined;
    const text = item.text.trim();
    if (!text) continue;
    const startMs = Math.round(item.start * 1000);
    const rawEnd = Math.round(item.end * 1000);
    const endMs = Math.min(durationMs, rawEnd);
    bytes += Buffer.byteLength(text) + (segments.length ? 1 : 0);
    if (startMs < priorEnd || endMs <= startMs || rawEnd > durationMs + 250 || bytes > textLimit ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) return undefined;
    segments.push({ startMs, endMs, text });
    priorEnd = endMs;
  }
  return { detectedLanguage: reply.language, segments };
}

function remember(map, id, value) {
  if (map.size >= 8) map.delete(map.keys().next().value);
  map.set(id, value);
}

export class Transcription {
  #port;
  #services;
  #plans = new Map();
  #results = new Map();
  #job;

  constructor(services) {
    this.#services = services;
    const { fixturePort } = services;
    this.#port = Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort <= 65535 ? fixturePort : defaultPort;
  }

  clear() {
    this.#job?.controller.abort();
    this.#plans.clear();
    this.#results.clear();
  }

  async review(input) {
    if (!input || input.provider !== provider || !['auto', 'en', 'ru'].includes(input.language) ||
      !uuid.test(input.targetId ?? '') || !uuid.test(input.sourceId ?? '') || !hash.test(input.revision ?? '')) {
      return error('INVALID_TRANSCRIPTION', 'Choose a recording, language and transcription provider.');
    }
    const { projectId, targetId, sourceId, revision } = input;
    const request = { projectId, targetId, sourceId, revision };
    const preparation = await this.#services.prepare(request);
    if (!preparation.ok) return preparation;
    if (projectId !== this.#services.currentProject()) return error('PROJECT_CHANGED', 'Open the project again to review its recording.');
    const review = { id: randomUUID(), provider, endpoint: `http://${loopbackHost}:${this.#port}${route}`,
      ...preparation.value, sourceId, revision, language: input.language };
    remember(this.#plans, review.id, { request, review, expires: Date.now() + lifetime });
    return ok(review);
  }

  async start(input) {
    const plan = this.#plans.get(input?.planId);
    if (!plan || plan.request.projectId !== input.projectId || plan.request.targetId !== input.targetId || Date.now() > plan.expires) {
      return error('TRANSCRIPTION_REVIEW_REQUIRED', 'Review this exact recording again before sending.');
    }
    if (input.approve !== true) return error('TRANSCRIPTION_APPROVAL_REQUIRED', 'Approve sending this WAV to the reviewed provider.');
    if (this.#job) return error('TRANSCRIPTION_BUSY', 'Wait for the current transcription or cancel it.');
    this.#plans.delete(input.planId);
    const controller = new AbortController();
    const job = { ...plan.request, id: input.planId, controller, sent: false };
    this.#job = job;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    let copy;
    try {
      const copied = await this.#services.copy(async destination => {
        signal.throwIfAborted();
        const operationId = randomUUID();
        const stopCopy = () => { void this.#services.cancelCopy(operationId).catch(() => {}); };
        signal.addEventListener('abort', stopCopy, { once: true });
        try { return await this.#services.prepare(plan.request, destination, operationId); }
        finally { signal.removeEventListener('abort', stopCopy); }
      });
      if (copied.ok) copy = copied.value;
      signal.throwIfAborted();
      if (!copied.ok) return copied;
      const audio = await verifiedBytes(copy.file, plan.review.asset, signal);
      const current = await this.#services.prepare(plan.request);
      signal.throwIfAborted();
      if (!current.ok) return current;
      if (!sameRecording(plan.review, current.value) || job.projectId !== this.#services.currentProject()) {
        return error('SOURCE_CHANGED', 'The recording changed. Review it again before sending.');
      }
      const { body, type } = multipart(audio, plan.review.language);
      job.sent = true;
      const raw = await postLoopback(this.#port, route, body, type, signal, replyLimit);
      signal.throwIfAborted();
      const output = parseTranscript(raw, plan.review.durationMs);
      if (!output) return error('TRANSCRIPTION_INVALID', 'The provider returned invalid text or timestamps.');
      if (!output.segments.length) return error('TRANSCRIPTION_NO_SPEECH', 'The provider found no speech segments.');
      if (job.projectId !== this.#services.currentProject()) throw new Error('Project changed');
      const result = { id: randomUUID(), sourceId: job.sourceId, segments: output.segments, origin: {
        provider, sourceRevision: job.revision, requestedLanguage: plan.review.language, detectedLanguage: output.detectedLanguage,
        completedAt: Date.now(), responseSha256: sha(raw),
      } };
      remember(this.#results, result.id, { projectId: job.projectId, targetId: job.targetId, result });
      return ok(result);
    } catch {
      if (controller.signal.aborted || job.projectId !== this.#services.currentProject()) return error('TRANSCRIPTION_CANCELED', job.sent
        ? 'Canceled locally. The provider may still be processing the recording.' : 'Canceled before sending the recording.');
      return error('TRANSCRIPTION_UNAVAILABLE', 'The local transcription could not finish. Check the provider and try again.');
    } finally {
      if (copy) await this.#services.discard(copy.directory);
      if (this.#job === job) this.#job = undefined;
    }
  }

  cancel(input) {
    const job = this.#job;
    if (job && job.projectId === input?.projectId && job.targetId === input.targetId && job.id === input.planId) job.controller.abort();
    return ok(null);
  }

  result(input) {
    const stored = this.#results.get(input?.resultId);
    return stored?.projectId === input?.projectId && stored?.targetId === input?.targetId ? stored.result : undefined;
  }
}
