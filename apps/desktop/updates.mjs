import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { uuidPattern } from './update-startup.mjs';

const execute = promisify(execFile);
const states = new Set(['ready', 'upToDate', 'available', 'incompatible', 'offline', 'error']);
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const digest = /^[a-f0-9]{64}$/;
const maximumResponse = 72 * 1024;
const phases = new Set(['preparing', 'backupSaved', 'downloading', 'verifying', 'staged', 'failed', 'interrupted',
  'starting', 'healthy', 'rollingBack', 'rolledBack', 'manualRollingBack', 'manualRolledBack', 'recoveryRequired']);
const channelCodes = new Set(['channelOffline', 'channelDns', 'channelTls', 'channelTimeout', 'channelUnavailable',
  'channelIndexHttp', 'channelMetadataHttp', 'invalidIndex', 'noRelease', 'untrustedRelease', 'versionConflict',
  'selectionChanged', 'incompatibleRelease', 'unsupportedUpdatePolicy']);
const assetHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function validHttpFailure(http, index = false) {
  return Number.isInteger(http?.status) && http.status >= 100 && http.status < 600 && http.status !== 200 &&
    (index ? http.endpoint === 'api.github.com' : assetHosts.has(http.endpoint));
}

function validChannelProblem(problem) {
  if (!channelCodes.has(problem?.code) || typeof problem.message !== 'string' ||
      problem.message.length === 0 || problem.message.length > 300) return false;
  if (problem.code === 'channelIndexHttp') return validHttpFailure(problem.http, true);
  if (problem.code === 'channelMetadataHttp') return validHttpFailure(problem.http);
  return problem.http === undefined;
}

function validJob(value, installedVersion) {
  return uuidPattern.test(value?.id ?? '') && stable.test(value.sourceVersion ?? '') && stable.test(value.targetVersion ?? '') &&
    digest.test(value.targetPackageSha256 ?? '') &&
    [value.sourceVersion, value.targetVersion].includes(installedVersion) && phases.has(value.phase) &&
    typeof value.canRollBack === 'boolean' &&
    (value.downloadHttpError === undefined || value.phase === 'failed' && validHttpFailure(value.downloadHttpError)) &&
    [value.message, value.recoveryMessage].every(message => message === null || typeof message === 'string' && message.length <= 300);
}

function validStatus(value, installedVersion) {
  if (value?.installedVersion !== installedVersion || !digest.test(value.installedPackageSha256 ?? '') || !states.has(value.state)) return false;
  if (value.lastJob !== null && !validJob(value.lastJob, installedVersion)) return false;
  switch (value.state) {
    case 'available': {
      const candidate = value.candidate;
      return stable.test(candidate?.version ?? '') && typeof candidate.notes === 'string' &&
        Buffer.byteLength(candidate.notes) <= 16 * 1024 &&
        Number.isSafeInteger(candidate.packageBytes) && candidate.packageBytes > 0 && candidate.packageBytes <= 512 * 1024 * 1024 &&
        digest.test(candidate.packageSha256 ?? '') && typeof candidate.canStage === 'boolean';
    }
    case 'incompatible': return stable.test(value.version ?? '');
    case 'error': return validChannelProblem(value);
    default: return true;
  }
}

function stageWithHelper(executable, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['stage-update'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timeout = setTimeout(() => child.kill(), 420_000);
    const output = [];
    let bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maximumResponse) child.kill();
      else output.push(chunk);
    });
    child.stdin.on('error', () => child.kill());
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > maximumResponse) {
        reject(new Error('Update helper did not complete preparation'));
        return;
      }
      resolve(Buffer.concat(output).toString('utf8'));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class DesktopUpdates {
  #helper;
  #launcher;
  #installed;
  #checking;
  #candidate;

  constructor({ installation, executable, installed }) {
    this.#installed = installed;
    if (installation) {
      this.#helper = path.join(path.dirname(executable), 'forge-update-helper.exe');
      this.#launcher = path.join(installation, 'Forge Launcher.exe');
    }
  }

  status() {
    return this.#read('update-status');
  }

  async diagnosticContext() {
    const { installedPackageSha256, lastJob } = await this.#read('update-status');
    if (!installedPackageSha256) return undefined;
    const job = lastJob && {
      id: lastJob.id, phase: lastJob.phase, sourceVersion: lastJob.sourceVersion,
      targetVersion: lastJob.targetVersion, targetPackageSha256: lastJob.targetPackageSha256,
    };
    return { installedPackageSha256, job };
  }

  check() {
    this.#checking ??= this.#read('check-updates').then(status => {
      this.#candidate = status.state === 'available' ? status.candidate : undefined;
      return status;
    }).finally(() => { this.#checking = undefined; });
    return this.#checking;
  }

  canStage({ version, packageSha256 } = {}) {
    return Boolean(this.#helper && !this.#checking && this.#candidate?.canStage &&
      version === this.#candidate.version && packageSha256 === this.#candidate.packageSha256);
  }

  async stage(input, backupPath) {
    if (!this.canStage(input) || !path.isAbsolute(backupPath)) throw new Error('Check the selected release again');
    const { version, packageSha256 } = input;
    const job = JSON.parse(await stageWithHelper(this.#helper, { version, packageSha256, backupPath }));
    if (validChannelProblem(job?.rejection)) {
      this.#candidate = undefined;
      const { code, message, http } = job.rejection;
      return { rejection: { code, message, http } };
    }
    if (!validJob(job, this.#installed) || job.targetVersion !== version || job.targetPackageSha256 !== packageSha256 ||
        !['staged', 'failed'].includes(job.phase)) {
      throw new Error('Invalid helper response');
    }
    return job;
  }

  restart(id, backupPath, rollback) {
    if (!this.#launcher || typeof id !== 'string' || !uuidPattern.test(id) || !path.isAbsolute(backupPath)) {
      throw new Error('Choose the prepared job and its saved backup');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.#launcher, [rollback ? 'rollback-update' : 'activate-update'], {
        detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const terminate = () => child.kill();
      const timeout = setTimeout(terminate, 20_000);
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 128) return terminate();
        if (!output.includes('\n')) return;
        if (rollback && output.trim() === 'ROLLBACK_BACKUP_INVALID') {
          clearTimeout(timeout);
          reject(Object.assign(new Error('Choose the original update backup ZIP.'), { code: 'ROLLBACK_BACKUP_INVALID' }));
          return;
        }
        if (output.trim() !== id) return terminate();
        clearTimeout(timeout);
        child.stdout.destroy();
        child.unref();
        resolve();
      });
      child.stdin.once('error', terminate);
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(timeout);
        reject(new Error('Forge Launcher could not accept the restart'));
      });
      child.stdin.end(JSON.stringify({ id, backupPath, pid: process.pid }));
    });
  }

  async #read(command) {
    if (!this.#helper) {
      return {
        state: 'unavailable', installedVersion: this.#installed,
        message: 'Open a managed installation through Forge Launcher to check for updates.',
      };
    }
    try {
      const { stdout } = await execute(this.#helper, [command], {
        windowsHide: true, timeout: command === 'check-updates' ? 70_000 : 5_000,
        maxBuffer: maximumResponse, encoding: 'utf8',
      });
      const value = JSON.parse(stdout);
      if (!validStatus(value, this.#installed)) throw new Error('Invalid helper response');
      return value;
    } catch (error) {
      if (error.killed && command === 'check-updates') {
        return { state: 'offline', installedVersion: this.#installed };
      }
      return {
        state: 'unavailable', installedVersion: this.#installed,
        message: 'The updater could not verify this installation. Reopen it through Forge Launcher.',
      };
    }
  }
}
