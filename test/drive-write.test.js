const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { createDriveMedia } = require('../drive-media');

const sessionUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session1';

test('Drive opens resumable uploads, reports progress, streams chunks and trashes files with OAuth', async () => {
  const calls = [];
  let tokenCalls = 0;
  let quotaFull = false;
  let stored = 0;
  const size = 300;
  const drive = createDriveMedia({
    folderId: 'folder1',
    oauth: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    async fetcher(input, options) {
      const url = new URL(input);
      if (url.hostname === 'oauth2.googleapis.com') {
        tokenCalls++;
        assert.equal(options.body.get('grant_type'), 'refresh_token');
        assert.equal(options.body.get('refresh_token'), 'refresh');
        assert.equal(options.body.get('client_secret'), 'secret');
        return Response.json({ access_token: 'oauth-token', expires_in: 3600 });
      }
      assert.equal(options.headers.Authorization, 'Bearer oauth-token');
      assert.equal(options.redirect, 'manual');
      calls.push({ url, options });
      if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
        if (quotaFull) {
          return Response.json({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, { status: 403 });
        }
        return new Response(null, { status: 200, headers: { Location: sessionUrl } });
      }
      if (url.href === sessionUrl && options.method === 'PUT') {
        const range = options.headers['Content-Range'];
        if (range === 'bytes */' + size) {
          if (stored === size) return Response.json({ id: 'file1', size: String(size), parents: ['folder1'] });
          return new Response(null, { status: 308, headers: stored ? { Range: 'bytes=0-' + (stored - 1) } : {} });
        }
        const [, start, end] = /^bytes (\d+)-(\d+)\/\d+$/.exec(range).map(Number);
        assert.equal(start, stored);
        assert.equal(options.duplex, 'half');
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).length, end - start + 1);
        stored = end + 1;
        return stored === size
          ? Response.json({ id: 'file1', size: String(size), parents: ['folder1'] }, { status: 201 })
          : new Response(null, { status: 308, headers: { Range: 'bytes=0-' + end } });
      }
      if (url.pathname === '/drive/v3/files/file1' && options.method === 'PATCH') {
        assert.deepEqual(JSON.parse(options.body), { trashed: true });
        assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
        return Response.json({ id: 'file1', trashed: true });
      }
      if (url.pathname === '/drive/v3/files/gone') return new Response(null, { status: 404 });
      throw new Error('Unexpected request ' + options.method + ' ' + url.href);
    }
  });

  assert.equal(drive.uploadOrigin, 'https://www.googleapis.com');
  assert.equal(drive.uploadTokenKey.length, 32);
  assert.equal(await drive.startUpload({ name: 'clip.mp4', mimeType: 'video/mp4', size, origin: 'https://giadinh.test' }), sessionUrl);
  const start = calls.at(-1);
  assert.equal(start.url.searchParams.get('uploadType'), 'resumable');
  assert.equal(start.options.headers.Origin, 'https://giadinh.test');
  assert.equal(start.options.headers['X-Upload-Content-Length'], String(size));
  assert.deepEqual(JSON.parse(start.options.body), { name: 'clip.mp4', parents: ['folder1'], mimeType: 'video/mp4' });

  assert.deepEqual(await drive.uploadStatus(sessionUrl, size), { done: false, received: 0 });
  const chunk = (from, to) => drive.uploadChunk(sessionUrl, {
    start: from, end: to, size, body: Readable.from([Buffer.alloc(to - from + 1, 7)])
  });
  assert.deepEqual(await chunk(0, 199), { done: false, received: 200 });
  assert.deepEqual(await drive.uploadStatus(sessionUrl, size), { done: false, received: 200 });
  assert.deepEqual(await chunk(200, 299), { done: true, file: { id: 'file1', size: '300', parents: ['folder1'] } });
  assert.equal((await drive.uploadStatus(sessionUrl, size)).file.id, 'file1');
  await assert.rejects(drive.uploadStatus('https://evil.test/upload?upload_id=x', size), { upstreamStatus: 400 });

  quotaFull = true;
  await assert.rejects(drive.startUpload({ name: 'b.mp4', size: 1 }), { upstreamStatus: 403, reason: 'storageQuotaExceeded' });

  await drive.trash('file1');
  await drive.trash('gone');
  await assert.rejects(drive.trash('../x'), { upstreamStatus: 400 });
  assert.equal(tokenCalls, 1);
});

test('Drive sessions that Google forgot are reported as expired', async () => {
  const drive = createDriveMedia({
    folderId: 'folder1',
    oauth: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    async fetcher(input) {
      if (new URL(input).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 't', expires_in: 3600 });
      return new Response(null, { status: 404 });
    }
  });
  await assert.rejects(drive.uploadStatus(sessionUrl, 10), { upstreamStatus: 410, reason: 'sessionExpired' });
});

test('Drive lists media in nested folders, many parents per query, and serves large previews', async () => {
  const tree = {
    folder1: [{ id: 'subA', mimeType: 'application/vnd.google-apps.folder' }, { id: 'top', name: 'top.jpg' }],
    subA: [{ id: 'subB', mimeType: 'application/vnd.google-apps.folder' }, { id: 'mid', name: 'mid.heic', mimeType: 'image/heic' },
      { id: "bad'id", mimeType: 'application/vnd.google-apps.folder' }],
    subB: [{ id: 'deep', name: 'deep.mp4', mimeType: 'video/mp4' }]
  };
  const queries = [];
  const thumbnails = [];
  const drive = createDriveMedia({
    folderId: 'folder1',
    oauth: { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' },
    async fetcher(input) {
      const url = new URL(input);
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 't', expires_in: 3600 });
      if (url.hostname === 'lh3.googleusercontent.com') {
        thumbnails.push(url.pathname);
        return new Response(Buffer.from([1]), { headers: { 'Content-Type': 'image/jpeg' } });
      }
      if (url.pathname === '/drive/v3/files/folder1') return Response.json({ mimeType: 'application/vnd.google-apps.folder' });
      const q = url.searchParams.get('q');
      queries.push(q);
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map(match => match[1]);
      return Response.json({ files: parents.flatMap(parent => tree[parent] || []).map(file => ({
        mimeType: 'image/jpeg', size: '10', createdTime: '2026-11-08T00:00:00Z', capabilities: { canDownload: true },
        thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/' + file.id + '=s220', ...file
      })) });
    }
  });
  const entries = await drive.refresh();
  assert.deepEqual([...entries.keys()].sort(), ['drive-deep', 'drive-mid', 'drive-top']);
  // One query per tree level; the malformed folder id is never put into a query.
  assert.deepEqual(queries, [
    "('folder1' in parents) and trashed = false",
    "('subA' in parents) and trashed = false",
    "('subB' in parents) and trashed = false"
  ]);
  await drive.thumbnail(entries.get('drive-mid'), 1600);
  await drive.thumbnail(entries.get('drive-mid'));
  assert.deepEqual(thumbnails, ['/drive-storage/mid=s1600', '/drive-storage/mid=s220']);
});
