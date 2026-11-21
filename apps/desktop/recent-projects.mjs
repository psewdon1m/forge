import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const maxEntries = 20;
const maxBytes = 640 * 1024;
const projectId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function valid(entry) {
  return entry && typeof entry.id === 'string' && projectId.test(entry.id)
    && typeof entry.title === 'string' && entry.title.length <= 480
    && typeof entry.directory === 'string' && entry.directory.length < 32768 && path.isAbsolute(entry.directory)
    && typeof entry.openedAt === 'string' && Number.isFinite(Date.parse(entry.openedAt));
}

export class RecentProjects {
  #file;
  #writes = Promise.resolve();

  constructor(directory) {
    this.#file = path.join(directory, 'recent-projects.json');
  }

  async #read() {
    let file;
    try {
      file = await open(this.#file, 'r');
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read({ buffer: bytes });
      if (bytesRead > maxBytes) return [];
      const document = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (document?.version !== 1 || !Array.isArray(document.projects)) return [];
      return document.projects.filter(valid).slice(0, maxEntries);
    } catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') return [];
      throw error;
    } finally {
      await file?.close();
    }
  }

  async list() {
    await this.#writes;
    return (await this.#read()).map(({ id, title, openedAt }) => ({ id, title, openedAt }));
  }

  async directory(id) {
    if (typeof id !== 'string' || !projectId.test(id)) return undefined;
    await this.#writes;
    return (await this.#read()).find(entry => entry.id === id)?.directory;
  }

  record(space, directory) {
    const entry = { id: space.projectId, title: space.title, directory, openedAt: new Date().toISOString() };
    if (!valid(entry)) return Promise.reject(new Error('Invalid recent project entry'));
    return this.#update(current => [entry, ...current.filter(item => item.id !== entry.id && item.directory !== directory)]);
  }

  remove(id) {
    return this.#update(current => current.filter(item => item.id !== id));
  }

  #update(change) {
    const write = this.#writes.then(async () => {
      const projects = change(await this.#read()).slice(0, maxEntries);
      while (Buffer.byteLength(JSON.stringify({ version: 1, projects })) > maxBytes) projects.pop();
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = this.#file + '.' + randomUUID() + '.tmp';
      const file = await open(temporary, 'wx', 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify({ version: 1, projects }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.#file);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}
