const { createHmac, timingSafeEqual } = require('node:crypto');

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Drive requires every chunk except the last to be a multiple of 256 KiB.
const CHUNK_SIZE = 32 * 256 * 1024;

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Uploads go straight into the Drive folder through Drive resumable sessions.
 * The server opens a session, the browser sends 8 MiB chunks to it (or through the server
 * when Google refuses the browser's CORS request), and the server confirms the finished file
 * before remembering the chosen day. Upload state lives in an HMAC-signed token, so a restart
 * of the sleeping free web instance never loses an upload in progress.
 */
function createDirectUploads({ drive, store, maxSize, now = Date.now }) {
  if (!drive?.startUpload) return null;
  const sign = payload => createHmac('sha256', drive.uploadTokenKey).update(payload).digest('base64url');

  function issue(session) {
    const payload = Buffer.from(JSON.stringify({ v: 2, exp: now() + TOKEN_LIFETIME_MS, ...session })).toString('base64url');
    return payload + '.' + sign(payload);
  }

  function open(token) {
    if (typeof token !== 'string' || token.length > 8192) throw new UploadError(400, 'Phiên tải lên không hợp lệ.');
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) throw new UploadError(400, 'Phiên tải lên không hợp lệ.');
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UploadError(400, 'Phiên tải lên không hợp lệ.');
    }
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.v !== 2 || !(session.exp > now())) throw new UploadError(410, 'Phiên tải lên đã hết hạn. Hãy chọn lại tệp.');
    return session;
  }

  async function progress(work) {
    try {
      return await work();
    } catch (error) {
      if (error.reason === 'sessionExpired') throw new UploadError(410, 'Phiên tải lên đã hết hạn. Hãy chọn lại tệp.');
      throw error;
    }
  }

  const describe = result => result.done ? { done: true, received: null } : { done: false, received: result.received };

  return {
    origin: drive.uploadOrigin,
    chunkSize: CHUNK_SIZE,

    async begin({ name, mimeType, size, day, origin }) {
      if (!Number.isSafeInteger(size) || size < 1) throw new UploadError(400, 'Tệp rỗng hoặc kích thước không hợp lệ.');
      if (size > maxSize) throw new UploadError(413, 'Tệp quá lớn để tải lên.');
      let sessionUrl;
      try {
        sessionUrl = await drive.startUpload({ name, mimeType, size, origin });
      } catch (error) {
        if (error.reason === 'storageQuotaExceeded') {
          throw new UploadError(507, 'Google Drive đã hết dung lượng hoặc tài khoản kết nối không có dung lượng lưu trữ.');
        }
        throw error;
      }
      return { token: issue({ sessionUrl, size, name, day }), sessionUrl, chunkSize: CHUNK_SIZE };
    },

    async status(token) {
      const { sessionUrl, size } = open(token);
      return describe(await progress(() => drive.uploadStatus(sessionUrl, size)));
    },

    /** Forwards one chunk the browser could not send to Google itself. */
    async relay(token, { start, end, body }) {
      const { sessionUrl, size } = open(token);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size ||
          end - start + 1 > CHUNK_SIZE || (end !== size - 1 && (end - start + 1) % (256 * 1024) !== 0)) {
        throw new UploadError(400, 'Phần tệp gửi lên không hợp lệ.');
      }
      return describe(await progress(() => drive.uploadChunk(sessionUrl, { start, end, size, body })));
    },

    async finish(token) {
      const { sessionUrl, size, name, day } = open(token);
      const result = await progress(() => drive.uploadStatus(sessionUrl, size));
      if (!result.done) throw new UploadError(409, 'Tệp chưa được tải lên đầy đủ. Hãy thử lại.');
      const { file } = result;
      if (!file?.id || file.trashed || Number(file.size) !== size || !file.parents?.includes(drive.folderId)) {
        throw new UploadError(502, 'Google Drive chưa xác nhận tệp vừa tải lên.');
      }
      const id = 'drive-' + file.id;
      // Remembering the row is what pins the day the user picked; Drive alone only knows capture time.
      await store.remember([{
        id, object_key: id, title: name, original_name: name, day, size: 0, created_at: new Date(now()).toISOString()
      }]);
      drive.invalidate();
      return { id, day };
    }
  };
}

module.exports = { createDirectUploads, UploadError };
