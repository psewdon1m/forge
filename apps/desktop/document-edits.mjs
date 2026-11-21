import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const prefix = 'forge-edit-';
const directoryPattern = /^forge-edit-[a-zA-Z0-9]{6}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const manifestName = 'session.json';
const stagedCopy = /^\.forge-export-[a-f0-9-]{36}\.part$/;

export function documentEditorFormat(format) {
  return format === 'pdf' || format === 'docx';
}

function isSession(value) {
  return value && documentEditorFormat(value.format) &&
    [value.projectId, value.nodeId, value.versionId].every(id => typeof id === 'string' && uuid.test(id));
}

function cardKey({ projectId, nodeId }) {
  return projectId + ':' + nodeId;
}

async function removeIfPresent(file) {
  await unlink(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export class DocumentEdits {
  #root;
  #sessions = new Map();

  constructor(profile) {
    this.#root = profile;
  }

  async restore() {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !directoryPattern.test(entry.name)) continue;
      try {
        const directory = path.join(this.#root, entry.name);
        const info = await lstat(directory);
        if (!info.isDirectory()) continue;
        const filename = path.join(directory, manifestName);
        const manifest = await lstat(filename);
        if (!manifest.isFile() || manifest.size > 4_096) continue;
        const data = JSON.parse(await readFile(filename, 'utf8'));
        if (!isSession(data) || this.#sessions.has(cardKey(data))) continue;
        this.#sessions.set(cardKey(data), { ...data, directory });
      } catch {
        // A missing or invalid record leaves its directory available for filesystem recovery.
      }
    }
  }

  get(selection) {
    return this.#sessions.get(cardKey(selection));
  }

  async create(selection, format, exportAsset) {
    const data = { projectId: selection.projectId, nodeId: selection.nodeId, versionId: selection.versionId, format };
    if (!isSession(data)) throw new Error('Invalid document edit selection');
    const directory = await mkdtemp(path.join(this.#root, prefix));
    const edit = { ...data, directory };
    try {
      const result = await exportAsset(this.#filePath(edit));
      if (result.ok) {
        await writeFile(path.join(directory, manifestName), JSON.stringify(data), { flag: 'wx', flush: true });
        this.#sessions.set(cardKey(data), edit);
        return { ok: true, value: edit };
      }
      await this.discard(edit);
      return result;
    } catch (error) {
      await this.discard(edit).catch(() => {});
      throw error;
    }
  }

  #filePath(edit) {
    return path.join(edit.directory, 'document.' + edit.format);
  }

  async source(edit) {
    await this.folder(edit);
    const file = this.#filePath(edit);
    if (!(await lstat(file)).isFile()) throw new Error('Invalid edit file');
    return file;
  }

  async folder(edit) {
    if (!(await lstat(edit.directory)).isDirectory()) throw new Error('Invalid edit directory');
    return edit.directory;
  }

  async discard(edit) {
    await this.folder(edit);
    await removeIfPresent(this.#filePath(edit));
    for (const name of await readdir(edit.directory)) {
      if (stagedCopy.test(name)) await removeIfPresent(path.join(edit.directory, name));
    }
    await removeIfPresent(path.join(edit.directory, manifestName));
    if (this.#sessions.get(cardKey(edit)) === edit) this.#sessions.delete(cardKey(edit));
    // An editor may leave its own files. Preserve those files and their directory.
    await rmdir(edit.directory).catch(error => {
      if (error.code !== 'ENOTEMPTY') throw error;
    });
  }
}

export function chooseDocumentEditor(executable, owner, file) {
  if (process.platform !== 'win32') return Promise.resolve('failed');
  const handle = owner.getNativeWindowHandle();
  const parent = handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE();
  return new Promise(resolve => {
    const helper = spawn(executable, ['--open-with', String(parent), file], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    helper.once('error', () => resolve('failed'));
    helper.once('close', code => resolve(code === 0 ? 'chosen' : code === 2 ? 'canceled' : 'failed'));
  });
}
