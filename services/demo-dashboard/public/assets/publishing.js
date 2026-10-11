import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const materialId = new URLSearchParams(location.search).get('id');
const shell = await initShell({ page: 'publishing' });
const canWrite = shell.user.can_write;
const STATUS_CLASS = { draft: 'st-warn', confirmed: 'st-wait', publishing: 'st-wait', published: 'st-ok', failed: 'st-bad', withdrawn: 'st-wait', removed: 'st-wait' };

const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const toLocalInput = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}) });
const options = (items, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${items.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('')}`;

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
  if (text) byId('notice').scrollIntoView({ block: 'nearest' });
}
function showError(text) {
  byId('error-text').textContent = text;
  byId('error').hidden = false;
}

const config = await api('/api/publishing/options');

// ---------- 素材列表 ----------

function taskTags(tasks) {
  return tasks.map(task => `<span class="status ${task.has_body === false ? 'st-wait' : STATUS_CLASS[task.status]}">${task.platform_name} ${task.status_name}</span>`).join(' ');
}

async function loadList() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/publishing/materials${byId('mine').checked ? '?mine=1' : ''}`);
    byId('list').innerHTML = data.items.length ? `<table class="cands">
      <thead><tr><th scope="col">素材</th><th scope="col">类型</th><th scope="col">各平台进度</th><th scope="col">上传</th></tr></thead>
      <tbody>${data.items.map(item => `<tr>
        <td><a class="rowlink media-row" href="/publishing.html?id=${item.id}">${item.cover_url ? `<img src="${escapeHtml(item.cover_url)}" alt="" loading="lazy">` : '<span class="no-cover">视频</span>'}<span><span class="co">${escapeHtml(item.topic)}</span><span class="meta">图片 ${item.image_count} 张${item.video_count ? `，视频 ${item.video_count} 个` : ''}</span></span></a></td>
        <td>${escapeHtml(item.content_type_name)}</td>
        <td class="tags">${taskTags(item.tasks)}</td>
        <td class="num">${escapeHtml(item.created_by_name || '')}<div class="meta">${dateTime(item.created_at)}</div></td>
      </tr>`).join('')}</tbody></table>`
      : `<div class="state"><b>还没有素材</b>${canWrite ? '点右上角“上传素材”开始' : '同事上传后会出现在这里'}</div>`;
  } catch (error) {
    showError(`素材列表没有加载出来：${error.message}`);
  }
}

// ---------- 排期日历 ----------

const pad = value => String(value).padStart(2, '0');
const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

async function loadCalendar() {
  const month = `${calendarMonth.getFullYear()}-${pad(calendarMonth.getMonth() + 1)}`;
  byId('cal-title').textContent = `${calendarMonth.getFullYear()} 年 ${calendarMonth.getMonth() + 1} 月`;
  try {
    const { items } = await api(`/api/publishing/calendar?month=${month}`);
    // 周一开头，补齐前后两头，整周整周地显示。
    const first = new Date(calendarMonth);
    first.setDate(1 - ((first.getDay() + 6) % 7));
    const today = dayKey(new Date());
    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + index);
      if (index >= 35 && date.getMonth() !== calendarMonth.getMonth()) break;
      const key = dayKey(date);
      const tasks = items.filter(item => dayKey(new Date(item.at)) === key);
      cells.push(`<div class="cal-day${date.getMonth() === calendarMonth.getMonth() ? '' : ' other'}${key === today ? ' today' : ''}">
        <span class="cal-date">${date.getDate()}</span>
        ${tasks.map(task => `<a class="cal-task ${STATUS_CLASS[task.status]}" href="/publishing.html?id=${task.material_id}" title="${escapeHtml(task.topic)} · ${escapeHtml(task.status_name)}">
          <b>${new Date(task.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} ${escapeHtml(task.platform_name)}</b><span>${escapeHtml(task.topic)}</span></a>`).join('')}
      </div>`);
    }
    byId('calendar').innerHTML = `<div class="cal-grid"><div class="cal-head">${['一', '二', '三', '四', '五', '六', '日'].map(day => `<span>周${day}</span>`).join('')}</div>${cells.join('')}</div>
      <p class="foot-note cal-legend"><span class="status st-wait">待发布</span> <span class="status st-ok">已发布</span> <span class="status st-bad">发布失败</span>　只显示已经确认过的内容；点一条可以进去改时间或撤回。${items.length ? '' : '这个月还没有排期。'}</p>`;
  } catch (error) {
    byId('calendar').innerHTML = `<div class="state"><b>日历没有加载出来</b>${escapeHtml(error.message)}</div>`;
  }
}

function showView(view) {
  document.querySelectorAll('[data-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === view)));
  byId('list').hidden = view !== 'list';
  byId('mine-toggle').hidden = view !== 'list';
  byId('calendar').hidden = view !== 'calendar';
  byId('cal-nav').hidden = view !== 'calendar';
  if (view === 'calendar') loadCalendar();
  history.replaceState(null, '', view === 'calendar' ? '#calendar' : location.pathname);
}

function setupUpload() {
  byId('content-type').innerHTML = options(config.content_types.map(type => [type.key, type.label]));
  byId('property').innerHTML = options(config.properties.map(unit => [unit.id, `${unit.building} ${unit.unit_no}（${unit.floor} 层，${unit.area_sqm} ㎡）`]), '不关联');
  byId('platform-boxes').innerHTML = config.platforms.map(platform => `<label class="check"><input type="checkbox" name="target_platforms" value="${platform.key}" checked>${platform.label}</label>`).join('');
  const syncProperty = () => { byId('property-field').hidden = byId('content-type').value !== 'property'; };
  byId('content-type').addEventListener('change', syncProperty);
  syncProperty();
  byId('open-upload')?.addEventListener('click', () => { byId('upload').hidden = false; byId('topic').focus(); });
  byId('cancel-upload').addEventListener('click', () => { byId('upload').hidden = true; });
  byId('upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    byId('upload-error').textContent = '';
    if (!form.querySelector('[name="target_platforms"]:checked')) { byId('upload-error').textContent = '至少选一个目标平台'; return; }
    const button = byId('upload-submit');
    button.disabled = true;
    button.textContent = '正在上传';
    try {
      const response = await fetch('/api/publishing/materials', { method: 'POST', body: new FormData(form) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) { location.replace('/login.html'); return; }
      if (!response.ok) throw new Error(body.error || '上传没有成功');
      if (body.duplicates.length) sessionStorage.setItem('hz.upload-note', `提示：${body.duplicates.join('；')}`);
      location.href = `/publishing.html?id=${body.id}`;
    } catch (error) {
      byId('upload-error').textContent = error.message;
      button.disabled = false;
      button.textContent = '提交';
    }
  });
}

// ---------- 素材详情和各平台草稿 ----------

function taskCard(task) {
  const editable = ['draft', 'failed', 'withdrawn'].includes(task.status) && canWrite;
  const lock = editable ? '' : ' disabled';
  const { limits } = task;
  const soon = toLocalInput(new Date(Date.now() + 30 * 60000));
  return `<section class="card" data-task="${task.id}" data-platform="${task.platform}">
    <div class="ph"><div><h3>${escapeHtml(task.platform_name)}</h3><p>${escapeHtml(limits.style)}</p></div>
      <span class="status ${task.has_body ? STATUS_CLASS[task.status] : 'st-wait'}">${escapeHtml(task.status_name)}</span></div>
    <div class="pb">
      ${task.status === 'confirmed' ? `<div class="notice">将在 ${dateTime(task.scheduled_at)} 用“${escapeHtml(task.account_name || '')}”发布，${escapeHtml(task.confirmed_by_name || '')}确认</div>` : ''}
      ${task.status === 'published' ? `<div class="notice">已于 ${dateTime(task.published_at)} 发布${task.post_url ? `，<a class="lk" href="${escapeHtml(task.post_url)}" target="_blank" rel="noopener noreferrer">查看帖子</a>` : ''}</div>
        ${task.metrics_at && task.stat_views != null ? `<div class="facts metrics"><div><span>浏览</span><b>${task.stat_views}</b></div><div><span>点赞</span><b>${task.stat_likes}</b></div><div><span>评论</span><b>${task.stat_comments ?? 0}</b></div><div><span>收藏</span><b>${task.stat_favorites}</b></div><div><span>转发</span><b>${task.stat_shares}</b></div></div><div class="meta">数据更新于 ${dateTime(task.metrics_at)}，每 6 小时更新一次</div>` : ''}` : ''}
      ${task.status === 'failed' ? `<div class="warn-box" role="alert">发布失败：${escapeHtml(task.error_message || '原因未知')}。处理后重新确认即可，系统不会自动重发。${task.error_screenshot_url ? ` <a class="lk" href="${escapeHtml(task.error_screenshot_url)}" target="_blank" rel="noopener">看失败时的截图</a>` : ''}</div>` : ''}
      ${task.problems.length ? `<div class="warn-box">${task.problems.map(escapeHtml).join('；')}</div>` : ''}
      <form class="draft-form">
        ${limits.titleMax ? `<div class="field"><label>标题 <small data-count="title"></small></label><input name="title" value="${escapeHtml(task.title || '')}" data-max="${limits.titleMax}"${lock}></div>` : ''}
        <div class="field"><label>正文 <small data-count="body"></small></label><textarea name="body" rows="${limits.bodyMax > 300 ? 12 : 5}" data-max="${limits.bodyMax}"${lock}>${escapeHtml(task.body || '')}</textarea></div>
        ${limits.topics[1] ? `<div class="field"><label>话题（空格分开，不用写 #）</label><input name="topics" value="${escapeHtml(task.topics.join(' '))}"${lock}></div>` : ''}
        ${editable ? `<div class="form-actions"><span class="form-error" role="alert"></span>
          <button class="btn" type="button" data-regenerate>${task.has_body ? '重新生成' : '生成文案'}</button>
          <button class="btn" type="submit">保存修改</button></div>` : ''}
      </form>
      ${editable && task.has_body ? `<form class="confirm-form">
        <h4 class="sub-title">确认发布</h4>
        <div class="confirm-row"><label class="check"><input type="radio" name="when" value="at" checked>定时</label>
          <input type="datetime-local" name="scheduled_at" value="${soon}" aria-label="发布时间">
          <label class="check"><input type="radio" name="when" value="now">立即发布</label>
          <button class="btn pri" type="submit">确认</button></div>
      </form>` : ''}
      ${task.status === 'confirmed' && canWrite ? '<div class="form-actions"><button class="btn" type="button" data-withdraw>撤回</button></div>' : ''}
      ${task.status === 'removed' ? `<div class="notice">这条已于 ${dateTime(task.removed_at)} 标记为“已在平台删除”${task.removed_note ? `：${escapeHtml(task.removed_note)}` : ''}</div>` : ''}
      ${task.status === 'published' && canWrite ? '<div class="form-actions"><button class="btn" type="button" data-removed>已在平台上删除</button></div>' : ''}
      ${task.version_count > 1 ? `<details class="why versions"><summary>历史版本（${task.version_count}）</summary><div data-versions></div></details>` : ''}
    </div></section>`;
}

function updateCounts(root = document) {
  root.querySelectorAll('[data-max]').forEach(input => {
    const counter = input.closest('.field').querySelector('[data-count]');
    const over = input.value.length > Number(input.dataset.max);
    counter.textContent = `${input.value.length} / ${input.dataset.max} 字`;
    counter.className = over ? 'down' : '';
  });
}

async function loadDetail() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/publishing/materials/${encodeURIComponent(materialId)}`);
    document.title = `${data.topic} · 内容发布`;
    byId('title').textContent = data.topic;
    byId('sub').textContent = `${data.content_type_name} · ${data.created_by_name || ''} ${dateTime(data.created_at)} 上传`;
    byId('thumbs').innerHTML = data.files.map(file => (file.kind === 'image'
      ? `<a href="${escapeHtml(file.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(file.url)}" alt="${escapeHtml(file.original_name)}" loading="lazy"></a>`
      : `<video src="${escapeHtml(file.url)}" controls preload="metadata"></video>`)).join('');
    const fact = (label, value) => (value ? `<div><span>${label}</span><b>${escapeHtml(value)}</b></div>` : '');
    byId('facts').innerHTML = fact('关联房源', data.property && `${data.property.label}（${data.property.floor} 层，${data.property.area_sqm} ㎡）`) + fact('补充说明', data.note);
    byId('tasks').innerHTML = data.tasks.map(taskCard).join('');
    byId('model-note').textContent = config.model_ready ? '文案只使用主题、补充说明和房源资料里的内容，发布前请逐条核对。' : '还没有配置大模型，暂时只能手写文案。';
    const generateAll = byId('generate-all');
    if (generateAll) generateAll.hidden = !config.model_ready || !data.tasks.some(task => ['draft', 'failed', 'withdrawn'].includes(task.status));
    updateCounts();
  } catch (error) {
    showError(`素材没有加载出来：${error.message}`);
  }
}

async function generate(button, platform) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '正在生成，约半分钟';
  notice('');
  try {
    const { results } = await send(`/api/publishing/materials/${materialId}/drafts`, 'POST', { platform });
    await loadDetail();
    const refused = results.filter(result => !result.saved);
    const removed = results.flatMap(result => result.removed || []);
    notice(refused.length ? `有 ${refused.length} 个平台的文案没有保存：${refused.map(result => result.problems.join('；')).join('；')}。请手写或重新生成。`
      : `文案已生成，请逐条核对事实后再确认。${removed.length ? `校对时去掉了 ${removed.length} 处资料里没有依据的说法（如“${removed[0].slice(0, 20)}”）。` : ''}`);
  } catch (error) {
    notice(error.message);
    button.disabled = false;
    button.textContent = label;
  }
}

function setupDetail() {
  byId('generate-all')?.addEventListener('click', event => generate(event.target, null));
  byId('tasks').addEventListener('input', event => { if (event.target.dataset.max) updateCounts(event.target.closest('.field')); });
  byId('tasks').addEventListener('click', async event => {
    const card = event.target.closest('[data-task]');
    if (!card) return;
    if (event.target.closest('[data-regenerate]')) { generate(event.target, card.dataset.platform); return; }
    if (event.target.closest('[data-removed]')) {
      const note = prompt('这条帖子已经在平台上删掉了吗？可以写一句原因（可不填）。系统只做记录，不会去平台上删。');
      if (note === null) return;
      try { await send(`/api/publishing/tasks/${card.dataset.task}/removed`, 'POST', { note }); await loadDetail(); notice('已记录：这条已在平台删除。'); }
      catch (error) { notice(error.message); }
      return;
    }
    if (event.target.closest('[data-withdraw]')) {
      try { await send(`/api/publishing/tasks/${card.dataset.task}/withdraw`, 'POST'); await loadDetail(); notice('已撤回，不会发布。'); }
      catch (error) { notice(error.message); }
    }
  });
  byId('tasks').addEventListener('toggle', async event => {
    const details = event.target;
    if (!details.matches?.('.versions') || !details.open) return;
    const box = details.querySelector('[data-versions]');
    const { items } = await api(`/api/publishing/tasks/${details.closest('[data-task]').dataset.task}/versions`);
    box.innerHTML = `<ul class="timeline">${items.map(version => `<li><div class="when"><span>${dateTime(version.created_at)}</span><span>${version.source === 'model' ? '生成' : `${escapeHtml(version.created_by_name || '')}修改`}</span></div>
      <p>${version.title ? `${escapeHtml(version.title)}\n` : ''}${escapeHtml(version.body)}${version.topics.length ? `\n${version.topics.map(topic => `#${escapeHtml(topic)}`).join(' ')}` : ''}</p></li>`).join('')}</ul>`;
  }, true);
  byId('tasks').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const card = form.closest('[data-task]');
    const data = new FormData(form);
    try {
      if (form.classList.contains('draft-form')) {
        const { problems } = await send(`/api/publishing/tasks/${card.dataset.task}`, 'PUT', { title: data.get('title'), body: data.get('body'), topics: data.get('topics') || '' });
        await loadDetail();
        notice(problems.length ? `已保存，但还不能确认：${problems.join('；')}` : '已保存。');
      } else {
        const now = data.get('when') === 'now';
        const result = await send(`/api/publishing/tasks/${card.dataset.task}/confirm`, 'POST', { scheduled_at: now ? null : new Date(data.get('scheduled_at')).toISOString() });
        await loadDetail();
        notice(`已确认，${now && !result.moved ? '马上' : `${dateTime(result.scheduled_at)} `}用“${result.account_name}”发布。${result.moved ? '同一账号两次发布要隔 10 分钟，时间已自动顺延。' : ''}`);
      }
    } catch (error) {
      const line = form.querySelector('.form-error');
      if (line) line.textContent = error.message; else notice(error.message);
    }
  });
}

byId('retry').addEventListener('click', () => (materialId ? loadDetail() : loadList()));

if (materialId) {
  byId('list-view').hidden = true;
  byId('detail-view').hidden = false;
  byId('back').hidden = false;
  byId('open-upload')?.remove();
  setupDetail();
  await loadDetail();
  const pending = sessionStorage.getItem('hz.upload-note');
  if (pending) { sessionStorage.removeItem('hz.upload-note'); notice(pending); }
} else {
  setupUpload();
  byId('mine').addEventListener('change', loadList);
  byId('view-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (tab) showView(tab.dataset.view);
  });
  byId('cal-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-month]');
    if (!button) return;
    const step = Number(button.dataset.month);
    calendarMonth = step ? new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + step, 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    loadCalendar();
  });
  await loadList();
  if (location.hash === '#calendar') showView('calendar');
}
