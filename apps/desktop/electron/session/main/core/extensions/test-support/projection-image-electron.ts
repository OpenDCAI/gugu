import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { createProjectionImageDecoder } from '../projection-image';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGM4kaLxH4gbABQMBChdYZXzAAAAAElFTkSuQmCC';
const frame = Object.freeze({ sequence: 1, width: 2, height: 2, mime: 'image/png' as const, data: png });
const signal = new AbortController().signal;
const cases: Record<string, { passed: boolean; error?: string }> = {};

if (!process.env.GUGU_HOME || !process.env.GUGU_USER_DATA_DIR) throw new Error('Image fixture needs isolated paths');
app.setPath('userData', process.env.GUGU_USER_DATA_DIR);
app.dock?.hide();
void app.whenReady().then(async () => {
  assert.equal(app.getPath('userData'), process.env.GUGU_USER_DATA_DIR);
  const run = async (name: string, check: () => Promise<void>) => {
    try { await check(); cases[name] = { passed: true }; }
    catch (error) { cases[name] = { passed: false, error: String(error) }; }
  };
  const decode = createProjectionImageDecoder(nativeImage.createFromBuffer, { r: 0, g: 0, b: 0 });
  await run('native-channel-alpha-and-size', async () => {
    const pixels = await decode(frame, signal);
    assert.deepEqual([...pixels.data], [40, 100, 200, 255, 20, 50, 100, 255, 40, 100, 200, 255, 20, 50, 100, 255]);
    assert.equal(frame.data, png);
    pixels.release();
  });
  await run('native-explicit-video-matte', async () => {
    const white = createProjectionImageDecoder(nativeImage.createFromBuffer, { r: 255, g: 255, b: 255 });
    const pixels = await white(frame, signal);
    assert.deepEqual([...pixels.data.subarray(4, 8)], [147, 177, 227, 255]);
    pixels.release();
  });
  await run('native-pixel-lease-reuse', async () => {
    const first = await decode(frame, signal);
    const expected = [...first.data];
    await assert.rejects(decode(frame, signal), /leased/);
    assert.deepEqual([...first.data], expected);
    first.release();
    const second = await decode(frame, signal);
    assert.equal(first.data, second.data);
    first.release();
    await assert.rejects(decode(frame, signal), /leased/);
    second.release();
  });
  await run('native-cancellation', async () => {
    const stopped = new AbortController(); stopped.abort(new Error('App revoked'));
    await assert.rejects(decode(frame, stopped.signal), /App revoked/);
  });
  await run('native-invalid-source', async () => {
    await assert.rejects(decode({ ...frame, data: 'YQ==' }, signal), /could not be decoded/);
  });
  process.stdout.write(`PROJECTION_IMAGE_RESULT=${JSON.stringify({ cases, electron: process.versions.electron,
    home: process.env.GUGU_HOME, userData: app.getPath('userData') })}\n`);
  app.quit();
}).catch(error => { process.stderr.write(String(error)); app.exit(1); });
