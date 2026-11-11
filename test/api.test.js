const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { mkdtempSync, rmSync, readdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const path = require('node:path');

const photo = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+t8AAAAASUVORK5CYII=',
  'base64'
);

test('Gia Đình archives photos by day and streams unchanged originals', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'giadinh-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.UPLOADS_DIR = path.join(dataDir, 'uploads');
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SECRET_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  // A developer .env may hold real Drive credentials; dotenv never overrides values set here.
  for (const name of ['GOOGLE_DRIVE_FOLDER_ID', 'GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON', 'GOOGLE_DRIVE_OAUTH_CLIENT_ID',
    'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN']) process.env[name] = '';
  process.env.RENDER = 'false';
  const { app } = require('../server');
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\giadinh-test-' + randomUUID() : null;
  const server = socketPath ? app.listen(socketPath) : app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = socketPath ? { socketPath } : { host: '127.0.0.1', port: server.address().port };
  function request(route, { method = 'GET', headers, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        ...address, path: route, method,
        headers
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  async function upload(day, images, name = 'Ảnh nhà.png', type = 'image/png') {
    const form = new FormData();
    form.set('date', day);
    for (const image of images) form.append('photos', new Blob([image], { type }), name);
    const encoded = new Request('http://localhost', { method: 'POST', body: form });
    const body = Buffer.from(await encoded.arrayBuffer());
    return request('/api/photos/upload', {
      method: 'POST',
      body,
      headers: { 'Content-Type': encoded.headers.get('Content-Type'), 'Content-Length': body.length }
    });
  }

  assert.equal((await request('/health/keepalive')).status, 200);
  const homepage = await request('/');
  assert.equal(homepage.status, 200);
  assert.equal(homepage.headers['www-authenticate'], undefined);
  assert.match(homepage.bytes.toString(), /Love Space · Kho Media Gia Đình/);
  assert.equal((await request('/profile.html')).status, 404);
  assert.equal((await request('/memories')).status, 404);
  assert.deepEqual(JSON.parse((await request('/api/photos')).bytes).data, []);

  const visit = headers => request('/api/visits', { method: 'POST', headers });
  assert.equal((await visit({ Origin: 'https://example.test' })).status, 403);
  const visits = await Promise.all([visit(), visit(), visit()]);
  assert.ok(visits.every(response => response.status === 200 && response.headers['cache-control'] === 'no-store'));
  assert.deepEqual(visits.map(response => JSON.parse(response.bytes).data.count).sort(), [1, 2, 3]);
  assert.equal(await require('../photo-store').createPhotoStore().recordVisit(), 4);

  assert.match(homepage.headers['content-security-policy'], /connect-src 'self';/);
  const directProbe = await request('/api/photos/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'a.png', type: 'image/png', size: 1, date: '2026-11-08' })
  });
  assert.deepEqual(JSON.parse(directProbe.bytes).data, { direct: false });
  assert.equal((await request('/api/photos/uploads/parts', { method: 'POST' })).status, 404);

  assert.equal((await upload('2026-02-30', [photo])).status, 400);
  assert.deepEqual(readdirSync(process.env.UPLOADS_DIR), []);
  const otherPhoto = Buffer.concat([photo, Buffer.from([0, 1, 255])]);
  const uploaded = await upload('2026-11-08', [photo, otherPhoto]);
  assert.equal(uploaded.status, 200);
  const [first, second] = JSON.parse(uploaded.bytes).data;
  assert.equal(first.originalName, 'Ảnh nhà.png');
  assert.equal(first.day, '2026-11-08');
  assert.equal(first.size, photo.length);
  assert.equal(second.size, otherPhoto.length);

  const preview = await request(first.url);
  assert.equal(preview.status, 200);
  assert.match(preview.headers['content-type'], /^image\/png/);
  assert.deepEqual(preview.bytes, photo);
  assert.equal(preview.headers['cache-control'], 'private, max-age=31536000, immutable, no-transform');
  assert.match(preview.headers.etag, /^"[A-Za-z0-9_-]{27}"$/);
  const revalidated = await request(first.url, { headers: { 'If-None-Match': preview.headers.etag } });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.bytes.length, 0);
  assert.equal(revalidated.headers.etag, preview.headers.etag);
  assert.equal((await request(second.url, { headers: { 'If-None-Match': preview.headers.etag } })).status, 200);
  assert.equal((await request('/api/photos/missing/preview')).headers['cache-control'], 'no-store');
  const download = await request('/api/photos/' + first.id + '/original');
  assert.match(download.headers['content-disposition'], /^attachment/);
  assert.deepEqual(download.bytes, photo);
  assert.notEqual(download.headers.etag, preview.headers.etag);

  const rename = (id, name, origin) => request('/api/photos/' + id + '/name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ name })
  });
  assert.equal((await rename(first.id, 'Họp mặt', 'https://example.test')).status, 403);
  assert.equal((await rename(first.id, '../invalid')).status, 400);
  assert.equal((await rename('missing', 'Họp mặt')).status, 404);
  assert.equal((await rename(first.id, '  Họp mặt  ')).status, 200);
  const renamed = JSON.parse((await request('/api/photos')).bytes).data.find(entry => entry.id === first.id);
  assert.equal(renamed.originalName, 'Họp mặt.png');
  assert.equal(renamed.title, renamed.originalName);
  assert.notEqual(renamed.downloadVersion, first.downloadVersion);
  assert.equal(renamed.url, first.url);
  assert.equal((await request(renamed.url, { headers: { 'If-None-Match': preview.headers.etag } })).status, 304);
  const renamedDownload = await request('/api/photos/' + first.id + '/original', { headers: { 'If-None-Match': download.headers.etag } });
  assert.equal(renamedDownload.status, 200);
  assert.match(renamedDownload.headers['content-disposition'], /filename\*=UTF-8''H%E1%BB%8Dp%20m%E1%BA%B7t\.png/);
  assert.deepEqual(renamedDownload.bytes, photo);

  const listing = await request('/api/photos');
  assert.equal(listing.headers['cache-control'], 'private, no-cache');
  assert.ok(listing.headers.etag);
  assert.equal((await request('/api/photos', { headers: { 'If-None-Match': listing.headers.etag } })).status, 304);

  const update = (ids, origin) => request('/api/photos/archive-date', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ ids, date: '2026-11-09' })
  });
  assert.equal((await update([first.id], 'https://example.test')).status, 403);
  assert.equal((await update([first.id, 'missing'])).status, 404);
  assert.equal(JSON.parse((await request('/api/photos')).bytes).data[0].day, '2026-11-08');
  assert.equal((await update([first.id, second.id])).status, 200);
  const moved = await request('/api/photos', { headers: { 'If-None-Match': listing.headers.etag } });
  assert.equal(moved.status, 200);
  assert.equal(JSON.parse(moved.bytes).data[0].day, '2026-11-09');

  const video = Buffer.alloc(26 * 1024 * 1024, 61);
  video.set(Buffer.from('0000ftypisom'));
  const uploadedVideo = await upload('2026-11-09', [video], 'Video nhà.mp4', 'video/mp4');
  assert.equal(uploadedVideo.status, 200);
  const savedVideo = JSON.parse(uploadedVideo.bytes).data[0];
  assert.equal(savedVideo.type, 'video/mp4');
  assert.equal(savedVideo.size, video.length);
  const partial = await request(savedVideo.url, { headers: { Range: 'bytes=3-11' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['content-range'], 'bytes 3-11/' + video.length);
  assert.equal(partial.headers['content-type'], 'video/mp4');
  assert.deepEqual(partial.bytes, video.subarray(3, 12));
  const videoTag = partial.headers.etag;
  const resumed = await request(savedVideo.url, { headers: { Range: 'bytes=3-11', 'If-Range': videoTag } });
  assert.equal(resumed.status, 206);
  const staleResume = await request(savedVideo.url, { headers: { Range: 'bytes=3-11', 'If-Range': '"stale"' } });
  assert.equal(staleResume.status, 200);
  assert.equal(staleResume.bytes.length, video.length);
  const tooFar = await request(savedVideo.url, { headers: { Range: 'bytes=' + video.length + '-' } });
  assert.equal(tooFar.status, 416);
  assert.equal(tooFar.headers['cache-control'], 'no-store');
  const downloadedVideo = await request('/api/photos/' + savedVideo.id + '/original');
  assert.deepEqual(downloadedVideo.bytes, video);
  assert.equal((await request('/api/photos/archive-download', { method: 'POST' })).status, 404);

  const remove = (ids, origin) => {
    // Node's http client does not frame DELETE bodies by default; browsers always send a length.
    const body = Buffer.from(JSON.stringify({ ids }));
    return request('/api/photos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...(origin ? { Origin: origin } : {}) },
      body
    });
  };
  const before = readdirSync(process.env.UPLOADS_DIR).length;
  assert.equal((await remove([first.id], 'https://example.test')).status, 403);
  assert.equal((await remove([])).status, 400);
  assert.equal((await remove(['../x'])).status, 400);
  assert.equal((await remove(['drive-abc'])).status, 404);
  assert.equal((await remove([first.id, 'missing'])).status, 404);
  assert.equal(JSON.parse((await request('/api/photos')).bytes).data.length, 3);
  const deleted = await remove([first.id, second.id]);
  assert.equal(deleted.status, 200);
  assert.equal(JSON.parse(deleted.bytes).data.deleted, 2);
  const remaining = JSON.parse((await request('/api/photos')).bytes).data;
  assert.deepEqual(remaining.map(item => item.id), [savedVideo.id]);
  assert.equal(readdirSync(process.env.UPLOADS_DIR).length, before - 2);
  assert.equal((await request(first.url)).status, 404);
  assert.equal((await remove([first.id])).status, 404);

  const postJson = (route, value) => {
    const body = Buffer.from(JSON.stringify(value));
    return request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, body });
  };
  // Only Drive files sit in a trash they can come back from.
  assert.equal((await postJson('/api/photos/restore', { ids: [savedVideo.id] })).status, 400);
  assert.equal((await postJson('/api/photos/restore', { ids: [] })).status, 400);
  assert.equal((await postJson('/api/photos/uploads/report', { stage: 'chunk', status: 0, size: 10, message: 'offline' })).status, 200);
  assert.equal((await postJson('/api/photos/uploads/report', { stage: 'hack', status: 0, size: 10, message: 'x' })).status, 400);
  assert.equal((await postJson('/api/photos/uploads/report', { stage: 'chunk', status: 900, size: 10, message: 'x' })).status, 400);
});
