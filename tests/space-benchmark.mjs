import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { _electron, expect } from '@playwright/test';
import executablePath from 'electron';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const base = path.join(root, '.local', 'qualification');
await mkdir(base, { recursive: true });
const directory = await mkdtemp(path.join(base, 'benchmark-'));
const runs = [];

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

for (let run = 0; run < 3; run++) {
  const started = performance.now();
  const app = await _electron.launch({
    executablePath,
    args: [root],
    env: {
      ...process.env,
      FORGE_QUALIFICATION: '1',
      FORGE_CANVAS_FIXTURE: '500',
      FORGE_QUALIFICATION_DATA: path.join(directory, 'profile-' + run),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('500 objects · 1000 links')).toBeVisible();
    const coldLoadMs = performance.now() - started;
    const bounds = await page.locator('.react-flow__pane').boundingBox();
    assert(bounds);
    const { x, y, width, height } = bounds;
    const originX = x + width * 0.65;
    const originY = y + height * 0.65;
    await page.mouse.move(originX, originY);
    await page.mouse.down({ button: 'middle' });
    const frameProbe = await page.evaluate(() => {
      const result = { frames: [], start: performance.now(), priorFrame: 0 };
      Reflect.set(window, 'forgeBenchmark', result);
      const capture = now => {
        if (result.priorFrame > 0) result.frames.push(now - result.priorFrame);
        result.priorFrame = now;
        if (now - result.start < 30000) requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
      return performance.timeOrigin;
    });
    assert(frameProbe > 0);
    const startPan = performance.now();
    let eventIndex = 0;
    while (performance.now() - startPan < 30000) {
      const phase = 2 * Math.PI * (eventIndex % 180) / 180;
      await page.mouse.move(originX + Math.sin(phase) * 100, originY + Math.cos(phase * 2) * 90);
      await new Promise(resolve => setTimeout(resolve, 12));
      eventIndex += 1;
    }
    await page.mouse.up({ button: 'middle' });
    const frames = await page.evaluate(() => Reflect.get(window, 'forgeBenchmark').frames);
    assert(frames.length >= 20, 'Did not collect enough rendered frames');
    const record = { coldLoadMs, framesMeasured: frames.length, panEvents: eventIndex, p95FrameMs: percentile(frames, 0.95), samplesMs: frames };
    runs.push(record);
    console.log('Run ' + (run + 1) + ': cold load ' + coldLoadMs.toFixed(1) + ' ms, p95 ' + record.p95FrameMs.toFixed(1) + ' ms');
  } finally {
    await app.close();
  }
}

const passed = runs.every(run => run.coldLoadMs <= 3000 && run.p95FrameMs <= 33);
await writeFile(path.join(directory, 'space-benchmark.json'), JSON.stringify({
  platform: process.platform,
  logicalCores: cpus().length,
  memoryBytes: totalmem(),
  objects: 500,
  links: 1000,
  interaction: 'middle-button pan for 30 seconds',
  target: { coldLoadMs: 3000, p95FrameMs: 33 },
  runs,
  passed,
}, null, 2) + '\n');
console.log('Evidence: ' + directory);
if (!passed) process.exitCode = 1;
