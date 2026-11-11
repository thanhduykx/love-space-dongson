const assert = require('node:assert/strict');
const { generateKeyPairSync, verify } = require('node:crypto');
const { test } = require('node:test');
const { createDriveMedia } = require('../drive-media');

test('Drive indexes the configured folder and streams original bytes and thumbnails', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let now = Date.parse('2026-11-08T19:00:00Z');
  let listingCalls = 0;
  let folderChecks = 0;
  let tokenCalls = 0;
  const original = Buffer.from([5, 8, 13, 21, 34]);
  const thumbnail = Buffer.from([1, 2, 3]);
  const sample = {
    id: 'media1', name: 'clip.mp4', mimeType: 'video/mp4', size: String(original.length),
    createdTime: '2026-11-08T18:00:00Z', modifiedTime: '2026-11-08T18:30:00Z', capabilities: { canDownload: true },
    thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/sample'
  };
  let pageOne = [sample, { ...sample, id: 'private', capabilities: { canDownload: false } }];
  const drive = createDriveMedia({
    folderId: 'folder1', now: () => now,
    credentials: { client_email: 'viewer@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    async fetcher(input, options) {
      const url = new URL(input);
      if (url.hostname === 'oauth2.googleapis.com') {
        tokenCalls++;
        const [header, claims, signature] = options.body.get('assertion').split('.');
        assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + claims), publicKey, Buffer.from(signature, 'base64url')));
        assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/drive');
        return Response.json({ access_token: 'drive-test-token', expires_in: 3600 });
      }
      assert.equal(options.headers.Authorization, 'Bearer drive-test-token');
      if (url.pathname.endsWith('/folder1')) {
        folderChecks++;
        return Response.json({ mimeType: 'application/vnd.google-apps.folder' });
      }
      if (url.pathname.endsWith('/files')) {
        listingCalls++;
        assert.equal(url.searchParams.get('q'), "('folder1' in parents) and trashed = false");
        return url.searchParams.has('pageToken')
          ? Response.json({ files: [{ ...sample, id: 'media2', name: 'image.heic', mimeType: 'image/heic',
            imageMediaMetadata: { time: '2026:11:05 08:00:00' } }] })
          : Response.json({ files: pageOne, nextPageToken: 'second' });
      }
      if (url.hostname === 'lh3.googleusercontent.com') {
        return new Response(thumbnail, { headers: { 'Content-Type': 'image/jpeg' } });
      }
      assert.equal(url.pathname, '/drive/v3/files/media1');
      assert.equal(url.searchParams.get('alt'), 'media');
      if (!options.headers.Range) return new Response(original);
      assert.equal(options.headers.Range, 'bytes=1-3');
      return new Response(original.subarray(1, 4), {
        status: 206, headers: { 'Content-Range': 'bytes 1-3/5' }
      });
    }
  });
  async function bytes(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const [entries, concurrent] = await Promise.all([drive.refresh(), drive.refresh()]);
  assert.equal(entries, concurrent);
  assert.deepEqual([...entries.keys()], ['drive-media1', 'drive-media2']);
  assert.equal(entries.get('drive-media1').day, '2026-11-09');
  assert.equal(entries.get('drive-media2').day, '2026-11-05');
  const entry = entries.get('drive-media1');
  assert.equal(entry.version, '2026-11-08T18:30:00Z');
  assert.deepEqual(await bytes(await drive.original(entry).open(0, 4)), original);
  assert.deepEqual(await bytes(await drive.original(entry).open(1, 3)), original.subarray(1, 4));
  assert.deepEqual(await bytes((await drive.thumbnail(entry)).stream), thumbnail);
  assert.equal(await drive.thumbnail({ thumbnail: 'https://example.test/thumbnail' }), null);

  pageOne = [];
  now += 4 * 60_000;
  assert.equal((await drive.refresh()).size, 2);
  now += 60_000;
  assert.deepEqual([...(await drive.refresh()).keys()], ['drive-media2']);
  assert.equal(tokenCalls, 1);
  assert.equal(folderChecks, 2);
  assert.equal(listingCalls, 4);
});
