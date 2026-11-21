import { randomUUID } from 'node:crypto';
import { CoreClient } from './core-client.mjs';

const maxQueued = 64;
const actions = new Set([
  'create', 'open', 'open-recent', 'close', 'archive', 'apply', 'import-assets', 'directory-change',
  'edit-text-asset', 'replace-asset', 'open-edit-copy', 'import-edit-copy', 'discard-edit-copy',
  'open-asset', 'download-asset', 'run-palette', 'run-metadata', 'run-comparison',
  'backup-export', 'backup-inspect', 'backup-restore', 'logs-export',
  'dataset-read', 'dataset-export',
  'scheme-read', 'scheme-export',
  'settings-save', 'settings-backup-export', 'settings-backup-inspect', 'settings-backup-restore',
]);
const appActions = new Set([
  'backup-inspect', 'logs-export', 'settings-save',
  'settings-backup-export', 'settings-backup-inspect', 'settings-backup-restore',
]);
const cancelWithNull = new Set([
  'create', 'open', 'backup-export', 'backup-inspect', 'backup-restore',
  'dataset-read',
  'scheme-read',
  'replace-asset', 'open-edit-copy', 'import-edit-copy', 'logs-export',
  'settings-backup-export', 'settings-backup-inspect', 'settings-backup-restore',
]);
const cancelWithFalse = new Set(['archive', 'directory-change', 'download-asset', 'discard-edit-copy', 'dataset-export', 'scheme-export']);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const logsUnavailable = { ok: false, error: { code: 'LOGS_UNAVAILABLE', message: 'Forge diagnostics are unavailable.' } };

export class DesktopDiagnostics {
  #executable;
  #profile;
  #onChange;
  #core;
  #opening;
  #pending = 0;
  #queue = Promise.resolve();
  #fault = false;
  #spaceLow = false;
  #closing = false;

  constructor(executable, profile, onChange) {
    this.#executable = executable;
    this.#profile = profile;
    this.#onChange = onChange;
  }

  async start() {
    const result = await this.#enqueue(() => this.#write('start', 'success', null, null, randomUUID()));
    if (!result.ok) this.#noticeLoss();
  }

  async stop() {
    this.#closing = true;
    await this.#queue;
    if (!this.#core) return;
    try {
      await this.#write('exit', 'success', null, null, randomUUID());
    } catch {
      // The state-changing operation has already returned its audit health before shutdown.
    } finally {
      this.#core?.close();
    }
  }

  async deny() {
    const result = await this.#enqueue(() => this.#write('access-denied', 'denied', null, 'FORBIDDEN', randomUUID()));
    if (!result.ok) this.#noticeLoss();
  }

  async observe(action, previousProjectId, reply) {
    if (!actions.has(action)) return reply;
    const code = reply.ok ? (reply.warning ? 'PROJECT_CATALOG' : null) : reply.error.code;
    const canceled = reply.ok
      ? (reply.value === null && cancelWithNull.has(action)) || (reply.value === false && cancelWithFalse.has(action))
      : code === 'CANCELLED' || code === 'IMPORT_CANCELED';
    const outcome = canceled ? 'canceled' : code === 'FORBIDDEN' ? 'denied' : reply.ok ? (code ? 'warning' : 'success') : 'error';
    const projectId = appActions.has(action) ? null : reply.value?.space?.projectId ?? reply.value?.projectId ?? previousProjectId;
    const correlation = randomUUID();
    const saved = await this.#enqueue(() => this.#write(action, outcome, projectId, code, correlation));
    if (!saved.ok) this.#noticeLoss();
    return reply.ok ? reply : { ...reply, error: { ...reply.error, correlationId: correlation } };
  }

  async page(before) {
    if (before !== null && (!Number.isSafeInteger(before?.occurredAt) || before.occurredAt < 0 ||
        !Number.isSafeInteger(before?.sequence) || before.sequence < 1)) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid log cursor.' } };
    }
    const cursor = before === null ? null : { occurredAt: before.occurredAt, sequence: before.sequence };
    const result = await this.#enqueue(() => this.#request({ kind: 'diagnosticsPage', before: cursor }));
    if (result.ok) this.#updateSpace(result.value?.spaceLow === true);
    return result.ok ? { ...result, value: { ...result.value, recordingIssue: this.#fault } } : result;
  }

  async recordUpdate(job) {
    const staged = job.phase === 'staged';
    const failure = job.downloadHttpError && { stage: 'download', code: 'packageHttp', http: job.downloadHttpError };
    const result = await this.#enqueue(() => this.#write('update-stage', staged ? 'success' : 'error', null,
      staged ? null : 'UPDATE_PREPARATION_FAILED', job.id, failure));
    if (!result.ok) this.#noticeLoss();
  }

  async recordUpdateMetadata(action, { code, http }) {
    const correlation = randomUUID();
    const result = await this.#enqueue(() => this.#write(action, 'error', null, 'UPDATE_CHANNEL_FAILED', correlation,
      { stage: 'metadata', code, http }));
    if (!result.ok) this.#noticeLoss();
    return correlation;
  }

  export(destination, update) {
    return this.#enqueue(() => this.#request({ kind: 'diagnosticsExport', destination, update }));
  }

  #enqueue(job) {
    if (this.#closing || this.#pending >= maxQueued) return Promise.resolve(logsUnavailable);
    this.#pending++;
    const run = this.#queue.then(job).catch(() => logsUnavailable);
    this.#queue = run.then(() => { this.#pending--; });
    return run;
  }

  async #request(command) {
    if (!this.#opening) {
      this.#core = new CoreClient(this.#executable);
      this.#opening = this.#core.request({ kind: 'diagnosticsOpen', profile: this.#profile });
    }
    try {
      const opened = await this.#opening;
      if (!opened.ok) {
        this.#core.close();
        this.#opening = undefined;
        return logsUnavailable;
      }
      return await this.#core.request(command);
    } catch {
      this.#core.close();
      this.#opening = undefined;
      return logsUnavailable;
    }
  }

  async #write(action, outcome, projectId, errorCode, correlationId, updateFailure) {
    const result = await this.#request({
      kind: 'diagnosticsRecord',
      observation: {
        action, outcome, correlationId,
        projectId: typeof projectId === 'string' && uuid.test(projectId) ? projectId : null,
        errorCode, updateFailure,
      },
    });
    if (result.ok) this.#updateSpace(result.value?.spaceLow === true);
    return result;
  }

  #noticeLoss() {
    if (this.#fault) return;
    this.#fault = true;
    this.#onChange({ recordingIssue: this.#fault, spaceLow: this.#spaceLow });
  }

  #updateSpace(value) {
    if (this.#spaceLow === value) return;
    this.#spaceLow = value;
    this.#onChange({ recordingIssue: this.#fault, spaceLow: this.#spaceLow });
  }
}
