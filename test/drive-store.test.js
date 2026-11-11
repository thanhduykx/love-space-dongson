const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { test } = require('node:test');

test('Deleting mixes stored photos and Drive files: stored rows first, then Drive trash; undo restores Drive files', async t => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SECRET_KEY: 'test-key',
    GOOGLE_DRIVE_FOLDER_ID: 'folder1',
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'client',
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: 'secret',
    GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: 'refresh',
    GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: ''
  });
  const trashed = [];
  const events = [];
  const names = new Map();
  let rpcResult = [{ object_key: 'stored.png', size: 3, part_size: null }];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 't', expires_in: 3600 });
    if (url.hostname === 'www.googleapis.com') {
      if (url.pathname === '/drive/v3/files/folder1') return Response.json({ mimeType: 'application/vnd.google-apps.folder' });
      if (url.pathname === '/drive/v3/files') {
        return Response.json({ files: ['a', 'b'].map(id => ({
          id, name: names.get(id) || id + '.jpg', mimeType: 'image/jpeg', size: '10', createdTime: '2026-11-08T00:00:00Z',
          capabilities: { canDownload: true }
        })) });
      }
      const fileId = url.pathname.split('/').pop();
      if (method === 'PATCH') {
        const body = JSON.parse(options.body);
        if ('name' in body) {
          assert.deepEqual(body, { name: 'Họp mặt.jpg' });
          names.set(fileId, body.name);
          return Response.json({ id: fileId });
        }
        const { trashed: toTrash } = body;
        if (toTrash) trashed.push(fileId);
        else trashed.splice(trashed.indexOf(fileId), 1);
        events.push(toTrash ? 'trash' : 'untrash');
        return Response.json({ trashed: toTrash });
      }
      if (url.searchParams.get('fields') === 'parents,trashed') {
        if (fileId === 'gone') return new Response(null, { status: 404 });
        return Response.json({ parents: [fileId === 'outsider' ? 'elsewhere' : 'folder1'], trashed: trashed.includes(fileId) });
      }
    }
    if (url.hostname === 'db.example.test') {
      if (url.pathname === '/rest/v1/rpc/record_giadinh_visit' && method === 'POST') return Response.json(42);
      if (url.pathname === '/rest/v1/giadinh_photos' && method === 'PATCH') {
        assert.equal(url.searchParams.get('id'), 'eq.photo-1');
        assert.equal(options.headers.Prefer, 'return=representation');
        assert.deepEqual(JSON.parse(options.body), { original_name: 'Họp mặt.jpg', title: 'Họp mặt.jpg' });
        return Response.json([{ id: 'photo-1' }]);
      }
      if (url.pathname === '/rest/v1/rpc/delete_giadinh_photos') {
        events.push('rpc');
        assert.deepEqual(JSON.parse(options.body).photo_ids, ['photo-1']);
        return Response.json(rpcResult);
      }
      if (url.pathname === '/storage/v1/object/giadinh-originals' && method === 'DELETE') {
        events.push('objects');
        return Response.json([]);
      }
    }
    throw new Error('Unexpected request ' + method + ' ' + url.href);
  });

  const { createPhotoStore } = require('../photo-store');
  const store = createPhotoStore();
  t.after(() => rmSync(store.uploadDir, { recursive: true, force: true }));

  assert.equal(await store.recordVisit(), 42);
  assert.equal(await store.rename('photo-1', 'Họp mặt.jpg'), true);
  assert.equal((await store.get('drive-a')).original_name, 'a.jpg');
  assert.equal(await store.rename('drive-outsider', 'Họp mặt.jpg'), false);
  assert.equal(await store.rename('drive-a', 'Họp mặt.jpg'), true);
  assert.equal((await store.get('drive-a')).original_name, 'Họp mặt.jpg');

  assert.equal(await store.remove(['drive-a', 'drive-missing']), false);
  assert.deepEqual(events, []);

  rpcResult = null;
  assert.equal(await store.remove(['photo-1', 'drive-a']), false);
  assert.deepEqual(trashed, []);

  rpcResult = [{ object_key: 'stored.png', size: 3, part_size: null }];
  events.length = 0;
  assert.equal(await store.remove(['photo-1', 'drive-a', 'drive-b']), true);
  assert.deepEqual(trashed.sort(), ['a', 'b']);
  assert.deepEqual(events, ['rpc', 'objects', 'trash', 'trash']);

  events.length = 0;
  assert.equal(await store.restore(['drive-a']), 1);
  assert.deepEqual(trashed, ['b']);
  assert.deepEqual(events, ['untrash']);
  // Files outside the Gia Đình tree, or already gone for good, are never restored.
  assert.equal(await store.restore(['drive-outsider', 'drive-gone']), 0);
  assert.deepEqual(events, ['untrash']);
});
