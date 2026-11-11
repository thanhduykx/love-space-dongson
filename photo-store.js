const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { createDriveMedia } = require('./drive-media');
const runTransfers = require('./public/js/transfer-pool');

const PART_SIZE = 5 * 1024 * 1024;
const partKey = (key, index) => key + '/part-' + index;
const todayInVietnam = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });

function isPhotoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && !value.startsWith('0000');
}

function legacyDay(photo) {
  if (isPhotoDay(photo.date)) return photo.date;
  for (const value of [photo.date, photo.createdAt]) {
    const date = new Date(value || '');
    if (Number.isFinite(date.getTime())) return todayInVietnam.format(date);
  }
  return null;
}

function localStore() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const uploadDir = path.resolve(process.env.UPLOADS_DIR || path.join(dataDir, 'uploads'));
  const uploadDirs = [...new Set([uploadDir, path.join(__dirname, 'public', 'uploads')])];
  const dbFile = path.join(dataDir, 'photo-library.json');
  const oldDbFile = path.join(dataDir, 'database.json');
  const visitsFile = path.join(dataDir, 'site-visits.json');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  function list() {
    if (fs.existsSync(dbFile)) return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    if (!fs.existsSync(oldDbFile)) return [];
    const { photos = [] } = JSON.parse(fs.readFileSync(oldDbFile, 'utf8'));
    return photos.filter(photo => {
      const seed = /^photo-0([1-4])$/.exec(photo?.id);
      return photo && (!seed || photo.url !== '/uploads/sample-' + seed[1] + '.svg');
    }).map(photo => ({
      id: photo.id,
      object_key: /^\/uploads\/([^/\\:?#<>"|*\x00-\x1f\x7f]+)$/.exec(photo.url || '')?.[1] ?? null,
      original_name: photo.originalName,
      title: photo.title,
      story: photo.story,
      location: photo.location,
      day: legacyDay(photo),
      created_at: photo.createdAt
    }));
  }

  function writeJson(file, value) {
    const tmp = path.join(dataDir, '.photo-library-' + randomUUID() + '.tmp');
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  const save = photos => writeJson(dbFile, photos);

  return {
    uploadDir,
    list,
    get: id => list().find(photo => photo.id === id),
    recordVisit() {
      const previous = fs.existsSync(visitsFile) ? JSON.parse(fs.readFileSync(visitsFile, 'utf8')) : 0;
      const count = previous + 1;
      writeJson(visitsFile, count);
      return count;
    },
    original(photo) {
      const key = photo.object_key;
      if (!key || key !== path.basename(key) || key === '.' || key === '..') return null;
      for (const dir of uploadDirs) {
        const file = path.join(dir, key);
        const stats = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stats?.isFile()) return {
          size: stats.size,
          open: (start, end) => fs.createReadStream(file, { start, end })
        };
      }
      return null;
    },
    insert(photos) {
      save([...photos, ...list()]);
    },
    remember(photos) {
      const current = list();
      const existing = new Set(current.map(photo => photo.id));
      const additions = photos.filter(photo => !existing.has(photo.id));
      if (additions.length) save([...additions, ...current]);
    },
    rename(id, name) {
      const photos = list();
      const photo = photos.find(entry => entry.id === id);
      if (!photo) return false;
      photo.original_name = photo.title = name;
      save(photos);
      return true;
    },
    move(ids, day) {
      const photos = list();
      const selected = new Set(ids);
      if (photos.filter(photo => selected.has(photo.id)).length !== selected.size) return false;
      save(photos.map(photo => selected.has(photo.id) ? { ...photo, day } : photo));
      return true;
    },
    remove(ids) {
      const photos = list();
      const selected = new Set(ids);
      const removed = photos.filter(photo => selected.has(photo.id));
      if (removed.length !== selected.size) return false;
      save(photos.filter(photo => !selected.has(photo.id)));
      // The library file is the source of truth; a leftover file is only wasted space.
      for (const { object_key: key } of removed) {
        if (!key || key !== path.basename(key) || key === '.' || key === '..') continue;
        for (const dir of uploadDirs) {
          try { fs.rmSync(path.join(dir, key), { force: true }); }
          catch (error) { console.error('Deleted photo cleanup failed:', error.message); }
        }
      }
      return true;
    },
    check() {
      list();
    }
  };
}

function supabaseStore(url, secret) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('SUPABASE_URL must be the HTTPS project origin');
  }
  const headers = { apikey: secret };
  if (secret.startsWith('eyJ')) headers.Authorization = 'Bearer ' + secret;
  const table = '/rest/v1/giadinh_photos';
  const bucket = 'giadinh-originals';
  const encodeKey = key => key.split('/').map(encodeURIComponent).join('/');
  const objectPath = key => '/storage/v1/object/' + bucket + '/' + encodeKey(key);
  const uploadDir = path.join(os.tmpdir(), 'giadinh-' + randomUUID());
  fs.mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const pendingWrites = [];
  let activeWrites = 0;

  async function storageWrite(work) {
    if (activeWrites < 6) activeWrites++;
    else await new Promise(resolve => pendingWrites.push(resolve));
    try {
      return await work();
    } finally {
      const next = pendingWrites.shift();
      if (next) next();
      else activeWrites--;
    }
  }

  async function call(endpoint, options = {}) {
    const response = await fetch(new URL(endpoint, base), {
      ...options,
      headers: { ...headers, ...options.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error('Supabase responded with HTTP ' + response.status);
      error.upstreamStatus = response.status;
      throw error;
    }
    return response;
  }

  async function json(endpoint, method, body, options = {}) {
    return call(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', ...options },
      body: JSON.stringify(body)
    });
  }

  async function get(id) {
    const response = await call(table + '?id=eq.' + encodeURIComponent(id) + '&limit=1');
    return (await response.json())[0];
  }

  async function* readObject(key, start, end, size) {
    const endpoint = '/storage/v1/object/authenticated/' + bucket + '/' + encodeKey(key);
    const partial = start > 0 || end < size - 1;
    const response = await call(endpoint, partial ? { headers: { Range: 'bytes=' + start + '-' + end } } : {});
    let skip = partial && response.status !== 206 ? start : 0;
    let remaining = end - start + 1;
    for await (const chunk of Readable.fromWeb(response.body)) {
      const take = chunk.subarray(skip, skip + remaining);
      skip = Math.max(0, skip - chunk.length);
      if (take.length) yield take;
      remaining -= take.length;
      if (remaining === 0) return;
    }
    if (remaining > 0) throw new Error('Stored media part ended early');
  }

  async function* readOriginal(photo, start = 0, end = photo.size - 1) {
    if (photo.size === 0) return;
    if (!photo.part_size) {
      yield* readObject(photo.object_key, start, end, photo.size);
      return;
    }
    const partSize = photo.part_size;
    for (let index = Math.floor(start / partSize); index <= Math.floor(end / partSize); index++) {
      const offset = index * partSize;
      const size = Math.min(partSize, photo.size - offset);
      yield* readObject(partKey(photo.object_key, index), Math.max(0, start - offset), Math.min(size - 1, end - offset), size);
    }
  }

  async function writeObject(key, file, start, length) {
    const response = await call(objectPath(key), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(length),
        'x-upsert': 'false'
      },
      body: length ? fs.createReadStream(file.path, { start, end: start + length - 1 }) : Buffer.alloc(0),
      duplex: 'half'
    });
    await response.body?.cancel();
  }

  return {
    uploadDir,
    async list() {
      const photos = [];
      const pageSize = 100;
      let cursor = '';
      for (;;) {
        const response = await call(table + '?order=id.asc&limit=' + pageSize + cursor);
        const page = await response.json();
        photos.push(...page);
        if (page.length < pageSize) return photos;
        cursor = '&id=gt.' + encodeURIComponent(page[page.length - 1].id);
      }
    },
    get,
    async recordVisit() {
      const response = await json('/rest/v1/rpc/record_giadinh_visit', 'POST', {});
      return response.json();
    },
    original(photo) {
      if (!photo.object_key) return null;
      return {
        size: photo.size,
        open: (start, end) => Readable.from(readOriginal(photo, start, end))
      };
    },
    async insert(photos, files) {
      const attempted = [];
      let writingRows = false;
      try {
        for (const [fileIndex, file] of files.entries()) {
          if (file.size <= PART_SIZE) {
            attempted.push(file.filename);
            await storageWrite(() => writeObject(file.filename, file, 0, file.size));
            continue;
          }
          photos[fileIndex].part_size = PART_SIZE;
          const indices = Array.from({ length: Math.ceil(file.size / PART_SIZE) }, (_, index) => index);
          await runTransfers(indices, 3, index => storageWrite(async () => {
            const start = index * PART_SIZE;
            const key = partKey(file.filename, index);
            attempted.push(key);
            await writeObject(key, file, start, Math.min(PART_SIZE, file.size - start));
          }));
        }
        writingRows = true;
        const response = await json(table, 'POST', photos, { Prefer: 'return=minimal' });
        await response.body?.cancel();
      } catch (error) {
        if (writingRows && (!error.upstreamStatus || error.upstreamStatus >= 500)) {
          // Keep the objects if the commit succeeded or its outcome cannot be established.
          let recorded;
          try {
            recorded = await get(photos[0].id);
          } catch {
            throw error;
          }
          if (recorded) return;
        }
        try {
          const response = await json('/storage/v1/object/' + bucket, 'DELETE', { prefixes: attempted });
          await response.body?.cancel();
        } catch (cleanupError) {
          console.error('Supabase upload cleanup failed:', cleanupError.message);
        }
        throw error;
      }
    },
    async remember(photos) {
      const response = await json(table + '?on_conflict=id', 'POST', photos, {
        Prefer: 'resolution=ignore-duplicates,return=minimal'
      });
      await response.body?.cancel();
    },
    async rename(id, name) {
      const response = await json(table + '?id=eq.' + encodeURIComponent(id) + '&select=id', 'PATCH', {
        original_name: name, title: name
      }, { Prefer: 'return=representation' });
      return (await response.json()).length > 0;
    },
    async move(ids, day) {
      const response = await json('/rest/v1/rpc/move_giadinh_photos', 'POST', { photo_ids: ids, new_day: day });
      return response.json();
    },
    async remove(ids) {
      const response = await json('/rest/v1/rpc/delete_giadinh_photos', 'POST', { photo_ids: ids });
      const removed = await response.json();
      if (!Array.isArray(removed)) return false;
      // Rows are gone at this point, so storage cleanup is best-effort: orphans only cost space.
      const keys = removed.flatMap(({ object_key: key, size, part_size: partSize }) => partSize
        ? Array.from({ length: Math.ceil(size / partSize) }, (_, index) => partKey(key, index))
        : [key]);
      for (let start = 0; start < keys.length; start += 1000) {
        try {
          const cleanup = await json('/storage/v1/object/' + bucket, 'DELETE', { prefixes: keys.slice(start, start + 1000) });
          await cleanup.body?.cancel();
        } catch (error) {
          console.error('Supabase deleted photo cleanup failed:', error.message);
        }
      }
      return true;
    },
    async check() {
      const response = await call(table + '?select=id&limit=1');
      await response.body?.cancel();
    }
  };
}

function createBaseStore() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url && !secret && process.env.RENDER !== 'true') return localStore();
  if (!url || !secret) throw new Error('Configure both SUPABASE_URL and SUPABASE_SECRET_KEY');
  return { ...supabaseStore(url, secret), temporaryUploads: true };
}

function driveFromEnvironment() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const jsonCredentials = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  const oauth = {
    clientId: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN
  };
  const hasOAuth = Boolean(oauth.clientId || oauth.clientSecret || oauth.refreshToken);
  if (!folderId && !jsonCredentials && !hasOAuth) return null;
  if (hasOAuth) {
    if (!oauth.clientId || !oauth.clientSecret || !oauth.refreshToken) {
      throw new Error('Set GOOGLE_DRIVE_OAUTH_CLIENT_ID, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET and GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN together');
    }
    return createDriveMedia({ folderId, oauth });
  }
  let credentials;
  try {
    credentials = JSON.parse(jsonCredentials);
  } catch {
    throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON must contain the Google service account JSON');
  }
  return createDriveMedia({ folderId, credentials });
}

function createPhotoStore() {
  const store = createBaseStore();
  const isDrive = id => typeof id === 'string' && id.startsWith('drive-');
  const storedPhotos = photos => photos.filter(photo => !isDrive(photo.id));
  const drive = driveFromEnvironment();
  if (!drive) return {
    ...store,
    async list() { return storedPhotos(await store.list()); },
    get: id => isDrive(id) ? null : store.get(id),
    rename: (id, name) => isDrive(id) ? false : store.rename(id, name),
    move: (ids, day) => ids.some(isDrive) ? false : store.move(ids, day),
    remove: ids => ids.some(isDrive) ? false : store.remove(ids)
  };

  return {
    ...store,
    async list() {
      const [photos, entries] = await Promise.all([store.list(), drive.refresh().catch(() => new Map())]);
      const dates = new Map(photos.filter(photo => isDrive(photo.id)).map(photo => [photo.id, photo.day]));
      const fromDrive = Array.from(entries.values(), photo => ({ ...photo, day: dates.get(photo.id) ?? photo.day }));
      return [...storedPhotos(photos), ...fromDrive];
    },
    async get(id) {
      return isDrive(id) ? (await drive.refresh()).get(id) : store.get(id);
    },
    original(photo) {
      return photo.driveFileId ? drive.original(photo) : store.original(photo);
    },
    thumbnail: drive.thumbnail,
    rename: (id, name) => isDrive(id) ? drive.rename(id.slice('drive-'.length), name) : store.rename(id, name),
    async move(ids, day) {
      const driveIds = ids.filter(isDrive);
      if (driveIds.length) {
        const entries = await drive.refresh();
        const selected = driveIds.map(id => entries.get(id));
        if (selected.some(photo => !photo)) return false;
        await store.remember(selected.map(photo => ({
          id: photo.id, object_key: photo.object_key, title: photo.title,
          original_name: photo.original_name, day: photo.day, size: 0, created_at: photo.created_at
        })));
      }
      return store.move(ids, day);
    },
    drive,
    /**
     * Stored photos are deleted atomically first; a missing id aborts before anything changes.
     * Drive files then go to Drive's trash. Their saved days are kept so an undo restores them
     * on the same day; a leftover row for a file that never comes back is never listed.
     */
    async remove(ids) {
      const driveIds = ids.filter(isDrive);
      const storedIds = ids.filter(id => !isDrive(id));
      const entries = driveIds.length ? await drive.refresh() : new Map();
      const selected = driveIds.map(id => entries.get(id));
      if (selected.some(photo => !photo)) return false;
      if (storedIds.length && !await store.remove(storedIds)) return false;
      try {
        await runTransfers(selected, 4, photo => drive.trash(photo.driveFileId));
      } finally {
        drive.invalidate();
      }
      return true;
    },
    /** Brings Drive files back from the trash; returns how many were restored. */
    async restore(ids) {
      let restored = 0;
      try {
        await runTransfers(ids, 4, async id => {
          if (await drive.restore(id.slice('drive-'.length))) restored++;
        });
      } finally {
        drive.invalidate();
      }
      return restored;
    },
    async check() {
      await Promise.all([store.check(), drive.refresh()]);
    }
  };
}

module.exports = { createPhotoStore, isPhotoDay, PART_SIZE };
