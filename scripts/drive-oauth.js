#!/usr/bin/env node
/**
 * Gets a Google Drive refresh token for the account that owns the Gia Đình folder,
 * without OAuth Playground and without printing the token.
 *
 * Usage: `npm run drive:auth -- path/to/client_secret_….json` with the JSON downloaded for a
 * "Desktop app" OAuth client (its id and secret are copied into .env without being printed),
 * or put GOOGLE_DRIVE_OAUTH_CLIENT_ID and GOOGLE_DRIVE_OAUTH_CLIENT_SECRET in .env yourself.
 * The script opens a loopback listener on 127.0.0.1, prints the consent URL, exchanges the
 * code (with PKCE and a state check), writes GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN into .env and,
 * when GOOGLE_DRIVE_FOLDER_ID is set, checks that the account can write to that folder.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
require('dotenv').config({ quiet: true });

const envFile = path.join(__dirname, '..', '.env');
const scope = 'https://www.googleapis.com/auth/drive';
const timeoutMs = 5 * 60_000;

function fail(message) {
  console.error('\n✖ ' + message);
  process.exit(1);
}

function writeEnv(name, value) {
  const line = name + '=' + value;
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const pattern = new RegExp('^' + name + '=.*$', 'm');
  const next = pattern.test(current) ? current.replace(pattern, line) : current.replace(/\n?$/, '\n') + line + '\n';
  fs.writeFileSync(envFile, next, { mode: 0o600 });
}

function waitForCode(server, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hết 5 phút mà chưa đăng nhập xong.')), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? '<p>Đã cấp quyền. Quay lại terminal.</p>' : '<p>Yêu cầu không hợp lệ. Hãy chạy lại lệnh.</p>');
      clearTimeout(timer);
      if (ok) resolve(url.searchParams.get('code'));
      else reject(new Error(url.searchParams.get('error') || 'Mã state không khớp, có thể yêu cầu không phải từ lệnh này.'));
    });
  });
}

async function checkFolder(accessToken, folderId) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) +
    '?fields=name,mimeType,capabilities(canAddChildren,canTrashChildren)&supportsAllDrives=true';
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return 'Không mở được thư mục ' + folderId + ' (HTTP ' + response.status + '). Kiểm tra GOOGLE_DRIVE_FOLDER_ID và tài khoản đã đăng nhập.';
  const folder = await response.json();
  if (folder.mimeType !== 'application/vnd.google-apps.folder') return 'GOOGLE_DRIVE_FOLDER_ID không phải một thư mục.';
  if (!folder.capabilities?.canAddChildren) return 'Tài khoản này không có quyền thêm tệp vào thư mục "' + folder.name + '".';
  if (!folder.capabilities?.canTrashChildren) {
    return 'Tải lên được vào "' + folder.name + '", nhưng tài khoản này không xóa được tệp của người khác trong thư mục.';
  }
  return null;
}

function importClientFile(file) {
  let client;
  try {
    client = JSON.parse(fs.readFileSync(file, 'utf8')).installed;
  } catch (error) {
    fail('Không đọc được tệp OAuth client: ' + error.message);
  }
  if (!client?.client_id || !client.client_secret) {
    fail('Tệp này không phải OAuth client loại "Desktop app" (thiếu mục "installed").');
  }
  writeEnv('GOOGLE_DRIVE_OAUTH_CLIENT_ID', client.client_id);
  writeEnv('GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', client.client_secret);
  process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID = client.client_id;
  process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = client.client_secret;
  console.log('✔ Đã chép client ID và client secret từ tệp vào .env.');
}

async function main() {
  if (process.argv[2]) importClientFile(path.resolve(process.argv[2]));
  const clientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fail('Thêm GOOGLE_DRIVE_OAUTH_CLIENT_ID và GOOGLE_DRIVE_OAUTH_CLIENT_SECRET (OAuth client loại "Desktop app") vào .env rồi chạy lại.');
  }

  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = 'http://127.0.0.1:' + server.address().port + '/callback';
  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope,
    // offline + consent makes Google issue a refresh token even if one was granted before.
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
  });

  console.log('Mở đường dẫn sau trong trình duyệt và đăng nhập bằng tài khoản sở hữu thư mục Drive:\n');
  console.log(consent.href + '\n');
  let code;
  try {
    code = await waitForCode(server, state);
  } finally {
    server.close();
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: clientId, client_secret: clientSecret, code_verifier: verifier
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) fail('Google từ chối đổi mã: ' + (result.error_description || result.error || 'HTTP ' + response.status));
  if (!result.refresh_token) fail('Google không trả refresh token. Gỡ quyền của app tại myaccount.google.com/permissions rồi chạy lại.');
  if (!String(result.scope || '').split(' ').includes(scope)) fail('Bạn chưa cấp quyền Google Drive đầy đủ. Hãy chạy lại và tích chọn quyền Drive.');

  writeEnv('GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN', result.refresh_token);
  console.log('✔ Đã ghi GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN vào .env (token không được in ra).');

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    console.log('• Chưa có GOOGLE_DRIVE_FOLDER_ID trong .env nên bỏ qua bước kiểm tra thư mục.');
    return;
  }
  const problem = await checkFolder(result.access_token, folderId);
  if (problem) fail(problem);
  console.log('✔ Tài khoản này tải lên và xóa được trong thư mục Drive đã cấu hình.');
}

main().catch(error => fail(error.message));
