import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const maxBindingBytes = 80 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

async function directoryIdentity(directory) {
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  return stat.dev.toString() + ':' + stat.ino.toString();
}

export class GitBindings {
  #directory;

  constructor(profile) {
    this.#directory = path.join(profile, 'git-bindings');
  }

  #file(projectId, nodeId) {
    if (!uuid.test(projectId) || !uuid.test(nodeId)) throw new Error('Invalid Git binding identity');
    return path.join(this.#directory, projectId + '-' + nodeId + '.json');
  }

  async candidate(selected) {
    try {
      const directory = await realpath(selected);
      const root = await directoryIdentity(directory);
      const admin = await directoryIdentity(path.join(directory, '.git'));
      return root && admin ? { directory, root, admin } : undefined;
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR', 'EPERM'].includes(error.code)) return undefined;
      throw error;
    }
  }

  async read(projectId, nodeId) {
    let file;
    try {
      file = await open(this.#file(projectId, nodeId), 'r');
      const buffer = Buffer.alloc(maxBindingBytes + 1);
      const { bytesRead } = await file.read({ buffer });
      if (bytesRead > maxBindingBytes) return undefined;
      const binding = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (typeof binding?.directory !== 'string' || binding.directory.length >= 32768 || !path.isAbsolute(binding.directory)) return undefined;
      const current = await this.candidate(binding.directory);
      return current?.directory === binding.directory && current.root === binding.root && current.admin === binding.admin
        ? current.directory : undefined;
    } catch (error) {
      if (error instanceof SyntaxError || error.code === 'ENOENT') return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }

  async save(projectId, nodeId, binding) {
    const destination = this.#file(projectId, nodeId);
    await mkdir(this.#directory, { recursive: true });
    const temporary = destination + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(binding));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async remove(projectId, nodeId) {
    await unlink(this.#file(projectId, nodeId)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
