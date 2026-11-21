import { dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants, mkdtempSync } from 'node:fs';
import { copyFile, link, lstat, open, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allowedSiteUrl } from './site-policy.mjs';

const prefix = 'forge-site-download-';
const directoryPattern = /^forge-site-download-[A-Za-z0-9]{6}$/;
const body = 'body.download';
const maxBytes = 32 * 1024 * 1024;
const approvalTime = 2 * 60 * 1000;
const partitionGates = new WeakMap();

function validFilename(value) {
  return value && value.length <= 180 && !/[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(value) &&
    !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(value);
}

async function discardStaging(directory) {
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  for (const name of await readdir(directory)) {
    if (name === body || name === body + '.crdownload') await unlink(path.join(directory, name)).catch(() => {});
  }
  await rmdir(directory).catch(() => {});
}

export async function sweepSiteDownloads(profileDirectory) {
  for (const entry of await readdir(profileDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !directoryPattern.test(entry.name)) continue;
    const directory = path.join(profileDirectory, entry.name);
    const info = await lstat(directory).catch(() => null);
    if (info && Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) await discardStaging(directory);
  }
}

export class SiteDownloads {
  #gate;
  #directory;
  #updated;
  #contents;
  #item;
  #state = null;

  constructor(profile, directory, updated) {
    this.#directory = directory;
    this.#updated = updated;
    let gate = partitionGates.get(profile);
    if (!gate) {
      gate = {};
      partitionGates.set(profile, gate);
      profile.on('will-download', (event, item, contents) => {
        if (gate.offer) gate.offer(event, item, contents);
        else event.preventDefault();
      });
    }
    this.#gate = gate;
    gate.offer = this.#offer;
  }

  get state() { return this.#state; }

  acceptFrom(contents) {
    this.#contents = contents;
  }

  #progress(phase, message, name, bytes) {
    this.#state = { phase, message, name: name ?? null, bytes: bytes ?? null };
    this.#updated();
  }

  #offer = (event, item, contents) => {
    if (this.#contents !== contents || !contents) {
      event.preventDefault();
      return;
    }
    if (this.#item) {
      event.preventDefault();
      return;
    }
    const origin = allowedSiteUrl(item.getInitiatorOrigin());
    const top = allowedSiteUrl(contents.getURL());
    if (!top || !origin || new URL(origin).origin !== new URL(top).origin ||
        !item.getURLChain().every(url => allowedSiteUrl(url))) {
      event.preventDefault();
      this.#progress('error', 'Site blocked a download from an unverified origin.');
      return;
    }
    const bytes = item.getTotalBytes();
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxBytes) {
      event.preventDefault();
      this.#progress('error', 'Site downloads require a known length of 1 byte to 32 MiB.');
      return;
    }
    let directory;
    try {
      directory = mkdtempSync(path.join(this.#directory, prefix));
    } catch {
      event.preventDefault();
      this.#progress('error', 'Forge could not prepare the download.');
      return;
    }
    const suggested = item.getFilename();
    const name = validFilename(suggested) ? suggested : 'site-download.bin';
    const source = path.join(directory, body);
    const record = { item, name, bytes, source, directory, ended: false, complete: false, canceled: false };
    this.#item = record;
    record.timer = setTimeout(() => {
      if (this.#item === record) this.#end(record, 'canceled', 'Site download expired.');
    }, approvalTime);
    record.timer.unref();
    item.setSavePath(source);
    item.pause();
    item.on('updated', (_event, state) => {
      if (record.canceled) return;
      if (item.getReceivedBytes() > record.bytes || state === 'interrupted') {
        this.#end(record, 'error', 'Site download exceeded its length or was interrupted.');
      }
    });
    item.once('done', (_event, state) => {
      record.ended = true;
      if (record.canceled) {
        void discardStaging(directory).catch(() => {});
        return;
      }
      if (state !== 'completed' || item.getReceivedBytes() !== record.bytes) {
        this.#end(record, 'error', 'Site download did not complete at the stated length.');
        return;
      }
      record.complete = true;
      if (record.destination) void this.#publish(record);
    });
    this.#progress('approval', 'Review the download and choose where to save it.', name, bytes);
  };

  async save(window) {
    const record = this.#item;
    if (!record || this.#state.phase !== 'approval') return false;
    this.#progress('choosing', 'Choose a destination for the download.', record.name, record.bytes);
    let pick;
    try {
      pick = await dialog.showSaveDialog(window, { title: 'Save Site download', defaultPath: record.name });
    } catch {
      if (this.#item === record) this.#end(record, 'error', 'The save dialog could not open.');
      return false;
    }
    if (this.#item !== record) return false;
    if (pick.canceled) {
      this.cancel();
      return false;
    }
    if (typeof pick.filePath !== 'string' || !path.isAbsolute(pick.filePath) || !validFilename(path.basename(pick.filePath))) {
      this.#end(record, 'error', 'Choose a valid filename for the download.');
      return false;
    }
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      if (this.#item === record) this.#end(record, 'error', 'Site download timed out.');
    }, 10 * 60 * 1000);
    record.timer.unref();
    record.destination = pick.filePath;
    this.#progress('saving', 'Saving download…', record.name, record.bytes);
    if (record.complete) void this.#publish(record);
    else record.item.resume();
    return true;
  }

  async #publish(record) {
    const stage = path.join(path.dirname(record.destination), '.forge-site-' + randomUUID() + '.part');
    let phase = 'error';
    let message = 'Site download could not be saved.';
    let staged = false;
    try {
      const input = await lstat(record.source);
      if (!input.isFile() || input.isSymbolicLink() || input.size !== record.bytes) throw new Error('Length changed');
      await copyFile(record.source, stage, constants.COPYFILE_EXCL);
      staged = true;
      const handle = await open(stage, 'r+');
      try {
        if ((await handle.stat()).size !== record.bytes) throw new Error('Length changed');
        if (process.platform === 'win32') await writeFile(stage + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (!record.canceled) {
        await link(stage, record.destination);
        phase = 'saved';
        message = 'Site download saved.';
      }
    } catch (error) {
      if (error.code === 'EEXIST') message = 'A file already exists at that destination.';
    } finally {
      if (staged) await unlink(stage).catch(() => {});
      await discardStaging(record.directory).catch(() => {});
      if (this.#item === record) this.#end(record, phase, message);
    }
  }

  #end(record, phase, message) {
    if (this.#item !== record) return;
    this.#item = undefined;
    clearTimeout(record.timer);
    record.canceled = true;
    if (!record.ended) record.item.cancel();
    else void discardStaging(record.directory).catch(() => {});
    this.#progress(phase, message, record.name, record.bytes);
  }

  cancel() {
    if (this.#item) this.#end(this.#item, 'canceled', 'Site download canceled.');
  }

  dismiss() {
    if (this.#item || !this.#state) return;
    this.#state = null;
    this.#updated();
  }

  close() {
    if (this.#gate.offer === this.#offer) this.#gate.offer = undefined;
    this.cancel();
  }
}
