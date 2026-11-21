import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { CoreClient } from './core-client.mjs';

export const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function readStartupChallenge(installation, version) {
  const value = process.env.FORGE_STARTUP_CHECK;
  delete process.env.FORGE_STARTUP_CHECK;
  if (value === undefined) return;
  const proof = JSON.parse(value);
  if (!path.isAbsolute(installation ?? '') || proof?.version !== version ||
      ![proof.jobId, proof.nonce, proof.projectId].every(id => typeof id === 'string' && uuidPattern.test(id)) ||
      !Number.isInteger(proof.supervisorPid) || proof.supervisorPid < 1 || proof.supervisorPid > 0xffff_ffff ||
      proof.directory !== path.join(installation, `health-${proof.nonce}`)) {
    throw new Error('Invalid startup challenge');
  }
  return proof;
}

export function watchStartup(supervisorPid, stop) {
  const timer = setInterval(() => {
    try {
      process.kill(supervisorPid, 0);
    } catch {
      stop();
    }
  }, 100);
  return () => clearInterval(timer);
}

async function mark(directory, name, text) {
  const temporary = path.join(directory, name + '.part');
  await writeFile(temporary, text, { flag: 'wx' });
  await rename(temporary, path.join(directory, name));
}

export async function completeStartup(challenge, window, coreExecutable) {
  const client = new CoreClient(coreExecutable);
  try {
    const renderedVersion = await window.webContents.executeJavaScript(`new Promise(resolve => {
      const shown = () => document.querySelector('.version')?.textContent;
      const observer = new MutationObserver(() => {
        if (shown()) { observer.disconnect(); resolve(shown()); }
      });
      if (shown()) resolve(shown());
      else observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, 8000);
    })`);
    if (renderedVersion !== challenge.version + ' · Stable') throw new Error('Forge UI did not render');
    const opened = await client.request({ kind: 'open', directory: challenge.directory, expectedProjectId: challenge.projectId });
    if (!opened.ok || opened.value.space.projectId !== challenge.projectId || opened.value.revision !== 0 ||
        !(await client.request({ kind: 'verifyProjectIntegrity' })).ok || !(await client.request({ kind: 'close' })).ok) {
      throw new Error('Project startup check failed');
    }
  } finally {
    client.close();
  }
  const { directory, jobId, nonce, version } = challenge;
  await mark(directory, 'ready.json', JSON.stringify({ jobId, nonce, version, pid: process.pid }));
  const approval = path.join(directory, 'approval');
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const token = await readFile(approval, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (token !== undefined) {
      if (token !== nonce) throw new Error('Invalid startup approval');
      await mark(directory, 'accepted', nonce);
      return;
    }
    await pause(50);
  }
  throw new Error('Startup approval expired');
}
