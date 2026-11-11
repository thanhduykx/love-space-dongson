const byId = id => document.getElementById(id);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
const number = new Intl.NumberFormat('vi-VN');
const dayWords = new Intl.DateTimeFormat('vi-VN', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
});
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const selectionLimit = 1000;

const state = {
  photos: [], visible: [], selected: new Set(), selecting: false, deleting: false, cards: new Map(), groups: [],
  previewIndex: -1, queued: [], uploading: false, moveIds: [], deleteIds: [], loadError: ''
};

const gallery = byId('gallery');
const search = byId('search');
const filterDay = byId('filter-day');
const sort = byId('sort');
const uploadDialog = byId('upload-dialog');
const uploadBubble = byId('upload-bubble');
const previewDialog = byId('preview-dialog');
const renameDialog = byId('rename-dialog');
const dateDialog = byId('date-dialog');
const deleteDialog = byId('delete-dialog');
const downloadDialog = byId('download-dialog');
const supportsFolderDownload = typeof window.showDirectoryPicker === 'function';
const supportsFileShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
let preparedShare = null;
let shareLoading = false;
let notificationTimer;
let downloadBatch = [];
let batchDownloading = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function button(text, className) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function sizeLabel(bytes) {
  if (bytes == null) return 'Chưa có tệp gốc';
  if (bytes < 1024) return `${number.format(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / 1024 ** unit;
  return `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(size)} ${units[unit - 1]}`;
}

function displayDay(day) {
  return day ? dayWords.format(new Date(`${day}T00:00:00Z`)) : 'Chưa phân ngày';
}

function normalize(value) {
  return (value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/đ/g, 'd');
}

function notify(message, { action, duration = 6000 } = {}) {
  const output = byId('notification');
  const actionButton = byId('notification-action');
  clearTimeout(notificationTimer);
  byId('notification-text').textContent = message;
  actionButton.hidden = !action;
  actionButton.onclick = null;
  if (action) {
    actionButton.textContent = action.label;
    actionButton.onclick = () => {
      output.hidden = true;
      action.run();
    };
  }
  output.hidden = false;
  notificationTimer = setTimeout(() => { output.hidden = true; }, duration);
}

// Days are picked with "Hôm nay" / "Hôm qua" buttons and always read back in words,
// so "11/08" can never be mistaken for 11 August on a phone set to English.
function shiftDay(offset) {
  const day = new Date(today.format(new Date()) + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

function setupDayPicker(fieldset) {
  const input = byId(fieldset.dataset.dayInput);
  const words = fieldset.querySelector('.day-words');
  const presets = [...fieldset.querySelectorAll('[data-day-offset]')];
  const other = fieldset.querySelector('[data-day-other]');
  const sync = () => {
    words.textContent = input.value ? dayWords.format(new Date(input.value + 'T00:00:00Z')) : 'Chưa chọn ngày';
    let matched = false;
    for (const preset of presets) {
      const active = input.hidden && input.value === shiftDay(Number(preset.dataset.dayOffset));
      matched ||= active;
      preset.setAttribute('aria-pressed', String(active));
    }
    other.setAttribute('aria-pressed', String(!matched));
  };
  for (const preset of presets) {
    preset.addEventListener('click', () => {
      input.value = shiftDay(Number(preset.dataset.dayOffset));
      input.hidden = true;
      sync();
    });
  }
  other.addEventListener('click', () => {
    input.hidden = false;
    input.focus();
    try { input.showPicker?.(); } catch { /* some browsers only allow it from a direct tap on the input */ }
    sync();
  });
  input.addEventListener('change', sync);
  return {
    set(day) {
      input.value = day;
      input.hidden = presets.some(preset => shiftDay(Number(preset.dataset.dayOffset)) === day);
      sync();
    }
  };
}

let wakeLock = null;
// Keeps the phone screen on while uploading; a sleeping screen suspends the page and the upload with it.
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

function errorMessage(id, message = '') {
  const output = byId(id);
  output.textContent = message;
  output.hidden = !message;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw Object.assign(new Error(body?.message || 'Yêu cầu chưa thực hiện được.'), { status: response.status });
  }
  return body.data;
}

async function recordVisit() {
  try {
    const { count } = await api('/api/visits', { method: 'POST' });
    byId('visit-total').textContent = number.format(count);
    byId('visit-count').hidden = false;
  } catch { /* the gallery still works when the counter is unavailable */ }
}

let gallerySnapshot;
let galleryRequest = 0;

async function loadPhotos({ preservePreview = false } = {}) {
  const request = ++galleryRequest;
  try {
    const photos = await api('/api/photos', { cache: 'no-cache' });
    if (request !== galleryRequest) return;
    const snapshot = JSON.stringify(photos);
    if (snapshot === gallerySnapshot && !state.loadError) return;
    gallerySnapshot = snapshot;
    state.photos = photos.map(photo => ({
      ...photo,
      search: normalize([photo.title, photo.originalName, photo.story, photo.location].join(' '))
    }));
    const existing = new Set(photos.map(photo => photo.id));
    state.selected = new Set([...state.selected].filter(id => existing.has(id)));
    state.loadError = '';
  } catch {
    if (request !== galleryRequest) return;
    state.loadError = 'Không thể tải thư viện ảnh.';
  }
  const previewId = preservePreview && previewDialog.open ? state.visible[state.previewIndex]?.id : null;
  renderGallery();
  if (previewId) {
    state.previewIndex = state.visible.findIndex(photo => photo.id === previewId);
    if (state.previewIndex < 0) previewDialog.close();
    else updatePreviewNavigation();
  }
}

function imageSource(photo) {
  try {
    const source = new URL(photo.url, location.origin);
    return ['http:', 'https:'].includes(source.protocol) ? source.href : '';
  } catch {
    return '';
  }
}

function displayImage(container, photo, preview = false) {
  const fallback = () => container.replaceChildren(preview
    ? element('p', '', 'Trình duyệt không mở được bản xem trước. Bạn có thể tải tệp gốc nếu tệp còn trên máy chủ.')
    : icon('image'));
  const source = photo.url && imageSource(photo);
  if (!source) return fallback();
  if (preview) container.classList.add('loading');
  const loaded = () => container.classList.remove('loading');
  if (photo.type?.startsWith('video/')) {
    if (!preview) {
      const tag = element('span', 'video-tag');
      tag.append(icon('play'), document.createTextNode('Video'));
      container.replaceChildren(tag);
      if (photo.thumbnail) {
        const cover = element('img');
        cover.alt = '';
        cover.loading = 'lazy';
        cover.decoding = 'async';
        cover.addEventListener('load', () => cover.classList.add('loaded'), { once: true });
        cover.addEventListener('error', () => cover.remove(), { once: true });
        cover.src = photo.thumbnail;
        container.prepend(cover);
      }
      return;
    }
    const video = element('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if (photo.thumbnail) video.poster = photo.thumbnail;
    video.addEventListener('error', () => { loaded(); if (video.parentNode === container) fallback(); }, { once: true });
    video.addEventListener('loadeddata', loaded, { once: true });
    video.src = source;
    container.replaceChildren(video);
    return;
  }
  const image = element('img');
  image.alt = preview ? photo.title || photo.originalName || 'Ảnh đang xem' : '';
  image.decoding = 'async';
  if (!preview) image.loading = 'lazy';
  const sources = preview ? [photo.large, source, photo.thumbnail] : [photo.thumbnail, source];
  const candidates = sources.filter(Boolean);
  image.addEventListener('error', () => {
    if (image.parentNode !== container) return;
    const next = candidates.shift();
    if (next) image.src = next;
    else {
      loaded();
      fallback();
    }
  });
  image.addEventListener('load', () => {
    image.classList.add('loaded');
    loaded();
  });
  image.src = candidates.shift();
  container.replaceChildren(image);
}

function renderGallery() {
  const query = normalize(search.value.trim());
  const day = filterDay.value;
  state.visible = state.photos.filter(photo => (!day || photo.day === day) && photo.search.includes(query));
  state.visible.sort((a, b) => {
    if (!a.day || !b.day) return Number(!a.day) - Number(!b.day);
    return sort.value === 'oldest' ? a.day.localeCompare(b.day) : b.day.localeCompare(a.day);
  });
  const hasFilters = Boolean(day || sort.value !== 'newest');
  byId('filter-indicator').hidden = !hasFilters;
  byId('clear-filters').hidden = !query && !hasFilters;
  byId('result-count').textContent = state.loadError || `${number.format(state.visible.length)} mục`;
  state.cards.clear();
  state.groups = [];
  gallery.replaceChildren();
  if (state.loadError || !state.visible.length) {
    const empty = element('div', 'placeholder');
    const filtered = query || day;
    empty.append(icon('image'), element('strong', '', state.loadError || (filtered ? 'Không tìm thấy ảnh hoặc video' : 'Chưa có ảnh hoặc video')));
    const action = button(state.loadError ? 'Tải lại' : filtered ? 'Xóa tìm kiếm và bộ lọc' : 'Tải ảnh và video lên', 'button secondary');
    action.addEventListener('click', state.loadError ? loadPhotos : filtered ? resetFilters : openUpload);
    empty.append(action);
    gallery.append(empty);
    updateSelection();
    return;
  }

  const grouped = new Map();
  state.visible.forEach((photo, index) => {
    if (!grouped.has(photo.day)) grouped.set(photo.day, []);
    grouped.get(photo.day).push({ photo, index });
  });

  for (const [groupDay, entries] of grouped) {
    const section = element('section');
    const heading = element('div', 'group-heading');
    const groupTitle = displayDay(groupDay);
    const groupToggle = button('Chọn nhóm này', 'button text-button');
    const ids = entries.map(({ photo }) => photo.id);
    groupToggle.addEventListener('click', () => toggleSelection(ids));
    heading.append(element('h3', '', groupTitle), groupToggle);
    state.groups.push({ control: groupToggle, ids, title: groupTitle });
    const grid = element('div', 'photo-grid');

    for (const { photo, index } of entries) {
      const card = element('article', 'card');
      const control = button('', 'photo-button');
      const thumbnail = element('span', 'thumbnail');
      const caption = element('span', 'photo-caption');
      const title = photo.title || photo.originalName || 'Chưa đặt tên';
      const check = element('span', 'photo-check');
      check.append(icon('check'));
      check.setAttribute('aria-hidden', 'true');
      displayImage(thumbnail, photo);
      caption.append(element('strong', '', title));
      control.append(thumbnail, caption);
      control.addEventListener('click', () => state.selecting ? toggleSelection([photo.id]) : openPreview(index));
      card.append(control, check);
      grid.append(card);
      state.cards.set(photo.id, { card, control, check, title });
    }
    section.append(heading, grid);
    gallery.append(section);
  }
  updateSelection();
}

function resetFilters() {
  search.value = '';
  filterDay.value = '';
  sort.value = 'newest';
  renderGallery();
}

function updateSelection() {
  const count = state.selected.size;
  const visibleCount = state.visible.filter(photo => state.selected.has(photo.id)).length;
  const unavailable = state.photos.some(photo => state.selected.has(photo.id) && photo.size == null);
  byId('selection-toggle').setAttribute('aria-pressed', String(state.selecting && !state.deleting));
  byId('selection-toggle').querySelector('span').textContent = state.selecting && !state.deleting ? 'Xong' : 'Tải về / Đổi ngày';
  byId('selection-toggle').hidden = state.deleting;
  byId('delete-mode').setAttribute('aria-pressed', String(state.deleting));
  byId('delete-mode').querySelector('span').textContent = state.deleting ? 'Hủy xóa' : 'Xóa';
  byId('delete-mode').hidden = state.selecting && !state.deleting;
  byId('selection-bar').hidden = !state.selecting;
  byId('selection-bar').classList.toggle('delete-mode', state.deleting);
  document.querySelector('.library').classList.toggle('deleting', state.deleting);
  byId('change-selected-date').hidden = state.deleting;
  byId('download-selected').hidden = state.deleting;
  byId('delete-selected').className = state.deleting ? 'button danger' : 'button text-button danger-text';
  byId('delete-selected').querySelector('span').textContent = state.deleting && count ? `Xóa ${number.format(count)} mục` : 'Xóa';
  byId('selected-count').textContent = state.deleting && !count ? 'Chạm vào ảnh muốn xóa' : count ? `Đã chọn ${number.format(count)} mục${count > visibleCount ? ` (${number.format(count - visibleCount)} mục đang ẩn)` : ''}` : 'Chưa chọn mục nào';
  byId('select-visible').disabled = !state.visible.length;
  byId('select-visible').textContent = state.visible.length && visibleCount === state.visible.length ? 'Bỏ chọn mục đang hiện' : 'Chọn tất cả đang hiện';
  byId('clear-selection').disabled = count === 0;
  byId('change-selected-date').disabled = count === 0;
  byId('delete-selected').disabled = count === 0;
  byId('download-selected').disabled = count === 0;
  byId('download-selected').title = unavailable ? 'Một số mục đã chọn chưa có tệp gốc' : '';

  for (const [id, { card, control, check, title }] of state.cards) {
    const selected = state.selected.has(id);
    card.classList.toggle('selected', selected);
    check.hidden = !state.selecting;
    control.setAttribute('aria-label', `${state.selecting ? 'Chọn' : 'Xem trước'} ${title}`);
    if (state.selecting) control.setAttribute('aria-pressed', String(selected));
    else control.removeAttribute('aria-pressed');
  }
  for (const { control, ids, title } of state.groups) {
    const selected = ids.every(id => state.selected.has(id));
    control.hidden = !state.selecting;
    control.textContent = selected ? 'Bỏ chọn nhóm' : 'Chọn nhóm này';
    control.setAttribute('aria-label', `${control.textContent} · ${title}`);
  }
}

function toggleSelection(ids) {
  if (ids.every(id => state.selected.has(id))) {
    ids.forEach(id => state.selected.delete(id));
  } else {
    const selected = new Set([...state.selected, ...ids]);
    if (selected.size > selectionLimit) return notify('Bạn có thể chọn tối đa 1.000 ảnh mỗi lượt.');
    state.selected = selected;
  }
  updateSelection();
}

function openPreview(index) {
  state.previewIndex = index;
  renderPreview();
  previewDialog.showModal();
}

function updatePreviewNavigation() {
  byId('preview-position').textContent = `${state.previewIndex + 1} trên ${state.visible.length}`;
  byId('preview-nav').hidden = state.visible.length < 2;
  byId('preview-prev').disabled = state.previewIndex <= 0;
  byId('preview-next').disabled = state.previewIndex >= state.visible.length - 1;
}

function renderPreview() {
  const photo = state.visible[state.previewIndex];
  if (!photo) return;
  const title = photo.title || photo.originalName || 'Chưa đặt tên';
  byId('preview-title').textContent = title;
  updatePreviewNavigation();
  displayImage(byId('preview-media'), photo, true);
  byId('preview-info').textContent = [displayDay(photo.day), photo.location].filter(Boolean).join(' · ');
  byId('preview-story').textContent = photo.story || '';
  byId('preview-story').hidden = !photo.story;
  const download = byId('download-original');
  download.hidden = photo.size == null;
  download.href = originalUrl(photo);
  const save = byId('save-to-photos');
  save.hidden = photo.size == null || !supportsFileShare || !giaDinhMedia.mediaMime.test(photo.type);
  download.classList.toggle('primary', save.hidden);
  download.classList.toggle('secondary', !save.hidden);
  save.textContent = 'Lưu vào Ảnh';
  errorMessage('preview-share-status');
  if (preparedShare?.control === save) preparedShare = null;
}

function movePreview(offset) {
  const next = state.previewIndex + offset;
  if (next < 0 || next >= state.visible.length) return;
  state.previewIndex = next;
  renderPreview();
}

function openRename() {
  const photo = state.visible[state.previewIndex];
  if (!photo) return;
  const dot = photo.originalName.lastIndexOf('.');
  const extension = dot > 0 ? photo.originalName.slice(dot) : '';
  const input = byId('rename-name');
  input.value = extension ? photo.originalName.slice(0, dot) : photo.originalName;
  byId('rename-extension').textContent = extension ? `Giữ nguyên phần đuôi ${extension}` : '';
  errorMessage('rename-error');
  renameDialog.showModal();
  input.select();
}

async function submitRename(event) {
  event.preventDefault();
  const photo = state.visible[state.previewIndex];
  const input = byId('rename-name');
  const submit = byId('rename-submit');
  const cancel = byId('rename-cancel');
  if (!photo || submit.disabled) return;
  submit.disabled = cancel.disabled = true;
  input.readOnly = true;
  errorMessage('rename-error');
  try {
    await api('/api/photos/' + encodeURIComponent(photo.id) + '/name', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: input.value })
    });
    renameDialog.close();
    await loadPhotos();
    if (previewDialog.open) {
      state.previewIndex = state.visible.findIndex(entry => entry.id === photo.id);
      if (state.previewIndex < 0) previewDialog.close();
      else renderPreview();
    }
    notify('Đã lưu tên mới.');
  } catch (error) {
    errorMessage('rename-error', error.message);
  } finally {
    submit.disabled = cancel.disabled = false;
    input.readOnly = false;
  }
}

function openUpload() {
  if (!state.queued.length) uploadDay.set(filterDay.value || today.format(new Date()));
  uploadDialog.showModal();
  renderQueue();
}

function closeUpload() {
  uploadDialog.close();
  updateUploadBubble();
  if (!uploadBubble.hidden) uploadBubble.focus({ preventScroll: true });
}

function updateUploadBubble() {
  const label = state.uploading ? `Đang gửi ${byId('upload-meter').getAttribute('aria-valuenow')}%`
    : `Chưa gửi ${number.format(state.queued.length)} tệp`;
  const output = byId('upload-bubble-label');
  if (output.textContent !== label) output.textContent = label;
  uploadBubble.hidden = uploadDialog.open || (!state.uploading && !state.queued.length);
}

function addFiles(files) {
  let rejected = 0;
  const key = file => [file.name, file.size, file.lastModified].join('|');
  const queued = new Set(state.queued.map(key));
  for (const file of files) {
    if (!giaDinhMedia.accepts(file.name, file.type)) rejected++;
    else if (!queued.has(key(file))) {
      queued.add(key(file));
      state.queued.push(file);
    }
  }
  errorMessage('upload-error', rejected ? `${rejected} tệp có định dạng chưa được hỗ trợ.` : '');
  renderQueue();
}

const queueRows = new Map();
const queueStatus = new Map();
const previewUrls = new Map();
const STATUS_TEXT = { done: 'Đã lưu', skipped: 'Đã có, bỏ qua', failed: 'Chưa gửi được' };

function previewUrl(file) {
  if (!file.type.startsWith('image/')) return null;
  if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
  return previewUrls.get(file);
}

function releasePreviews() {
  for (const [file, url] of previewUrls) {
    if (state.queued.includes(file)) continue;
    URL.revokeObjectURL(url);
    previewUrls.delete(file);
  }
}

function drumSpinner() {
  const spinner = icon('drum');
  spinner.classList.add('drum-spinner');
  return spinner;
}

function showStatus(file) {
  const entry = queueRows.get(file);
  if (!entry) return;
  const { status = 'waiting', progress = 0 } = queueStatus.get(file) || {};
  entry.row.className = 'queue-row ' + status;
  entry.status.replaceChildren();
  if (status === 'done' || status === 'skipped') entry.status.append(icon('check'));
  if (status === 'sending') entry.status.append(drumSpinner());
  entry.status.append(document.createTextNode(
    status === 'sending' ? `Đang gửi ${Math.round(progress * 100)}%`
      : status === 'waiting' ? `Chờ gửi · ${sizeLabel(file.size)}` : STATUS_TEXT[status]));
}

function setStatus(file, status, progress = 0) {
  queueStatus.set(file, { status, progress });
  showStatus(file);
}

function renderQueue() {
  updateUploadBubble();
  const list = byId('queued-files');
  list.replaceChildren();
  queueRows.clear();
  releasePreviews();
  const retry = byId('upload-submit');
  retry.hidden = state.uploading || !state.queued.length;
  retry.disabled = retry.hidden;
  if (!state.queued.length) return;
  const size = state.queued.reduce((total, file) => total + file.size, 0);
  list.append(element('p', 'queued-summary', `${number.format(state.queued.length)} tệp · ${sizeLabel(size)}`));
  for (const file of state.queued) {
    const row = element('div', 'queue-row');
    const thumb = element('span', 'queue-thumb');
    const url = previewUrl(file);
    if (url) {
      const image = element('img');
      image.alt = '';
      image.decoding = 'async';
      image.addEventListener('error', () => image.replaceWith(icon('image')));
      image.src = url;
      thumb.append(image);
    } else {
      thumb.append(icon(file.type.startsWith('video/') || giaDinhMedia.videoExtensions.test(file.name) ? 'play' : 'image'));
    }
    const text = element('span', 'queue-text');
    const status = element('small', 'queue-status');
    text.append(element('span', 'queue-name', file.name), status);
    row.append(thumb, text);
    if (!state.uploading) {
      const remove = button('', 'icon-button');
      remove.setAttribute('aria-label', `Bỏ ${file.name}`);
      remove.append(icon('close'));
      remove.addEventListener('click', () => {
        state.queued.splice(state.queued.indexOf(file), 1);
        queueStatus.delete(file);
        renderQueue();
      });
      row.append(remove);
    }
    list.append(row);
    queueRows.set(file, { row, status });
    showStatus(file);
  }
}

const CHUNK_ATTEMPTS = 5;
const CHUNK_TIMEOUT_MS = 5 * 60_000;

const postJson = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

class ChunkError extends Error {
  constructor(message, { retryable = false, network = false, status = 0 } = {}) {
    super(message);
    this.retryable = retryable;
    this.network = network;
    this.status = status;
  }
}

// Sends one chunk and resolves with what the upload session now holds.
function putChunk({ url, headers, blob, onProgress, read }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.timeout = CHUNK_TIMEOUT_MS;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener('progress', event => onProgress(event.loaded));
    xhr.addEventListener('load', () => {
      const result = read(xhr);
      if (result) return resolve(result);
      const expired = xhr.status === 404 || xhr.status === 410;
      reject(new ChunkError(expired ? 'Phiên tải lên đã hết hạn. Hãy chọn lại tệp.' : `Tải lên bị từ chối (mã ${xhr.status}).`,
        { retryable: !expired && xhr.status !== 413 && xhr.status !== 507, status: xhr.status }));
    });
    xhr.addEventListener('error', () => reject(new ChunkError('Kết nối mạng bị gián đoạn.', { retryable: true, network: true })));
    xhr.addEventListener('timeout', () => reject(new ChunkError('Mạng quá chậm, phần tệp không gửi kịp.', { retryable: true })));
    xhr.send(blob);
  });
}

// Google answers 308 while bytes are missing and 200/201 once the file exists.
function readDrive(end) {
  return xhr => {
    if (xhr.status === 200 || xhr.status === 201) return { done: true };
    if (xhr.status !== 308) return null;
    const range = /^bytes=0-(\d+)$/.exec(xhr.getResponseHeader('Range') || '');
    return { done: false, received: range ? Number(range[1]) + 1 : end };
  };
}

function readRelay(xhr) {
  if (xhr.status < 200 || xhr.status >= 300) return null;
  try {
    const body = JSON.parse(xhr.responseText);
    return body.success ? body.data : null;
  } catch {
    return null;
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const SESSION_STORE = 'giadinh-upload-sessions';
const SESSION_MAX_AGE = 20 * 60 * 60 * 1000;
const fileKey = file => [file.name, file.size, file.lastModified].join('|');

function storedSessions() {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_STORE) || '{}');
    return Object.fromEntries(Object.entries(all).filter(([, session]) => Date.now() - session.at < SESSION_MAX_AGE));
  } catch {
    return {};
  }
}

function storeSession(key, session) {
  try {
    const all = storedSessions();
    if (session) all[key] = session;
    else delete all[key];
    localStorage.setItem(SESSION_STORE, JSON.stringify(all));
  } catch { /* private mode or blocked storage: uploads still work, only resuming after a reload does not */ }
}

async function uploadDirect(file, session, onProgress, resume = false) {
  const { token, sessionUrl, chunkSize } = session;
  let offset = 0;
  if (resume) {
    const status = await postJson('/api/photos/uploads/status', { token });
    if (status.done) {
      onProgress(1);
      await postJson('/api/photos/uploads/complete', { token });
      return;
    }
    offset = status.received;
    onProgress(offset / file.size);
  }
  let relay = false;
  let delivered = false;
  let failures = 0;
  for (;;) {
    const end = Math.min(file.size, offset + chunkSize);
    const blob = file.slice(offset, end);
    const range = `bytes ${offset}-${end - 1}/${file.size}`;
    const progress = loaded => onProgress((offset + loaded) / file.size);
    let result;
    try {
      result = await putChunk(relay
        ? { url: '/api/photos/uploads/chunk', blob, onProgress: progress, read: readRelay,
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': range, 'X-Upload-Token': token } }
        : { url: sessionUrl, blob, onProgress: progress, read: readDrive(end), headers: { 'Content-Range': range } });
      delivered = true;
      failures = 0;
    } catch (error) {
      // A first chunk that never reaches Google is usually CORS: send the rest through the server.
      if (!relay && !delivered && error.network) {
        relay = true;
        continue;
      }
      if (!error.retryable || ++failures >= CHUNK_ATTEMPTS) throw error;
      await wait(1000 * 2 ** (failures - 1));
      // Ask Drive how much it actually kept, then resume from exactly there.
      result = await postJson('/api/photos/uploads/status', { token }).catch(() => ({ done: false, received: offset }));
    }
    if (result.done) break;
    offset = result.received;
    onProgress(offset / file.size);
  }
  onProgress(1);
  await postJson('/api/photos/uploads/complete', { token });
}

async function uploadFile(file, date, onProgress) {
  const key = fileKey(file);
  const unfinished = storedSessions()[key];
  if (unfinished?.date === date) {
    try {
      await uploadDirect(file, unfinished, onProgress, true);
      storeSession(key, null);
      return 'resumed';
    } catch (error) {
      // An expired or unknown session starts over; anything else (offline) keeps it for the next try.
      if (error.status !== 400 && error.status !== 410) throw error;
      storeSession(key, null);
    }
  }
  const session = await postJson('/api/photos/uploads', { name: file.name, type: file.type, size: file.size, date });
  if (session.duplicate) return 'duplicate';
  if (session.direct) {
    storeSession(key, { token: session.token, sessionUrl: session.sessionUrl, chunkSize: session.chunkSize, date, at: Date.now() });
    await uploadDirect(file, session, onProgress);
    storeSession(key, null);
    return 'saved';
  }
  return uploadThroughServer(file, date, onProgress);
}

function uploadThroughServer(file, date, onProgress) {
  const form = new FormData();
  form.append('date', date);
  form.append('photos', file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/photos/upload');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response?.success) resolve();
      else reject(new Error(xhr.response?.message || `Máy chủ trả về mã ${xhr.status}.`));
    });
    xhr.addEventListener('error', () => reject(new Error('Kết nối với máy chủ bị gián đoạn.')));
    xhr.send(form);
  });
}

async function submitUpload(event) {
  event?.preventDefault();
  if (state.uploading || !state.queued.length) return;
  const date = byId('upload-day').value;
  if (!date) return errorMessage('upload-error', 'Hãy chọn ngày lưu.');
  const files = [...state.queued];
  const totalBytes = files.reduce((total, file) => total + file.size, 0) || 1;
  const startedAt = performance.now();
  const controls = uploadDialog.querySelectorAll('input, .day-picker button');
  const close = byId('upload-close');
  const minimize = byId('upload-minimize');
  let saved = 0;
  let skipped = 0;
  let finished = 0;
  let firstError;
  let showUploadedDay = false;

  // Progress is weighted by bytes, so a long video and a handful of photos give an honest time left.
  function updateOverall() {
    const sent = files.reduce((total, file) => {
      const { status, progress = 0 } = queueStatus.get(file) || {};
      return total + (status === 'done' || status === 'skipped' ? file.size : status === 'sending' ? progress * file.size : 0);
    }, 0);
    const percent = Math.min(100, Math.round(sent / totalBytes * 100));
    const meter = byId('upload-meter');
    meter.firstElementChild.style.width = percent + '%';
    meter.setAttribute('aria-valuenow', String(percent));
    updateUploadBubble();
    const elapsed = (performance.now() - startedAt) / 1000;
    let left = '';
    if (elapsed > 3 && sent > 0 && sent < totalBytes) {
      const seconds = (totalBytes - sent) / (sent / elapsed);
      left = seconds < 60 ? ' · còn dưới 1 phút' : ` · còn khoảng ${number.format(Math.round(seconds / 60))} phút`;
    }
    byId('upload-progress-text').textContent = `Đang gửi ${number.format(finished)}/${number.format(files.length)} tệp${left}`;
  }

  state.uploading = true;
  keepAwake(true);
  controls.forEach(control => { control.disabled = true; });
  close.setAttribute('aria-label', 'Thu nhỏ');
  close.title = 'Thu nhỏ';
  minimize.textContent = 'Thu nhỏ';
  files.forEach(file => queueStatus.set(file, { status: 'waiting', progress: 0 }));
  byId('upload-progress').hidden = false;
  errorMessage('upload-error');
  renderQueue();
  updateOverall();
  try {
    // Each file is one sequential Drive session; three at once keeps a mobile uplink busy.
    await runTransfers(files, 3, async file => {
      setStatus(file, 'sending', 0);
      try {
        const result = await uploadFile(file, date, progress => {
          setStatus(file, 'sending', progress);
          updateOverall();
        });
        if (result === 'duplicate') skipped++;
        else saved++;
        setStatus(file, result === 'duplicate' ? 'skipped' : 'done');
      } catch (error) {
        setStatus(file, 'failed');
        firstError ??= error;
        postJson('/api/photos/uploads/report', {
          stage: error instanceof ChunkError ? 'chunk' : 'session', status: error.status ?? 0,
          size: file.size, message: String(error.message).slice(0, 200)
        }).catch(() => {});
      }
      finished++;
      updateOverall();
    });
    state.queued = files.filter(file => queueStatus.get(file)?.status === 'failed');
    if (firstError) throw firstError;
    // Let the last check marks show before the dialog goes away.
    if (!reducedMotion()) await wait(700);
    showUploadedDay = uploadDialog.open;
    if (showUploadedDay) {
      uploadDialog.close();
      search.value = '';
      filterDay.value = date;
    }
    heroDrum?.celebrate();
    notify(`Đã lưu ${number.format(saved)} tệp.` + (skipped ? ` Bỏ qua ${number.format(skipped)} tệp đã có trong kho.` : ''));
  } catch (error) {
    errorMessage('upload-error', `${error.message} Đã lưu ${number.format(saved)}/${number.format(files.length)} tệp. Bấm "Gửi lại" để thử tiếp.`);
  } finally {
    const bubbleFocused = document.activeElement === uploadBubble;
    state.uploading = false;
    keepAwake(false);
    controls.forEach(control => { control.disabled = false; });
    close.setAttribute('aria-label', 'Đóng');
    close.removeAttribute('title');
    minimize.textContent = 'Đóng';
    byId('upload-progress').hidden = true;
    for (const file of files) if (!state.queued.includes(file)) queueStatus.delete(file);
    renderQueue();
    if (bubbleFocused && uploadBubble.hidden) byId('open-upload').focus({ preventScroll: true });
    await loadPhotos({ preservePreview: !showUploadedDay });
  }
}

function openMoveDate(ids, day) {
  state.moveIds = ids;
  moveDay.set(day || filterDay.value || today.format(new Date()));
  byId('date-description').textContent = `${number.format(ids.length)} ảnh sẽ chuyển sang ngày mới.`;
  errorMessage('date-error');
  dateDialog.showModal();
}

async function submitMoveDate(event) {
  event.preventDefault();
  const submit = byId('date-submit');
  const date = byId('move-day').value;
  const count = state.moveIds.length;
  submit.disabled = true;
  dateDialog.querySelectorAll('[data-close]').forEach(control => { control.disabled = true; });
  errorMessage('date-error');
  try {
    await api('/api/photos/archive-date', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: state.moveIds, date })
    });
    const preview = previewDialog.open ? state.visible[state.previewIndex] : null;
    dateDialog.close();
    if (filterDay.value) filterDay.value = date;
    await loadPhotos();
    if (preview && previewDialog.open) {
      state.previewIndex = state.visible.findIndex(photo => photo.id === preview.id);
      if (state.previewIndex < 0) previewDialog.close();
      else renderPreview();
    }
    notify(`Đã đổi ngày của ${number.format(count)} ảnh.`);
  } catch (error) {
    errorMessage('date-error', error.message);
  } finally {
    submit.disabled = false;
    dateDialog.querySelectorAll('[data-close]').forEach(control => { control.disabled = false; });
  }
}

const isDriveId = id => id.startsWith('drive-');

function setSelecting(selecting, deleting = false) {
  state.selecting = selecting;
  state.deleting = selecting && deleting;
  if (!selecting) state.selected.clear();
  updateSelection();
}

function requestDelete(ids) {
  if (!ids.length) return;
  if (ids.every(isDriveId)) deletePhotos(ids).catch(error => notify(error.message));
  else openDelete(ids);
}

async function deletePhotos(ids) {
  await api('/api/photos', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  const removed = new Set(ids);
  const preview = previewDialog.open ? state.visible[state.previewIndex] : null;
  const nextPreview = preview && state.visible.slice(state.previewIndex + 1).concat(state.visible.slice(0, state.previewIndex).reverse())
    .find(photo => !removed.has(photo.id));
  const leaving = ids.map(id => state.cards.get(id)?.card).filter(Boolean);
  leaving.forEach(card => card.classList.add('leaving'));
  if (leaving.length && !reducedMotion()) await wait(220);
  if (state.deleting) setSelecting(false);
  else ids.forEach(id => state.selected.delete(id));
  await loadPhotos();
  if (preview && previewDialog.open) {
    const keep = removed.has(preview.id) ? nextPreview : preview;
    state.previewIndex = keep ? state.visible.findIndex(photo => photo.id === keep.id) : -1;
    if (state.previewIndex < 0) previewDialog.close();
    else renderPreview();
  }
  const restorable = ids.filter(isDriveId);
  notify(`Đã xóa ${number.format(ids.length)} mục.`, restorable.length
    ? { action: { label: 'Hoàn tác', run: () => restorePhotos(restorable) }, duration: 10_000 }
    : {});
}

async function restorePhotos(ids) {
  try {
    await api('/api/photos/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    await loadPhotos();
    notify(`Đã khôi phục ${number.format(ids.length)} mục.`);
  } catch (error) {
    notify(error.message);
  }
}

function openDelete(ids) {
  const photos = state.photos.filter(photo => ids.includes(photo.id));
  state.deleteIds = photos.map(photo => photo.id);
  if (!state.deleteIds.length) return;
  const fromDrive = photos.filter(photo => photo.id.startsWith('drive-')).length;
  byId('delete-description').textContent = `${number.format(state.deleteIds.length)} mục sẽ bị xóa.` +
    (fromDrive ? ` ${number.format(fromDrive)} mục trên Google Drive sẽ vào Thùng rác của Drive và khôi phục được trong 30 ngày.` : '');
  errorMessage('delete-error');
  deleteDialog.showModal();
  byId('delete-submit').focus();
}

async function submitDelete(event) {
  event.preventDefault();
  const submit = byId('delete-submit');
  const ids = state.deleteIds;
  submit.disabled = true;
  deleteDialog.querySelectorAll('[data-close]').forEach(control => { control.disabled = true; });
  errorMessage('delete-error');
  try {
    await deletePhotos(ids);
    deleteDialog.close();
  } catch (error) {
    errorMessage('delete-error', error.message);
  } finally {
    submit.disabled = false;
    deleteDialog.querySelectorAll('[data-close]').forEach(control => { control.disabled = false; });
  }
}

function originalUrl(photo) {
  const url = '/api/photos/' + encodeURIComponent(photo.id) + '/original';
  return photo.downloadVersion ? `${url}?v=${photo.downloadVersion}` : url;
}

async function saveToPhotos(photo, control) {
  if (!photo || shareLoading) return;
  const dialog = control.closest('dialog');
  const status = dialog === previewDialog ? 'preview-share-status' : 'download-share-status';
  errorMessage(status);
  const defaultLabel = 'Lưu vào Ảnh';
  if (preparedShare?.photoId === photo.id && preparedShare.control === control) {
    const { file } = preparedShare;
    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (error.name !== 'AbortError') errorMessage(status, 'Không lưu được qua bảng chia sẻ. Hãy bấm Tải về máy.');
    }
    return;
  }
  if (preparedShare) preparedShare.control.textContent = defaultLabel;
  preparedShare = null;
  shareLoading = true;
  control.disabled = true;
  control.textContent = 'Đang chuẩn bị…';
  try {
    const response = await fetch(originalUrl(photo));
    if (!response.ok) throw new Error('Không thể lấy tệp gốc.');
    const file = new File([await response.blob()], photo.originalName, { type: photo.type });
    if (!navigator.canShare({ files: [file] })) throw new Error('Thiết bị không chia sẻ được tệp này. Hãy bấm Tải về máy.');
    const current = state.visible[state.previewIndex];
    if (!dialog?.open || (dialog === previewDialog &&
      (!current || originalUrl(current) !== originalUrl(photo) || current.originalName !== photo.originalName))) {
      control.textContent = defaultLabel;
      return;
    }
    preparedShare = { photoId: photo.id, control, file };
    control.textContent = 'Mở bảng chia sẻ';
    errorMessage(status, 'Bấm Mở bảng chia sẻ, rồi chọn Lưu hình ảnh hoặc Lưu video.');
  } catch (error) {
    control.textContent = defaultLabel;
    errorMessage(status, error.message);
  } finally {
    control.disabled = false;
    shareLoading = false;
  }
}

function downloadSelected() {
  const photos = state.photos.filter(photo => state.selected.has(photo.id) && photo.size != null);
  if (!photos.length) return notify('Các tệp đã chọn chưa có bản gốc để tải.');
  downloadBatch = photos;
  byId('download-batch-actions').hidden = !supportsFolderDownload || photos.length < 2;
  byId('download-batch').textContent = 'Tải tất cả vào thư mục';
  byId('download-batch').disabled = false;
  byId('download-status').textContent = '';
  const list = byId('download-files');
  list.replaceChildren();
  errorMessage('download-share-status');
  for (const photo of photos) {
    const row = element('div', 'queue-row download-row');
    const link = element('a', 'button primary', 'Tải về máy');
    link.href = originalUrl(photo);
    row.append(element('span', '', photo.originalName), link);
    if (supportsFileShare && giaDinhMedia.mediaMime.test(photo.type)) {
      const save = button('Lưu vào Ảnh', 'button secondary');
      save.addEventListener('click', () => saveToPhotos(photo, save));
      row.append(save);
    }
    list.append(row);
  }
  downloadDialog.showModal();
}

async function downloadToFolder() {
  if (batchDownloading || !downloadBatch.length) return;
  const control = byId('download-batch');
  const status = byId('download-status');
  const close = downloadDialog.querySelector('[data-close]');
  batchDownloading = true;
  control.disabled = close.disabled = true;
  try {
    const folder = await window.showDirectoryPicker({ id: 'giadinh-downloads', mode: 'readwrite' });
    const normalizeName = name => name.normalize('NFC').toLowerCase();
    const names = new Set();
    for await (const name of folder.keys()) names.add(normalizeName(name));
    const jobs = downloadBatch.map(photo => {
      const original = photo.originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'tep-goc';
      const portable = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(original) ? '_' + original : original;
      const dot = portable.lastIndexOf('.');
      const stem = dot > 0 ? portable.slice(0, dot) : portable;
      const extension = dot > 0 ? portable.slice(dot) : '';
      let name = portable;
      for (let index = 2; names.has(normalizeName(name)); index++) name = `${stem} (${index})${extension}`;
      names.add(normalizeName(name));
      return { photo, name };
    });
    const total = jobs.length;
    let saved = 0;
    status.textContent = `Đã tải 0/${total} tệp.`;
    await runTransfers(jobs, 4, async job => {
      let body;
      let created = false;
      try {
        const response = await fetch(originalUrl(job.photo));
        body = response.body;
        if (!response.ok || !body) throw new Error('Không thể lấy tệp gốc.');
        const file = await folder.getFileHandle(job.name, { create: true });
        created = true;
        const writable = await file.createWritable();
        await body.pipeTo(writable);
        job.saved = true;
        status.textContent = `Đã tải ${++saved}/${total} tệp.`;
      } catch {
        if (body && !body.locked) await body.cancel().catch(() => {});
        if (created) await folder.removeEntry(job.name).catch(() => {});
      }
    });
    downloadBatch = jobs.filter(job => !job.saved).map(job => job.photo);
    if (downloadBatch.length) {
      status.textContent = `Đã tải ${saved}/${total} tệp. ${downloadBatch.length} tệp có thể thử lại.`;
      control.textContent = 'Thử lại tệp lỗi';
    }
  } catch (error) {
    if (error.name !== 'AbortError') status.textContent = 'Không thể mở thư mục để lưu. Bạn vẫn có thể tải từng tệp.';
  } finally {
    batchDownloading = false;
    control.disabled = !downloadBatch.length;
    close.disabled = false;
  }
}

search.addEventListener('input', renderGallery);
filterDay.addEventListener('change', renderGallery);
sort.addEventListener('change', renderGallery);
byId('clear-filters').addEventListener('click', resetFilters);
byId('selection-toggle').addEventListener('click', () => setSelecting(!state.selecting));
byId('delete-mode').addEventListener('click', () => setSelecting(!state.deleting, true));
byId('select-visible').addEventListener('click', () => toggleSelection(state.visible.map(photo => photo.id)));
byId('clear-selection').addEventListener('click', () => {
  state.selected.clear();
  updateSelection();
});
byId('change-selected-date').addEventListener('click', () => openMoveDate([...state.selected]));
byId('delete-selected').addEventListener('click', () => requestDelete([...state.selected]));
byId('download-selected').addEventListener('click', downloadSelected);
byId('download-batch').addEventListener('click', downloadToFolder);
downloadDialog.addEventListener('cancel', event => { if (batchDownloading) event.preventDefault(); });
byId('save-to-photos').addEventListener('click', event => {
  saveToPhotos(state.visible[state.previewIndex], event.currentTarget);
});
downloadDialog.addEventListener('close', () => { preparedShare = null; });
previewDialog.addEventListener('close', () => {
  preparedShare = null;
  byId('preview-media').replaceChildren();
});

document.querySelectorAll('[data-close]').forEach(control => control.addEventListener('click', () => control.closest('dialog').close()));
byId('open-upload').addEventListener('click', openUpload);
uploadBubble.addEventListener('click', openUpload);
byId('upload-close').addEventListener('click', closeUpload);
byId('upload-minimize').addEventListener('click', closeUpload);
byId('upload-form').addEventListener('submit', submitUpload);
uploadDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeUpload();
});
// Picking files starts the upload right away: one step fewer.
function addAndSend(files) {
  addFiles(files);
  if (state.queued.length && !state.uploading) submitUpload();
}
byId('file-input').addEventListener('change', event => {
  addAndSend(event.target.files);
  event.target.value = '';
});
window.addEventListener('beforeunload', event => {
  if (!state.uploading) return;
  event.preventDefault();
  event.returnValue = '';
});
document.addEventListener('visibilitychange', () => {
  if (state.uploading && document.visibilityState === 'visible') keepAwake(true);
});
const dropZone = byId('drop-zone');
dropZone.addEventListener('dragover', event => {
  event.preventDefault();
  if (!state.uploading) dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  if (!state.uploading) addAndSend(event.dataTransfer.files);
});

byId('preview-prev').addEventListener('click', () => movePreview(-1));
// Swipe left or right on the photo to move between photos.
let swipeStart = null;
const previewStage = document.querySelector('.preview-stage');
previewStage.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' || event.target.closest('video')) return;
  swipeStart = { x: event.clientX, y: event.clientY };
});
previewStage.addEventListener('pointerup', event => {
  if (!swipeStart) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) movePreview(dx < 0 ? 1 : -1);
});
previewStage.addEventListener('pointercancel', () => { swipeStart = null; });
byId('preview-next').addEventListener('click', () => movePreview(1));
previewDialog.addEventListener('keydown', event => {
  if (dateDialog.open || deleteDialog.open || renameDialog.open || event.target.tagName === 'VIDEO' || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  movePreview(event.key === 'ArrowLeft' ? -1 : 1);
});
byId('change-preview-date').addEventListener('click', () => {
  const photo = state.visible[state.previewIndex];
  if (photo) openMoveDate([photo.id], photo.day);
});
byId('date-form').addEventListener('submit', submitMoveDate);
byId('rename-preview').addEventListener('click', openRename);
byId('rename-form').addEventListener('submit', submitRename);
renameDialog.addEventListener('cancel', event => { if (byId('rename-submit').disabled) event.preventDefault(); });
byId('delete-preview').addEventListener('click', () => {
  const photo = state.visible[state.previewIndex];
  if (photo) requestDelete([photo.id]);
});
byId('delete-form').addEventListener('submit', submitDelete);
deleteDialog.addEventListener('cancel', event => { if (byId('delete-submit').disabled) event.preventDefault(); });
dateDialog.addEventListener('cancel', event => { if (byId('date-submit').disabled) event.preventDefault(); });

const uploadDay = setupDayPicker(document.querySelector('[data-day-input="upload-day"]'));
const moveDay = setupDayPicker(document.querySelector('[data-day-input="move-day"]'));

const textSize = byId('text-size');
function applyTextSize(large) {
  document.documentElement.classList.toggle('large-text', large);
  textSize.setAttribute('aria-pressed', String(large));
  textSize.textContent = large ? 'A−' : 'A+';
  textSize.setAttribute('aria-label', large ? 'Chữ nhỏ lại' : 'Chữ to hơn');
}
try { applyTextSize(localStorage.getItem('giadinh-text') === 'large'); } catch { applyTextSize(false); }
textSize.addEventListener('click', () => {
  const large = !document.documentElement.classList.contains('large-text');
  applyTextSize(large);
  try { localStorage.setItem('giadinh-text', large ? 'large' : 'normal'); } catch { /* the choice just is not remembered */ }
});

const unfinishedUploads = Object.keys(storedSessions()).length;
if (unfinishedUploads) {
  notify(`Có ${number.format(unfinishedUploads)} tệp gửi dở. Bấm "Tải ảnh và video lên" và chọn lại đúng tệp để gửi tiếp.`, { duration: 12_000 });
}

// Small clock in the top-right corner: Vietnam time, the day and the lunar date older relatives go by.
const clockTime = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
const clockShortDay = new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
const clockDay = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
let lunarDay = null;
try {
  // The Chinese calendar matches the Vietnamese lunar calendar on almost every day; they can differ by a day
  // around a new moon close to midnight, because Vietnam reckons in UTC+7 and China in UTC+8.
  lunarDay = new Intl.DateTimeFormat('vi-VN-u-ca-chinese', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
  if (lunarDay.resolvedOptions().calendar !== 'chinese') lunarDay = null;
} catch {
  lunarDay = null;
}
function tickClock() {
  const now = new Date();
  byId('clock-time').textContent = clockTime.format(now);
  byId('clock-time').dateTime = now.toISOString();
  let lunar = '';
  if (lunarDay) {
    const parts = lunarDay.formatToParts(now);
    const part = type => parts.find(entry => entry.type === type)?.value;
    lunar = `${part('day')}/${part('month').replace(' Nhuận', ' nhuận')}`;
  }
  byId('clock-date').textContent = clockShortDay.format(now) + (lunar ? ` · ÂL ${lunar}` : '');
  // The visible text is compact; the full day in words is what screen readers and a long press read.
  const full = clockDay.format(now) + (lunar ? `, âm lịch ngày ${lunar.replace('/', ' tháng ')}` : '');
  byId('clock').title = full;
  byId('clock').setAttribute('aria-label', `${clockTime.format(now)}, ${full}`);
}
tickClock();
// Minutes only, so tick on each minute boundary.
setTimeout(() => {
  tickClock();
  setInterval(tickClock, 60_000);
}, 60_000 - (Date.now() % 60_000));

let heroDrum = null;
function mountHeroDrum() {
  const container = byId('hero-drum');
  if (!container) return;
  import('/js/drum3d.js')
    .then(({ mountDrum }) => { heroDrum = mountDrum(container, { reducedMotion: reducedMotion() }); })
    .catch(() => { /* no WebGL or an old browser: the static bronze icon stays */ });
}
if ('requestIdleCallback' in window) requestIdleCallback(mountHeroDrum, { timeout: 2500 });
else setTimeout(mountHeroDrum, 600);

if (location.hash) history.replaceState(null, '', location.pathname + location.search);
recordVisit();
loadPhotos();
setInterval(() => {
  if (!document.hidden && !document.querySelector('dialog[open]')) loadPhotos();
}, 5 * 60_000);
