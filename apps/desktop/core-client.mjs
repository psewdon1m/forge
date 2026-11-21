import { spawn } from 'node:child_process';

const maxRequestBytes = 2 * 1024 * 1024;
const maxResponseBytes = 40 * 1024 * 1024;
const maxPending = 8;

export class CoreClient {
  #process;
  #pending = new Map();
  #sequence = 0;
  #chunks = [];
  #size = 0;
  #closed = false;

  constructor(executable) {
    this.#process = spawn(executable, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.#process.stdout.on('data', chunk => this.#receive(chunk));
    this.#process.stdin.on('error', () => this.#failAll(new Error('Forge Core input is unavailable')));
    this.#process.once('error', () => this.#failAll(new Error('Forge Core could not start')));
    this.#process.once('close', () => this.#failAll(new Error('Forge Core exited')));
  }

  request(command, { onProgress } = {}) {
    if (this.#closed) return Promise.reject(new Error('Forge Core is unavailable'));
    if (this.#pending.size >= maxPending) return Promise.reject(new Error('Forge Core is busy'));
    const id = ++this.#sequence;
    const message = JSON.stringify({ id, command }) + '\n';
    if (Buffer.byteLength(message) > maxRequestBytes) return Promise.reject(new Error('Forge request exceeds its limit'));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onProgress });
      this.#process.stdin.write(message, error => {
        if (error && this.#pending.delete(id)) reject(new Error('Forge Core could not accept the request'));
      });
    });
  }

  cancelImport(operationId) {
    return this.#sendCancellation({ cancelImport: operationId });
  }

  cancelAnalysis(operationId) {
    return this.#sendCancellation({ cancelAnalysis: operationId });
  }

  #sendCancellation(frame) {
    if (this.#closed) return Promise.reject(new Error('Forge Core is unavailable'));
    return new Promise((resolve, reject) => {
      this.#process.stdin.write(JSON.stringify(frame) + '\n', error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close() {
    this.#failAll(new Error('Forge Core closed'));
    this.#process.stdin.end();
  }

  #receive(chunk) {
    if (this.#closed) return;
    let offset = 0;
    while (offset < chunk.length && !this.#closed) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      this.#size += segment.length;
      if (this.#size > maxResponseBytes) {
        this.#failAll(new Error('Forge Core exceeded its response limit'));
        this.#process.kill();
        return;
      }
      this.#chunks.push(segment);
      if (newline === -1) return;
      try {
        const response = JSON.parse(Buffer.concat(this.#chunks, this.#size).toString('utf8'));
        const pending = this.#pending.get(response.id);
        if (!pending) throw new Error('Unexpected Core response');
        if (response.progress) {
          pending.onProgress?.(response.progress);
        } else {
          this.#pending.delete(response.id);
          if (response.error) pending.resolve({ ok: false, error: response.error });
          else pending.resolve({ ok: true, value: response.result });
        }
      } catch {
        this.#failAll(new Error('Forge Core returned an invalid response'));
        this.#process.kill();
      }
      this.#chunks = [];
      this.#size = 0;
      offset = end + 1;
    }
  }

  #failAll(error) {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
