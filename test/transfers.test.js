const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createPhotoStore } = require('../photo-store');

test('Supabase writes parts concurrently, assembles the exact original and cleans failed uploads', async t => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://storage.example.test',
    SUPABASE_SECRET_KEY: 'test-key',
    GOOGLE_DRIVE_FOLDER_ID: '',
    GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: '',
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: '',
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: '',
    GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: ''
  });
  const store = createPhotoStore();
  t.after(() => rmSync(store.uploadDir, { recursive: true, force: true }));
  const partSize = 5 * 1024 * 1024;
  const bytes = Buffer.alloc(2 * partSize + 30, 17);
  bytes.fill(31, partSize, 2 * partSize).fill(249, 2 * partSize);
  const file = { filename: 'test.mp4', size: bytes.length, path: path.join(store.uploadDir, 'test.mp4') };
  writeFileSync(file.path, bytes);

  const objects = new Map();
  let active = 0;
  let peak = 0;
  let failing = false;
  const bucket = '/storage/v1/object/giadinh-originals';
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const { pathname } = new URL(input);
    if (pathname === '/rest/v1/giadinh_photos') return new Response(null, { status: 201 });
    if (options.method === 'POST' && pathname.startsWith(bucket + '/')) {
      active++;
      peak = Math.max(active, peak);
      const key = pathname.slice(bucket.length + 1);
      try {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        if (failing && key.endsWith('/part-1')) return new Response(null, { status: 500 });
        objects.set(key, Buffer.concat(chunks));
        return new Response(null, { status: 201 });
      } finally {
        active--;
      }
    }
    if (options.method === 'DELETE' && pathname === bucket) {
      assert.equal(active, 0);
      for (const key of JSON.parse(options.body).prefixes) objects.delete(key);
      return new Response(null, { status: 200 });
    }
    const key = pathname.split('/giadinh-originals/')[1];
    assert.ok(objects.has(key));
    return new Response(objects.get(key));
  });
  const photo = { id: 'photo-test', object_key: file.filename, size: file.size };
  await store.insert([photo], [file]);
  assert.equal(peak, 3);
  const hash = createHash('sha256');
  for await (const chunk of store.original(photo).open(0, file.size - 1)) hash.update(chunk);
  assert.equal(hash.digest('hex'), createHash('sha256').update(bytes).digest('hex'));

  failing = true;
  const failedFile = { ...file, filename: 'failed.mp4' };
  await assert.rejects(store.insert([{ ...photo, id: 'photo-failed', object_key: failedFile.filename }], [failedFile]), /HTTP 500/);
  assert.ok([...objects.keys()].every(key => key.startsWith(file.filename + '/')));
});
