import assert from 'node:assert/strict';
import { mkdtemp, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssetOpen } from '../apps/desktop/asset-open.mjs';

test('audio preview streams bounded ranges and revokes closed recordings', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'forge-audio-fixture-'));
  const previews = new AssetOpen(profile);
  try {
    const sample = Buffer.from('0123456789');
    const copy = await previews.copy('wav', async destination => {
      await writeFile(destination, sample);
      return { ok: true };
    });
    assert.equal(copy.ok, true);
    const src = await previews.presentAudio(copy.value);
    const request = range => previews.audioResponse(new Request(src, { headers: range ? { range } : {} }));

    for (const [range, status, contentRange, body] of [
      [undefined, 200, null, '0123456789'],
      ['bytes=2-5', 206, 'bytes 2-5/10', '2345'],
      ['bytes=8-', 206, 'bytes 8-9/10', '89'],
      ['bytes=-3', 206, 'bytes 7-9/10', '789'],
      ['bytes=10-', 416, 'bytes */10', ''],
      ['bytes=0-1,4-5', 416, 'bytes */10', ''],
    ]) {
      const response = await request(range);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(await response.text(), body);
    }

    await previews.releaseAudio(src);
    assert.equal((await request()).status, 404);
  } finally {
    await previews.clearPreviews();
    await rmdir(profile);
  }
});

test('video range leases revoke by source and leave another source available', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'forge-video-fixture-'));
  const previews = new AssetOpen(profile);
  try {
    const sample = Buffer.from('0123456789');
    async function present(format, nodeId) {
      const copy = await previews.copy(format, async destination => {
        await writeFile(destination, sample);
        return { ok: true };
      });
      assert.equal(copy.ok, true);
      return previews.presentVideo(copy.value, format, nodeId);
    }
    const first = await present('mp4', 'first-gallery');
    const second = await present('webm', 'other-gallery');
    const revision = previews.videoRevision('first-gallery');
    const response = await previews.videoResponse(new Request(first, { headers: { range: 'bytes=5-' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-range'), 'bytes 5-9/10');
    assert.equal(await response.text(), '56789');
    await previews.invalidateVideos('first-gallery');
    assert.notEqual(previews.videoRevision('first-gallery'), revision);
    assert.equal((await previews.videoResponse(new Request(first))).status, 404);
    const unaffected = await previews.videoResponse(new Request(second));
    assert.equal(unaffected.headers.get('content-type'), 'video/webm');
    assert.equal(await unaffected.text(), '0123456789');
  } finally {
    await previews.clearPreviews();
    await rmdir(profile);
  }
});
