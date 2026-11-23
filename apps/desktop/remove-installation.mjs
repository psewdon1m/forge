import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function startUninstall(installation, executable) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'forge-remove-'));
  const worker = path.join(temporary, 'forge-remover.exe');
  try {
    await copyFile(path.join(path.dirname(executable), 'forge-update-helper.exe'), worker);
    const child = spawn(worker, ['remove-after-exit', installation, String(process.pid)], {
      cwd: tmpdir(), detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => child.kill(), 10_000);
      const fail = error => { clearTimeout(timeout); reject(error); };
      let output = '';
      child.once('error', fail);
      child.once('close', () => fail(new Error('Forge remover did not become ready')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        output = (output + data).slice(-128);
        if (output.trim() === 'FORGE_REMOVE_READY') {
          clearTimeout(timeout);
          child.stdout.destroy();
          resolve();
        }
      });
    });
    child.unref();
  } catch (error) {
    await unlink(worker).catch(() => {});
    await rmdir(temporary).catch(() => {});
    throw error;
  }
}
