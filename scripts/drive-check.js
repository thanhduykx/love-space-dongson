#!/usr/bin/env node
/**
 * Confirms the Drive OAuth settings in .env work, without printing any secret:
 * refreshes an access token, shows which Google account it belongs to and, when a folder id
 * is given (argument or GOOGLE_DRIVE_FOLDER_ID), whether that account can add and trash files there.
 * Usage: npm run drive:check -- [folderId]
 */
require('dotenv').config({ quiet: true });

async function main() {
  const { GOOGLE_DRIVE_OAUTH_CLIENT_ID: clientId, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: clientSecret,
    GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: refreshToken } = process.env;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Thiếu biến GOOGLE_DRIVE_OAUTH_* trong .env. Chạy npm run drive:auth trước.');
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken })
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) throw new Error('Google từ chối refresh token: ' + (token.error_description || token.error || tokenResponse.status));
  const headers = { Authorization: 'Bearer ' + token.access_token };

  const about = await (await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)', { headers })).json();
  const quota = about.storageQuota || {};
  const gb = value => value ? (Number(value) / 1024 ** 3).toFixed(1) + ' GB' : 'không giới hạn';
  console.log('✔ Token hợp lệ, tài khoản Drive: ' + about.user?.emailAddress);
  console.log('  Dung lượng: đã dùng ' + gb(quota.usage) + ' / ' + gb(quota.limit));

  const folderId = process.argv[2] || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return console.log('• Chưa có folder id nên bỏ qua kiểm tra thư mục.');
  const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) +
    '?fields=name,mimeType,capabilities(canAddChildren,canTrashChildren)&supportsAllDrives=true', { headers });
  if (!response.ok) throw new Error('Tài khoản này không mở được thư mục ' + folderId + ' (HTTP ' + response.status + ').');
  const folder = await response.json();
  console.log('✔ Thư mục "' + folder.name + '": thêm tệp ' + (folder.capabilities?.canAddChildren ? 'được' : 'KHÔNG'));
  // canTrashChildren is only reported for Shared Drives; in My Drive each file carries its own canTrash.
  const query = new URLSearchParams({
    q: "'" + folderId + "' in parents and trashed = false",
    fields: 'files(capabilities(canTrash))', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'
  });
  const files = (await (await fetch('https://www.googleapis.com/drive/v3/files?' + query, { headers })).json()).files || [];
  const trashable = files.filter(file => file.capabilities?.canTrash).length;
  console.log((trashable === files.length ? '✔' : '⚠') + ' Xóa được ' + trashable + '/' + files.length + ' tệp đang có trong thư mục.');
}

main().catch(error => {
  console.error('✖ ' + error.message);
  process.exit(1);
});
