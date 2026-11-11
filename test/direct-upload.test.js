const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDirectUploads } = require('../direct-upload');

const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc';

function fakeDrive() {
  const drive = {
    folderId: 'folder1',
    uploadOrigin: 'https://www.googleapis.com',
    uploadTokenKey: Buffer.from('test-key'),
    started: [],
    received: 0,
    file: null,
    invalidated: 0,
    async startUpload(input) {
      drive.started.push(input);
      if (input.name === 'full.mp4') throw Object.assign(new Error('quota'), { reason: 'storageQuotaExceeded' });
      return sessionUrl;
    },
    async uploadStatus(url, size) {
      assert.equal(url, sessionUrl);
      if (drive.expired) throw Object.assign(new Error('gone'), { reason: 'sessionExpired' });
      return drive.file ? { done: true, file: drive.file } : { done: false, received: drive.received, size };
    },
    async uploadChunk(url, { start, end, size, body }) {
      assert.equal(url, sessionUrl);
      assert.equal(start, drive.received);
      drive.chunks.push({ start, end, body });
      drive.received = end + 1;
      if (drive.received === size) {
        drive.file = { id: 'new1', size: String(size), parents: ['folder1'], trashed: false };
        return { done: true, file: drive.file };
      }
      return { done: false, received: drive.received };
    },
    chunks: [],
    invalidate() { drive.invalidated++; }
  };
  return drive;
}

test('Drive uploads open a session, relay valid chunks and remember the chosen day once Drive has the file', async () => {
  const drive = fakeDrive();
  const remembered = [];
  const store = { async remember(rows) { remembered.push(...rows); } };
  let now = Date.parse('2026-11-08T12:00:00Z');
  const uploads = createDirectUploads({ drive, store, maxSize: 64 * 1024 * 1024, now: () => now });
  const chunk = uploads.chunkSize;
  assert.equal(chunk, 8 * 1024 * 1024);
  assert.equal(uploads.origin, 'https://www.googleapis.com');

  await assert.rejects(uploads.begin({ name: 'a.mp4', size: 0, day: '2026-11-08' }), { status: 400 });
  await assert.rejects(uploads.begin({ name: 'a.mp4', size: 64 * 1024 * 1024 + 1, day: '2026-11-08' }), { status: 413 });
  await assert.rejects(uploads.begin({ name: 'full.mp4', size: 10, day: '2026-11-08' }), { status: 507 });

  const size = chunk + 100;
  const session = await uploads.begin({ name: 'clip.mp4', mimeType: 'video/mp4', size, day: '2026-11-09', origin: 'https://giadinh.test' });
  assert.equal(session.sessionUrl, sessionUrl);
  assert.equal(session.chunkSize, chunk);
  assert.deepEqual(drive.started.at(-1), { name: 'clip.mp4', mimeType: 'video/mp4', size, origin: 'https://giadinh.test' });

  assert.deepEqual(await uploads.status(session.token), { done: false, received: 0 });
  await assert.rejects(uploads.finish(session.token), { status: 409 });

  // Chunks must be 256 KiB multiples except the last one, within the file and at most 8 MiB.
  for (const [start, end] of [[0, 1000], [0, chunk], [size, size + 1], [-1, 10], [5, 4], [1.5, 10]]) {
    await assert.rejects(uploads.relay(session.token, { start, end, body: null }), { status: 400 });
  }
  assert.deepEqual(await uploads.relay(session.token, { start: 0, end: chunk - 1, body: 'first' }), { done: false, received: chunk });
  assert.deepEqual(await uploads.relay(session.token, { start: chunk, end: size - 1, body: 'last' }), { done: true, received: null });
  assert.deepEqual(drive.chunks.map(({ body }) => body), ['first', 'last']);

  assert.deepEqual(await uploads.finish(session.token), { id: 'drive-new1', day: '2026-11-09' });
  assert.deepEqual(remembered, [{
    id: 'drive-new1', object_key: 'drive-new1', title: 'clip.mp4', original_name: 'clip.mp4',
    day: '2026-11-09', size: 0, created_at: '2026-11-08T12:00:00.000Z'
  }]);
  assert.equal(drive.invalidated, 1);

  const [payload, signature] = session.token.split('.');
  const forged = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(payload, 'base64url')), sessionUrl: 'https://evil.test/upload'
  })).toString('base64url');
  await assert.rejects(uploads.status(forged + '.' + signature), { status: 400 });
  await assert.rejects(uploads.status('nope'), { status: 400 });

  drive.file = { ...drive.file, parents: ['elsewhere'] };
  await assert.rejects(uploads.finish(session.token), { status: 502 });

  drive.expired = true;
  await assert.rejects(uploads.status(session.token), { status: 410 });
  now += 25 * 60 * 60 * 1000;
  drive.expired = false;
  await assert.rejects(uploads.status(session.token), { status: 410 });
});

test('Direct uploads are unavailable without Drive', () => {
  assert.equal(createDirectUploads({ drive: undefined, store: {}, maxSize: 1 }), null);
});
