import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'library' });
const canWrite = shell.user.can_write;
// 系统挑素材时给主题的默认写法，人可以改。
const DEFAULT_TOPIC = { hotel: '宜尚酒店实拍', property: '恒兆广场写字楼商铺招租', dining: '恒兆广场餐厅推荐', event: '恒兆广场活动' };
const state = { type: 'hotel', selected: new Set(), items: [], options: null, auto: false };

const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}) });
const size = bytes => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function showError(text) {
  byId('error-text').textContent = text;
  byId('error').hidden = false;
}

function tile(item) {
  const chosen = state.selected.has(item.id);
  const media = item.kind === 'video'
    ? `<video src="${escapeHtml(item.url)}#t=0.5" preload="metadata" muted playsinline></video><span class="tag kind">视频</span>`
    : `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.note || item.original_name || '')}" loading="lazy">`;
  return `<figure class="tile${chosen ? ' on' : ''}" data-file="${item.id}">
    ${canWrite && !item.archived ? `<label class="pick"><input type="checkbox" data-pick${chosen ? ' checked' : ''} aria-label="选中这个文件"></label>` : ''}
    <a class="tile-media" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${media}</a>
    <figcaption>
      <span class="meta">${item.use_count ? `用过 ${item.use_count} 次` : '还没用过'} · ${size(item.size_bytes)}${item.property_label ? ` · ${escapeHtml(item.property_label)}` : ''}</span>
      ${canWrite ? `<input class="tile-note" data-note value="${escapeHtml(item.note || '')}" maxlength="500" placeholder="画面里是什么（可不填）" aria-label="画面说明">
      <button class="btn sm" type="button" data-archive>${item.archived ? '恢复使用' : '停用'}</button>` : `<span class="meta">${escapeHtml(item.note || '')}</span>`}
    </figcaption>
  </figure>`;
}

function renderSelection() {
  byId('select-bar').hidden = !state.selected.size;
  byId('selected-count').textContent = `已选 ${state.selected.size} 个`;
}

async function load() {
  byId('error').hidden = true;
  try {
    const query = new URLSearchParams({ type: state.type });
    if (byId('only-video').checked) query.set('kind', 'video');
    if (byId('show-archived').checked) query.set('archived', '1');
    const data = await api(`/api/publishing/library?${query}`);
    state.items = data.items;
    byId('tabs').innerHTML = data.counts.map(type => `<button type="button" role="tab" data-type="${type.key}" aria-selected="${type.key === state.type}">${escapeHtml(type.label)}<span> ${type.images + type.videos}</span></button>`).join('');
    const current = data.counts.find(type => type.key === state.type);
    byId('sub').textContent = `${current.label}：图片 ${current.images} 张，视频 ${current.videos} 个。发内容时直接挑，或者让系统挑`;
    byId('list').innerHTML = data.items.length ? data.items.map(tile).join('')
      : `<div class="state"><b>${byId('show-archived').checked ? '没有停用的文件' : `${current.label}还没有素材`}</b>${canWrite && !byId('show-archived').checked ? '点右上角“往库里传”，可以一次传多个' : ''}</div>`;
    renderSelection();
  } catch (error) {
    showError(`素材库没有加载出来：${error.message}`);
    byId('list').innerHTML = '<div class="state">没有加载出来</div>';
  }
}

async function loadOptions() {
  if (state.options) return state.options;
  state.options = await api('/api/publishing/options');
  const types = state.options.content_types.map(type => `<option value="${type.key}">${escapeHtml(type.label)}</option>`).join('');
  const properties = `<option value="">不关联</option>${state.options.properties.map(property => `<option value="${property.id}">${escapeHtml(`${property.building} ${property.unit_no}（${property.floor} 层，${property.area_sqm} ㎡）`)}</option>`).join('')}`;
  for (const id of ['u-type', 'c-type']) byId(id).innerHTML = types;
  for (const id of ['u-property', 'c-property']) byId(id).innerHTML = properties;
  byId('c-platforms').innerHTML = state.options.platforms.map(platform => `<label class="check"><input type="checkbox" name="target_platforms" value="${platform.key}"${platform.key === 'moments' ? '' : ' checked'}>${escapeHtml(platform.label)}</label>`).join('');
  return state.options;
}

function syncProperty(form) {
  const type = form.querySelector('[name="content_type"]').value;
  form.querySelector('[data-property]').hidden = type !== 'property';
}

async function openCompose(auto) {
  await loadOptions();
  state.auto = auto;
  const form = byId('compose-form');
  form.reset();
  byId('c-type').value = state.type;
  byId('c-topic').value = auto ? DEFAULT_TOPIC[state.type] || '' : '';
  syncProperty(form);
  const videos = state.items.filter(item => state.selected.has(item.id) && item.kind === 'video').length;
  byId('compose-title').textContent = auto ? '让系统挑一组素材' : `用选中的 ${state.selected.size} 个文件发一条`;
  byId('compose-sub').textContent = auto
    ? '系统先挑这一类里最久没用过的视频；没有视频就挑最多 6 张图片。挑好后生成各平台的文案草稿，你确认后才发'
    : videos ? '有视频的会发成视频；视频号只能发视频' : '只有图片：会发成图文。视频号只能发视频，已帮你去掉';
  if (!auto && !videos) form.querySelector('[value="channels"]').checked = false;
  byId('compose-error').textContent = '';
  byId('upload').hidden = true;
  byId('compose').hidden = false;
  byId('c-topic').focus();
}

byId('tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-type]');
  if (!tab) return;
  state.type = tab.dataset.type;
  state.selected.clear();
  notice('');
  load();
});
for (const id of ['only-video', 'show-archived']) byId(id).addEventListener('change', () => { state.selected.clear(); load(); });

byId('list').addEventListener('change', async event => {
  const file = event.target.closest('[data-file]');
  if (!file) return;
  if (event.target.matches('[data-pick]')) {
    if (event.target.checked) state.selected.add(file.dataset.file); else state.selected.delete(file.dataset.file);
    file.classList.toggle('on', event.target.checked);
    renderSelection();
  } else if (event.target.matches('[data-note]')) {
    try { await send(`/api/publishing/library/${file.dataset.file}`, 'PATCH', { note: event.target.value }); notice('说明已保存。'); }
    catch (error) { showError(error.message); }
  }
});

byId('list').addEventListener('click', async event => {
  const button = event.target.closest('[data-archive]');
  if (!button) return;
  const file = button.closest('[data-file]');
  const item = state.items.find(entry => entry.id === file.dataset.file);
  button.disabled = true;
  try {
    await send(`/api/publishing/library/${item.id}`, 'PATCH', { archived: !item.archived });
    state.selected.delete(item.id);
    notice(item.archived ? '已恢复，系统挑素材时会再用到它。' : '已停用：不会再被挑中，已经发出去的内容不受影响。');
    await load();
  } catch (error) { showError(error.message); button.disabled = false; }
});

byId('clear-selection').addEventListener('click', () => { state.selected.clear(); load(); });
byId('use-selected').addEventListener('click', () => openCompose(false));
byId('open-auto').addEventListener('click', () => openCompose(true));
byId('open-upload').addEventListener('click', async () => {
  await loadOptions();
  byId('u-type').value = state.type;
  syncProperty(byId('upload-form'));
  byId('upload-error').textContent = '';
  byId('compose').hidden = true;
  byId('upload').hidden = false;
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { byId(button.dataset.close).hidden = true; }));
for (const id of ['upload-form', 'compose-form']) byId(id).querySelector('[name="content_type"]').addEventListener('change', event => syncProperty(event.target.form));

byId('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('upload-submit');
  button.disabled = true;
  button.textContent = '正在上传…';
  try {
    const result = await api('/api/publishing/library', { method: 'POST', body: new FormData(event.target) });
    byId('upload').hidden = true;
    state.type = byId('u-type').value;
    notice(`收进 ${result.added} 个${result.skipped.length ? `；没收的：${result.skipped.join('、')}` : ''}。`);
    await load();
  } catch (error) {
    byId('upload-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '上传';
  }
});

byId('compose-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const platforms = [...form.querySelectorAll('[name="target_platforms"]:checked')].map(box => box.value);
  if (!platforms.length) { byId('compose-error').textContent = '至少选一个平台'; return; }
  const button = byId('compose-submit');
  button.disabled = true;
  button.textContent = '正在生成草稿…';
  try {
    const result = await send('/api/publishing/library/materials', 'POST', {
      topic: byId('c-topic').value, content_type: byId('c-type').value, property_id: byId('c-property').value || null,
      note: byId('c-note').value, target_platforms: platforms, file_ids: state.auto ? [] : [...state.selected]
    });
    location.href = `/publishing.html?id=${encodeURIComponent(result.id)}`;
  } catch (error) {
    byId('compose-error').textContent = error.message;
    button.disabled = false;
    button.textContent = '生成草稿';
  }
});

byId('retry').addEventListener('click', load);
await load();
