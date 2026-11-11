const express = require('express');
const multer = require('multer');
const compression = require('compression');
const fs = require('node:fs');
const path = require('node:path');
const mime = require('mime-types');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createPhotoStore, isPhotoDay } = require('./photo-store');
const { createDirectUploads, UploadError } = require('./direct-upload');
const media = require('./public/js/media-types');
require('dotenv').config({ quiet: true });

const store = createPhotoStore();
const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 ** 3;
const directUploads = createDirectUploads({ drive: store.drive, store, maxSize: MAX_DIRECT_UPLOAD_BYTES });
const connectSources = ["'self'", ...(directUploads ? [directUploads.origin] : [])].join(' ');
const app = express();
app.disable('x-powered-by');

// Send people who open an old address (e.g. love-space.onrender.com) to the family domain.
// Health checks stay reachable everywhere so Render and the Supabase keepalive keep working,
// and only page loads are redirected: API calls from an already open page are left alone.
const canonicalHost = (process.env.CANONICAL_HOST || '').trim().toLowerCase();
if (canonicalHost) {
  app.use((req, res, next) => {
    const host = (req.get('Host') || '').toLowerCase();
    if (!host || host === canonicalHost || host.startsWith('localhost') || host.startsWith('127.0.0.1')) return next();
    if (!['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/health') || req.path.startsWith('/api/')) return next();
    res.redirect(301, 'https://' + canonicalHost + req.originalUrl);
  });
}
app.use(compression());
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

const success = (res, data) => res.json({ success: true, data });
const failure = (res, status, message) => res.status(status).json({ success: false, message });

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'giadinh' }));
app.get('/health/keepalive', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await store.check();
    res.json({ status: 'ok', service: 'giadinh' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('Origin');
  const originHost = origin && URL.canParse(origin) ? new URL(origin).host : null;
  if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && originHost !== req.get('Host'))) {
    return failure(res, 403, 'Yêu cầu phải được gửi từ trang Gia Đình.');
  }
  next();
});

app.use(express.json({ limit: '160kb' }));
app.use(express.urlencoded({ extended: false, limit: '160kb', parameterLimit: 1000 }));
app.use('/uploads', (req, res) => res.sendStatus(404));
// Versioned vendor files and fonts never change under the same name; decoration rarely does;
// pages, scripts and styles revalidate with their ETag so a deploy shows up on the next load.
function staticCacheControl(filePath) {
  const relative = path.relative(path.join(__dirname, 'public'), filePath).split(path.sep).join('/');
  if (/^(vendor|fonts)\//.test(relative)) return 'public, max-age=31536000, immutable';
  if (relative.startsWith('images/')) return 'public, max-age=604800';
  return 'no-cache';
}

app.use(express.static(path.join(__dirname, 'public'), {
  cacheControl: false,
  setHeaders(res, filePath) {
    res.set('Cache-Control', staticCacheControl(filePath));
    res.set('Content-Security-Policy', "default-src 'self'; connect-src " + connectSources + "; img-src 'self' data: blob:; media-src 'self'; frame-src 'self'; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: store.uploadDir,
    filename(req, file, done) {
      done(null, storedKey(file.originalname));
    }
  }),
  defParamCharset: 'utf8',
  limits: { fields: 1, fieldSize: 50, files: 10 },
  fileFilter(req, file, done) {
    if (!media.accepts(file.originalname, file.mimetype)) {
      const error = new Error('Hãy chọn ảnh, video hoặc tệp đi kèm ảnh và video.');
      error.status = 400;
      return done(error);
    }
    done(null, true);
  }
}).array('photos', 10);

function storedKey(name) {
  const extension = path.extname(name).toLowerCase();
  return randomUUID() + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.bin');
}

function newPhoto({ key, name, type, size, day, createdAt }) {
  return {
    id: 'photo-' + randomUUID(),
    object_key: key,
    original_name: name,
    title: name,
    day,
    size,
    media_type: mediaType(name, type),
    ...(createdAt && { created_at: createdAt })
  };
}

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

function selectedIds(input) {
  const ids = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(validId)) return null;
  return [...new Set(ids)];
}

function originalName(photo) {
  const name = typeof photo.original_name === 'string' ? photo.original_name : '';
  return name.split(/[/\\]/).pop().replace(/[\x00-\x1f\x7f]/g, '') || photo.object_key || 'anh';
}

function mediaType(filename, supplied) {
  const fromExtension = mime.lookup(filename);
  if (media.mediaMime.test(fromExtension)) return fromExtension;
  if (media.mediaMime.test(supplied)) return supplied.toLowerCase();
  if (media.videoExtensions.test(filename)) return 'video/octet-stream';
  return 'application/octet-stream';
}

function archivePhoto(photo) {
  const original = store.original(photo);
  return {
    id: photo.id,
    title: photo.title,
    story: photo.story,
    location: photo.location,
    day: photo.day,
    url: original ? '/api/photos/' + encodeURIComponent(photo.id) + '/preview' : null,
    ...(photo.thumbnail && { thumbnail: '/api/photos/' + encodeURIComponent(photo.id) + '/thumbnail' }),
    ...(photo.thumbnail && mediaType(originalName(photo), photo.media_type).startsWith('image/') &&
      { large: '/api/photos/' + encodeURIComponent(photo.id) + '/large' }),
    originalName: originalName(photo),
    ...(original && { downloadVersion: downloadVersion(photo) }),
    type: mediaType(originalName(photo), photo.media_type),
    size: original?.size ?? null
  };
}

app.get('/api/photos', async (req, res) => {
  // Revalidate every time; Express's ETag turns an unchanged list into a bodyless 304.
  res.set('Cache-Control', 'private, no-cache');
  success(res, (await store.list()).map(archivePhoto));
});

app.post('/api/visits', async (req, res) => {
  success(res, { count: await store.recordVisit() });
});

// With Drive configured every upload must land in Drive; an outdated page would bypass it.
const legacyUploadsOnly = (req, res, next) => directUploads
  ? failure(res, 409, 'Trang đã cũ. Hãy tải lại trang rồi gửi ảnh lần nữa.')
  : next();

app.post('/api/photos/upload', legacyUploadsOnly, upload, async (req, res) => {
  const files = req.files || [];
  let saved = false;
  try {
    if (!files.length) return failure(res, 400, 'Hãy chọn ít nhất một ảnh.');
    const { date } = req.body;
    if (!isPhotoDay(date)) return failure(res, 400, 'Ngày lưu ảnh không hợp lệ.');

    const createdAt = new Date().toISOString();
    const photos = files.map(file => newPhoto({
      key: file.filename, name: file.originalname, type: file.mimetype, size: file.size, day: date, createdAt
    }));
    await store.insert(photos, files);
    saved = true;
    success(res, photos.map(archivePhoto));
  } finally {
    if (!saved || store.temporaryUploads) {
      for (const file of files) {
        try { fs.unlinkSync(file.path); }
        catch (error) { console.error('Temporary upload cleanup failed:', error.message); }
      }
    }
  }
});

// One JSON line per failed upload step, so failures can be counted in Render logs without asking anyone.
function logUploadFailure(details) {
  console.warn(JSON.stringify({ event: 'upload_failed', at: new Date().toISOString(), ...details }));
}

const logged = (stage, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    logUploadFailure({
      source: 'server', stage, status: error.status ?? error.upstreamStatus ?? 500,
      reason: error.reason ?? null, message: String(error.message).slice(0, 200),
      size: Number(req.body?.size) || Number(req.get('Content-Length')) || null
    });
    throw error;
  }
};

// Same name and byte size as something already in the library: almost always the same photo sent twice.
async function findDuplicate(name, size) {
  if (!Number.isSafeInteger(size)) return null;
  return (await store.list()).find(photo => photo.original_name === name && Number(photo.size) === size) ?? null;
}

// Direct uploads into the Drive folder. Without Drive (local development or Supabase only)
// the client falls back to the multipart route above.
app.post('/api/photos/uploads', logged('session', async (req, res) => {
  if (!directUploads) return success(res, { direct: false });
  const { name, type = '', size, date } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name) ||
      typeof type !== 'string' || type.length > 127 || !media.accepts(name, type)) {
    return failure(res, 400, 'Hãy chọn ảnh, video hoặc tệp đi kèm ảnh và video.');
  }
  if (!isPhotoDay(date)) return failure(res, 400, 'Ngày lưu ảnh không hợp lệ.');
  const duplicate = await findDuplicate(name, size);
  if (duplicate) return success(res, { direct: true, duplicate: { id: duplicate.id, day: duplicate.day } });
  const origin = req.get('Origin');
  const session = await directUploads.begin({
    name, mimeType: mediaType(name, type), size, day: date,
    origin: origin && URL.canParse(origin) ? new URL(origin).origin : null
  });
  success(res, { direct: true, ...session });
}));

app.post('/api/photos/uploads/status', logged('status', async (req, res) => {
  if (!directUploads) return res.sendStatus(404);
  success(res, await directUploads.status(req.body?.token));
}));

// Fallback for browsers whose direct request to Google fails: the chunk streams through unbuffered.
app.put('/api/photos/uploads/chunk', logged('chunk', async (req, res) => {
  if (!directUploads) return res.sendStatus(404);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.get('Content-Range') || '');
  const start = range ? Number(range[1]) : NaN;
  const end = range ? Number(range[2]) : NaN;
  if (!range || Number(req.get('Content-Length')) !== end - start + 1) {
    return failure(res, 400, 'Phần tệp gửi lên không hợp lệ.');
  }
  success(res, await directUploads.relay(req.get('X-Upload-Token'), { start, end, body: req }));
}));

app.post('/api/photos/uploads/complete', logged('complete', async (req, res) => {
  if (!directUploads) return res.sendStatus(404);
  success(res, await directUploads.finish(req.body?.token));
}));

// The browser reports uploads that failed on its side (for example a chunk sent straight to Google).
const REPORT_STAGES = new Set(['session', 'chunk', 'status', 'complete', 'legacy']);
app.post('/api/photos/uploads/report', (req, res) => {
  const { stage, status, size, message } = req.body ?? {};
  if (!REPORT_STAGES.has(stage) || !Number.isInteger(status) || status < 0 || status > 599 ||
      !Number.isSafeInteger(size) || size < 0 || typeof message !== 'string') {
    return failure(res, 400, 'Báo cáo không hợp lệ.');
  }
  logUploadFailure({ source: 'client', stage, status, size, message: message.slice(0, 200) });
  success(res);
});

app.put('/api/photos/archive-date', async (req, res) => {
  const ids = selectedIds(req.body?.ids);
  const day = req.body?.date;
  if (!ids || !isPhotoDay(day)) return failure(res, 400, 'Hãy chọn ảnh và nhập ngày hợp lệ.');
  if (!await store.move(ids, day)) return failure(res, 404, 'Một ảnh đã chọn không còn trong kho.');
  success(res);
});

app.put('/api/photos/:id/name', async (req, res) => {
  const { id } = req.params;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const invalidName = 'Tên tệp không hợp lệ. Hãy bỏ dấu chấm ở cuối và các ký tự như /, \\, : hoặc ?.';
  if (!validId(id) || !name || !name.isWellFormed() || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) ||
      name.endsWith('.') || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    return failure(res, 400, invalidName);
  }
  const photo = await store.get(id);
  if (!photo) return failure(res, 404, 'Không tìm thấy tệp cần đổi tên.');
  const previous = originalName(photo);
  const extension = path.extname(previous);
  if (!extension && path.extname(name)) return failure(res, 400, 'Tệp này không có phần đuôi. Hãy nhập tên không có phần đuôi mới.');
  const filename = name + extension;
  if (filename.length > 255) return failure(res, 400, 'Tên tệp quá dài. Hãy nhập tên ngắn hơn.');
  try {
    if (filename !== previous && !await store.rename(id, filename)) {
      return failure(res, 404, 'Không tìm thấy tệp cần đổi tên.');
    }
  } catch (error) {
    if (photo.driveFileId && error.upstreamStatus === 403) {
      return failure(res, 403, 'Tài khoản Google Drive chưa có quyền đổi tên tệp này.');
    }
    throw error;
  }
  success(res);
});

app.delete('/api/photos', async (req, res) => {
  const ids = selectedIds(req.body?.ids);
  if (!ids) return failure(res, 400, 'Hãy chọn ảnh cần xóa.');
  if (!await store.remove(ids)) return failure(res, 404, 'Một ảnh đã chọn không còn trong kho.');
  success(res, { deleted: ids.length });
});

app.post('/api/photos/restore', async (req, res) => {
  const ids = selectedIds(req.body?.ids);
  if (!ids || !store.restore || ids.some(id => !id.startsWith('drive-'))) {
    return failure(res, 400, 'Chỉ khôi phục được ảnh lưu trên Google Drive.');
  }
  const restored = await store.restore(ids);
  if (restored !== ids.length) return failure(res, 404, 'Có ảnh đã bị xóa hẳn khỏi Thùng rác nên không khôi phục được.');
  success(res, { restored });
});

// Uploaded objects get a fresh random key, so their bytes never change under the same id.
// Drive files can be edited in place, so they are revalidated against modifiedTime instead.
const IMMUTABLE_MEDIA = 'private, max-age=31536000, immutable, no-transform';
const REVALIDATED_MEDIA = 'private, no-cache, no-transform';
const DRIVE_THUMBNAIL = 'private, max-age=86400, no-transform';
// Long edge of the JPEG preview Drive renders for images: sharp on phones, a fraction of the original's size.
const LARGE_PREVIEW_EDGE = 1600;

function downloadVersion(photo) {
  return createHash('sha256').update(originalName(photo)).digest('base64url').slice(0, 16);
}

function mediaETag(photo, format) {
  const identity = [photo.id, photo.object_key, photo.size, photo.version ?? '', format];
  if (format === 'original') identity.push(downloadVersion(photo));
  return '"' + createHash('sha256').update(identity.join('|')).digest('base64url').slice(0, 27) + '"';
}

function setMediaValidators(res, photo, format, cacheControl) {
  const etag = mediaETag(photo, format);
  res.set('ETag', etag).set('Cache-Control', cacheControl);
  return etag;
}

app.get('/api/photos/:id/:format', async (req, res, next) => {
  const { id, format } = req.params;
  if (!['preview', 'original', 'thumbnail', 'large'].includes(format)) return next();
  const photo = validId(id) && await store.get(id);
  if (format === 'thumbnail' || format === 'large') {
    if (!photo?.thumbnail) return res.sendStatus(404);
    setMediaValidators(res, photo, format, DRIVE_THUMBNAIL);
    if (req.fresh) return res.sendStatus(304);
    const thumbnail = await store.thumbnail(photo, format === 'large' ? LARGE_PREVIEW_EDGE : undefined);
    if (!thumbnail) {
      res.removeHeader('ETag');
      return res.set('Cache-Control', 'no-store').sendStatus(404);
    }
    res.type(thumbnail.type);
    return pipeline(thumbnail.stream, res);
  }
  const original = photo && store.original(photo);
  if (!original) return failure(res, 404, 'Không tìm thấy tệp gốc.');

  // Original responses carry a filename, so they must also revalidate after a rename.
  const etag = setMediaValidators(res, photo, format,
    photo.driveFileId || format === 'original' ? REVALIDATED_MEDIA : IMMUTABLE_MEDIA);
  if (req.fresh) return res.sendStatus(304);
  // A stale If-Range means the client's partial copy is outdated: send the whole file instead.
  const ifRange = req.get('If-Range');
  const rangeAllowed = !ifRange || ifRange === etag;
  const ranges = original.size && rangeAllowed ? req.range(original.size, { combine: true }) : undefined;
  res.set('Accept-Ranges', 'bytes');
  if (ranges === -1) {
    res.removeHeader('ETag');
    res.set('Content-Range', 'bytes */' + original.size).set('Cache-Control', 'no-store');
    return res.sendStatus(416);
  }
  const range = ranges?.type === 'bytes' && ranges.length === 1 ? ranges[0] : null;
  const start = range?.start ?? 0;
  const end = range?.end ?? original.size - 1;
  const stream = req.method !== 'HEAD' && original.size ? await original.open(start, end) : null;
  if (format === 'original') res.attachment(originalName(photo));
  res.type(mediaType(originalName(photo), photo.media_type));
  res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  res.set('Content-Length', String(end - start + 1));
  if (range) {
    res.status(206).set('Content-Range', 'bytes ' + start + '-' + end + '/' + original.size);
  }
  if (!stream) return res.end();
  await pipeline(stream, res);
});

app.use((req, res) => res.sendStatus(404));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (res.destroyed) return;
  if (error instanceof multer.MulterError) {
    return failure(res, 400, 'Mỗi lượt gửi chỉ nhận tối đa 10 tệp và một ngày lưu.');
  }
  if (error instanceof UploadError) return failure(res, error.status, error.message);
  if (error.status === 400 || error.status === 413) return failure(res, error.status, 'Tệp hoặc yêu cầu không hợp lệ.');
  if (error.upstreamStatus === 404) return failure(res, 404, 'Không tìm thấy tệp gốc.');
  console.error('Photo library request failed:', error.message);
  failure(res, 500, 'Máy chủ chưa xử lý được yêu cầu. Hãy thử lại.');
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => console.log('Gia Dinh · http://localhost:' + port));
}

module.exports = { app };
