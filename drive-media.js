const { createHmac, createPrivateKey, sign } = require('node:crypto');
const { Readable } = require('node:stream');
const media = require('./public/js/media-types');

const tokenUrl = 'https://oauth2.googleapis.com/token';
const filesUrl = 'https://www.googleapis.com/drive/v3/files';
const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files';
const driveScope = 'https://www.googleapis.com/auth/drive';
const uploadFields = 'id,name,mimeType,size,parents,trashed';
const refreshInterval = 5 * 60_000;
const folderMime = 'application/vnd.google-apps.folder';
const parentsPerQuery = 40;
const maxFolderDepth = 6;
const maxFolders = 300;
const driveId = /^[A-Za-z0-9_-]{1,94}$/;
const thumbnailType = /^image\/(?:jpeg|png|webp|gif|avif)$/;
const vietnamDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });

class DriveError extends Error {
  constructor(message, upstreamStatus, reason) {
    super(message);
    this.upstreamStatus = upstreamStatus;
    this.reason = reason;
  }
}

async function failureReason(response) {
  try {
    const body = await response.json();
    return body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;
  } catch {
    return null;
  }
}

/**
 * Two ways to act on Drive:
 * - OAuth refresh token of the folder owner: required for a personal ("My Drive") folder,
 *   because service accounts have no storage quota and cannot own uploaded files there.
 * - Service account: works when the folder lives in a Shared Drive where it is a Content manager.
 */
function tokenGrant({ credentials, oauth, now }) {
  if (oauth?.clientId && oauth.clientSecret && oauth.refreshToken) {
    return {
      secret: oauth.clientSecret + '\n' + oauth.refreshToken,
      body: () => new URLSearchParams({
        grant_type: 'refresh_token', client_id: oauth.clientId,
        client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken
      })
    };
  }
  if (!credentials?.client_email || !credentials.private_key) return null;
  const key = createPrivateKey(credentials.private_key);
  return {
    secret: credentials.private_key,
    body() {
      const issued = Math.floor(now() / 1000);
      const claims = { iss: credentials.client_email, scope: driveScope, aud: tokenUrl, iat: issued, exp: issued + 3600 };
      const unsigned = [JSON.stringify({ alg: 'RS256', typ: 'JWT' }), JSON.stringify(claims)]
        .map(value => Buffer.from(value).toString('base64url')).join('.');
      const assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
      return new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    }
  };
}

function validSessionUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'www.googleapis.com' && !url.port && !url.username &&
    url.pathname === '/upload/drive/v3/files' && Boolean(url.searchParams.get('upload_id'));
}

function createDriveMedia({ folderId, credentials, oauth, fetcher = fetch, now = Date.now }) {
  const grant = driveId.test(folderId || '') ? tokenGrant({ credentials, oauth, now }) : null;
  if (!grant) {
    throw new Error('Configure GOOGLE_DRIVE_FOLDER_ID with GOOGLE_DRIVE_OAUTH_* or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
  }
  let token;
  let tokenRequest;
  let index = new Map();
  let knownFolders = new Set([folderId]);
  let refreshAfter = 0;
  let refreshRequest;

  // `allow` lists non-2xx statuses the caller handles itself (308 for resumable uploads).
  async function request(url, options, { timeout = 30_000, allow = [] } = {}) {
    const response = await fetcher(url, {
      ...options, redirect: 'manual', signal: AbortSignal.timeout(timeout)
    });
    if (!response.ok && !allow.includes(response.status)) {
      const reason = await failureReason(response);
      throw new DriveError('Google Drive responded with HTTP ' + response.status, response.status, reason);
    }
    return response;
  }

  async function getToken() {
    if (token && token.expires > now()) return token.value;
    tokenRequest ??= (async () => {
      const response = await request(tokenUrl, { method: 'POST', body: grant.body() });
      const result = await response.json();
      if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error('Invalid Google access token response');
      token = { value: result.access_token, expires: now() + result.expires_in * 1000 - 60_000 };
      return token.value;
    })().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }

  async function authorized(url, { method = 'GET', headers = {}, body, timeout, allow, retry = true } = {}) {
    const send = async value => request(url, {
      method, headers: { ...headers, Authorization: 'Bearer ' + value }, body,
      ...(body && typeof body.pipe === 'function' && { duplex: 'half' })
    }, { timeout, allow });
    const value = await getToken();
    try {
      return await send(value);
    } catch (error) {
      // A streamed body is already consumed, so only replayable requests retry with a new token.
      if (error.upstreamStatus !== 401 || !retry) throw error;
      if (token?.value === value) token = null;
      return send(await getToken());
    }
  }

  async function listFolder() {
    const folder = await authorized(filesUrl + '/' + folderId + '?fields=mimeType,trashed&supportsAllDrives=true');
    const folderInfo = await folder.json();
    if (folderInfo.trashed || folderInfo.mimeType !== folderMime) {
      throw new Error('Configured Drive folder is unavailable');
    }
    const entries = new Map();
    const folders = new Set([folderId]);
    // Walk the folder tree one level at a time, asking about many parents per query.
    let frontier = [folderId];
    for (let depth = 0; frontier.length && depth <= maxFolderDepth; depth++) {
      const next = [];
      for (let start = 0; start < frontier.length; start += parentsPerQuery) {
        const parents = frontier.slice(start, start + parentsPerQuery);
        for (const file of await listChildren(parents)) {
          if (file.mimeType === folderMime) {
            if (driveId.test(file.id || '') && !folders.has(file.id) && folders.size < maxFolders) {
              folders.add(file.id);
              next.push(file.id);
            }
            continue;
          }
          const entry = mediaEntry(file);
          if (entry) entries.set(entry.id, entry);
        }
      }
      frontier = next;
    }
    return { entries, folders };
  }

  async function listChildren(parents) {
    // Every id is checked against driveId before reaching the query, so it cannot break out of the quotes.
    const query = new URLSearchParams({
      q: '(' + parents.map(id => "'" + id + "' in parents").join(' or ') + ') and trashed = false',
      fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,imageMediaMetadata(time),thumbnailLink,capabilities(canDownload))',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    const files = [];
    for (;;) {
      const response = await authorized(filesUrl + '?' + query);
      const page = await response.json();
      files.push(...(page.files || []));
      if (!page.nextPageToken) return files;
      query.set('pageToken', page.nextPageToken);
    }
  }

  function mediaEntry(file) {
    const size = Number(file.size);
    if (!driveId.test(file.id || '') || !file.size || !Number.isSafeInteger(size) || size < 0 ||
        file.capabilities?.canDownload !== true || !media.accepts(file.name, file.mimeType)) return null;
    const created = new Date(file.createdTime);
    if (!Number.isFinite(created.getTime())) return null;
    const captureDay = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(file.imageMediaMetadata?.time || '')?.slice(1).join('-');
    const captureDate = new Date(captureDay);
    const validCapture = Number.isFinite(captureDate.getTime()) &&
      captureDate.toISOString().slice(0, 10) === captureDay && !captureDay.startsWith('0000');
    const id = 'drive-' + file.id;
    return {
      id, object_key: id, original_name: file.name, title: file.name, size, media_type: file.mimeType,
      day: validCapture ? captureDay : vietnamDay.format(created),
      created_at: created.toISOString(), driveFileId: file.id, thumbnail: file.thumbnailLink,
      version: file.modifiedTime || null
    };
  }

  async function refresh() {
    if (now() < refreshAfter) return index;
    refreshRequest ??= listFolder().then(({ entries, folders }) => {
      index = entries;
      knownFolders = folders;
      refreshAfter = now() + refreshInterval;
      return index;
    }).finally(() => { refreshRequest = null; });
    return refreshRequest;
  }

  // Drive thumbnail links end in "=s220"; asking for a bigger edge returns a JPEG rendition of any image, HEIC included.
  function sizedThumbnail(link, edge) {
    if (!edge) return link;
    const url = new URL(link);
    url.pathname = /=s\d+(-[\w-]+)?$/.test(url.pathname)
      ? url.pathname.replace(/=s\d+(-[\w-]+)?$/, '=s' + edge)
      : url.pathname + '=s' + edge;
    return url.href;
  }

  // Turns a resumable-session response into how many bytes Drive holds, or the finished file.
  async function uploadProgress(response) {
    if (response.status === 308) {
      await response.body?.cancel();
      const range = /^bytes=0-(\d+)$/.exec(response.headers.get('Range') || '');
      return { done: false, received: range ? Number(range[1]) + 1 : 0 };
    }
    const file = await response.json();
    return { done: true, file };
  }

  function sessionRequest(sessionUrl, options) {
    if (!validSessionUrl(sessionUrl)) throw new DriveError('Invalid Drive upload session', 400);
    return authorized(sessionUrl, { method: 'PUT', allow: [308], ...options }).catch(error => {
      // Drive forgets sessions after about a week, or after the upload was cancelled.
      if (error.upstreamStatus === 404 || error.upstreamStatus === 410) {
        throw new DriveError('Drive upload session expired', 410, 'sessionExpired');
      }
      throw error;
    });
  }

  async function fileLocation(fileId) {
    if (!driveId.test(fileId || '')) throw new DriveError('Invalid Drive file id', 400);
    await refresh();
    try {
      const response = await authorized(filesUrl + '/' + fileId + '?fields=parents,trashed&supportsAllDrives=true');
      const file = await response.json();
      return file.parents?.some(parent => knownFolders.has(parent)) ? file : null;
    } catch (error) {
      if (error.upstreamStatus === 404) return null;
      throw error;
    }
  }

  return {
    folderId,
    uploadOrigin: new URL(uploadUrl).origin,
    // Derived from the Drive credential so upload tokens cannot be forged without it.
    uploadTokenKey: createHmac('sha256', grant.secret).update('giadinh-drive-upload-v1').digest(),
    refresh,
    invalidate() {
      refreshAfter = 0;
    },
    original(photo) {
      return {
        size: photo.size,
        async open(start, end) {
          const partial = start > 0 || end < photo.size - 1;
          const headers = partial ? { Range: 'bytes=' + start + '-' + end } : {};
          const response = await authorized(filesUrl + '/' + photo.driveFileId + '?alt=media&supportsAllDrives=true',
            { headers, timeout: 600_000 });
          const length = response.headers.get('Content-Length');
          if (response.status !== (partial ? 206 : 200) || (length !== null && Number(length) !== end - start + 1) ||
              (partial && response.headers.get('Content-Range') !== 'bytes ' + start + '-' + end + '/' + photo.size)) {
            await response.body?.cancel();
            throw new Error('Unexpected byte range from Google Drive');
          }
          return Readable.fromWeb(response.body);
        }
      };
    },
    async thumbnail(photo, edge) {
      if (!URL.canParse(photo.thumbnail || '')) return null;
      const url = new URL(sizedThumbnail(photo.thumbnail, edge));
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/^lh\d+\.googleusercontent\.com$/.test(url.hostname)) return null;
      const response = await authorized(url);
      const type = response.headers.get('Content-Type')?.split(';')[0];
      if (!thumbnailType.test(type)) {
        await response.body?.cancel();
        return null;
      }
      return { type, stream: Readable.fromWeb(response.body) };
    },

    /**
     * Opens a resumable upload into the folder. The returned session URL is itself the
     * credential for sending bytes, so the browser can upload without a Google token.
     * Passing the app's Origin lets Google answer that browser's CORS requests.
     */
    async startUpload({ name, mimeType, size, origin }) {
      const query = new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true', fields: uploadFields });
      const response = await authorized(uploadUrl + '?' + query, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(size),
          ...(mimeType && { 'X-Upload-Content-Type': mimeType }),
          ...(origin && { Origin: origin })
        },
        body: JSON.stringify({ name, parents: [folderId], ...(mimeType && { mimeType }) })
      });
      const sessionUrl = response.headers.get('Location');
      await response.body?.cancel();
      if (!validSessionUrl(sessionUrl)) throw new Error('Google Drive returned an unexpected upload session URL');
      return sessionUrl;
    },
    async uploadStatus(sessionUrl, size) {
      return uploadProgress(await sessionRequest(sessionUrl, {
        headers: { 'Content-Range': 'bytes */' + size, 'Content-Length': '0' }
      }));
    },
    async uploadChunk(sessionUrl, { start, end, size, body }) {
      return uploadProgress(await sessionRequest(sessionUrl, {
        headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': String(end - start + 1) },
        body, timeout: 600_000, retry: false
      }));
    },
    async rename(fileId, name) {
      const file = await fileLocation(fileId);
      if (!file || file.trashed) return false;
      const response = await authorized(filesUrl + '/' + fileId + '?supportsAllDrives=true&fields=id', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name })
      });
      await response.body?.cancel();
      // A listing started before the rename may still contain the old name.
      await refreshRequest?.catch(() => {});
      refreshAfter = 0;
      return true;
    },
    /**
     * Takes a file back out of Drive's trash, but only if it lives somewhere in the Gia Đình tree,
     * so the endpoint cannot be used to restore unrelated files of the account.
     */
    async restore(fileId) {
      const info = await fileLocation(fileId);
      if (!info) return false;
      if (info.trashed) {
        const response = await authorized(filesUrl + '/' + fileId + '?supportsAllDrives=true&fields=id,trashed', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ trashed: false })
        });
        await response.body?.cancel();
      }
      return true;
    },
    /** Moves a file to Drive's trash, where the owner can restore it for 30 days. */
    async trash(fileId) {
      if (!driveId.test(fileId || '')) throw new DriveError('Invalid Drive file id', 400);
      try {
        const response = await authorized(filesUrl + '/' + fileId + '?supportsAllDrives=true&fields=id,trashed', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ trashed: true })
        });
        await response.body?.cancel();
      } catch (error) {
        if (error.upstreamStatus !== 404) throw error;
      }
    }
  };
}

module.exports = { createDriveMedia, DriveError };
