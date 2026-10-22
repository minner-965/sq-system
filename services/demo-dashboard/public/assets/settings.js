import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'settings' });
const ASSIGNEES = ['assignee_property', 'assignee_event', 'assignee_hotel', 'assignee_dining'];
const MAX_KEYWORDS = 300;
let keywords = [];
let autoAvailable = false;

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function renderKeywords() {
  byId('keywords').innerHTML = keywords.length
    ? keywords.map((word, index) => `<span class="tag">${escapeHtml(word)} <button class="tag-x" type="button" data-remove="${index}" aria-label="删除“${escapeHtml(word)}”">×</button></span>`).join(' ')
    : '<span class="meta">还没有关键词</span>';
}

function addKeyword() {
  const input = byId('s-new');
  const word = input.value.trim();
  byId('form-error').textContent = '';
  if (!word) return;
  if (keywords.includes(word)) byId('form-error').textContent = `“${word}”已经有了`;
  else if (keywords.length >= MAX_KEYWORDS) byId('form-error').textContent = `最多 ${MAX_KEYWORDS} 个词`;
  else { keywords.push(word); renderKeywords(); }
  input.value = '';
}

function fill(settings) {
  keywords = [...settings.intent_keywords];
  renderKeywords();
  const options = '<option value="">不指定（系统负责人处理）</option>' + settings.users.map(user => `<option value="${user.id}">${escapeHtml(user.display_name)}</option>`).join('');
  autoAvailable = settings.dm_auto_reply_available;
  byId('auto-off').hidden = autoAvailable;
  byId('auto-on').hidden = !autoAvailable;
  byId('s-auto').checked = settings.dm_auto_reply_enabled;
  byId('s-auto-text').value = settings.dm_auto_reply_text;
  byId('s-auto-limit').value = settings.dm_auto_reply_daily_limit;
  for (const name of ASSIGNEES) {
    const select = byId('form').elements[name];
    select.innerHTML = options;
    select.value = settings[name] || '';
  }
}

async function load() {
  byId('error').hidden = true;
  if (shell.user.role !== 'ADMIN') {
    byId('body').innerHTML = '<div class="card"><div class="state"><b>这一页只有系统负责人能改</b>需要调整人员、分配或关键词时请找系统负责人</div></div>';
    return;
  }
  try {
    fill(await api('/api/inbox/settings'));
    byId('body').hidden = true;
    byId('form').hidden = false;
  } catch (error) {
    byId('error-text').textContent = error.message;
    byId('error').hidden = false;
    byId('body').innerHTML = '';
  }
}

// ---- 人员和权限（只有系统负责人看得到） ----
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
let people = { items: [], roles: [], sectors: [] };
let editing = null;

function lastLogin(value) {
  if (!value) return '还没登录过';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sectorText(user) {
  if (user.all_sectors) return '全部板块';
  const names = people.sectors.filter(sector => user.sectors.includes(sector.key)).map(sector => escapeHtml(sector.name));
  return names.length ? names.join('、') : '<span class="status st-warn">未分配板块</span>';
}

function renderPeople() {
  const rows = people.items.map(user => `
    <tr${user.is_active ? '' : ' class="off-row"'}>
      <td data-label="姓名"><div class="co">${escapeHtml(user.display_name)}${user.is_self ? ' <span class="meta">（我）</span>' : ''}</div><div class="meta">登录名 ${escapeHtml(user.username)}</div></td>
      <td data-label="角色">${escapeHtml(user.role_name)}${user.can_write ? '' : ' <span class="status st-wait">只读</span>'}</td>
      <td data-label="负责板块">${sectorText(user)}</td>
      <td data-label="最近登录">${lastLogin(user.last_login_at)}${user.locked ? ' <span class="status st-bad">密码输错已锁定</span>' : ''}${user.is_active ? '' : ' <span class="status st-wait">已停用</span>'}</td>
      <td class="acts"><button class="btn sm" type="button" data-edit="${user.id}">修改</button><button class="btn sm" type="button" data-reset="${user.id}">重置密码</button></td>
    </tr>`).join('');
  byId('people-body').innerHTML = people.items.length
    ? `<table class="people-table"><thead><tr><th>姓名</th><th>角色</th><th>负责板块</th><th>最近登录</th><th><span class="sr">操作</span></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="state"><b>还没有账号</b>点右上角“新建账号”</div>';
}

async function loadPeople() {
  byId('people').hidden = false;
  byId('people-body').innerHTML = '<div class="state">正在加载</div>';
  try {
    people = await api('/api/users');
    renderPeople();
  } catch (error) {
    byId('people-body').innerHTML = `<div class="state"><b>人员名单没有加载出来</b>${escapeHtml(error.message)} <button class="btn sm" type="button" data-people-retry>重新加载</button></div>`;
  }
}

const ROLE_NOTE = role => !role ? ''
  : role.key === 'admin' ? '全部功能，能看底价、改设置'
  : !role.can_write ? '全部板块只看不改'
  : role.all_sectors ? '全部板块，负责内容发布、互动收件箱和素材库'
  : '只看和跟进下面勾选的板块';

function syncSectorField() {
  const role = currentRoles().find(item => item.key === byId('p-role').value);
  byId('p-sectors-field').hidden = !role || role.all_sectors;
  byId('p-role-note').textContent = byId('p-role').disabled ? '自己的角色不能改，需要时请另一位系统负责人来改' : ROLE_NOTE(role);
}

/** 可选的角色；旧角色（招商人员）不再分配，但账号还在用时照样列出。 */
function currentRoles() {
  const roles = [...people.roles];
  if (editing && !roles.some(role => role.key === editing.role_key)) {
    roles.push({ key: editing.role_key, name: editing.role_name, all_sectors: editing.all_sectors, can_write: editing.can_write });
  }
  return roles;
}

function openPerson(user) {
  editing = user;
  byId('person-form').reset();
  byId('person-error').textContent = '';
  byId('person-title').textContent = user ? `修改账号：${user.display_name}` : '新建账号';
  byId('p-username-field').hidden = Boolean(user);
  byId('p-new-note').hidden = Boolean(user);
  byId('p-role').innerHTML = `${user ? '' : '<option value="">请选择</option>'}${currentRoles().map(role => `<option value="${role.key}">${escapeHtml(role.name)}</option>`).join('')}`;
  byId('p-sectors').innerHTML = people.sectors.map(sector => `<label class="check"><input type="checkbox" name="sectors" value="${sector.key}"${user?.sectors.includes(sector.key) ? ' checked' : ''}> ${escapeHtml(sector.name)}</label>`).join('');
  byId('p-name').value = user?.display_name ?? '';
  byId('p-role').value = user?.role_key ?? '';
  // 自己的角色不能在这里改掉，免得没人能管账号。
  byId('p-role').disabled = Boolean(user && user.is_self);
  syncSectorField();
  byId('person').showModal();
  byId('p-name').focus();
}

function showSecret(user, password) {
  byId('secret-who').textContent = `${user.display_name}（登录名 ${user.username}）的新密码：`;
  byId('secret-value').value = password;
  byId('secret-copy').textContent = '复制';
  byId('secret').showModal();
  byId('secret-value').select();
}

async function savePerson(event) {
  event.preventDefault();
  const body = { display_name: byId('p-name').value.trim() };
  if (!byId('p-role').disabled) {
    body.role_key = byId('p-role').value;
    body.sectors = [...byId('p-sectors').querySelectorAll('input:checked')].map(input => input.value);
  }
  if (!editing) body.username = byId('p-username').value.trim().toLowerCase();
  const role = currentRoles().find(item => item.key === body.role_key);
  const problem = !body.display_name ? '请填写姓名或称呼'
    : !editing && !body.username ? '请填写登录名'
    : body.role_key === '' ? '请选择角色'
    : role && !role.all_sectors && !body.sectors.length ? '请至少选一个负责的板块' : '';
  if (problem) { byId('person-error').textContent = problem; return; }
  byId('person-save').disabled = true;
  byId('person-error').textContent = '';
  try {
    if (editing) {
      await api(`/api/users/${editing.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
      byId('person').close();
      notice(`已保存 ${body.display_name} 的账号。`);
    } else {
      const result = await api('/api/users', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
      byId('person').close();
      notice(`已新建账号 ${result.user.display_name}。`);
      showSecret(result.user, result.password);
    }
    await loadPeople();
  } catch (error) {
    byId('person-error').textContent = error.message;
  } finally {
    byId('person-save').disabled = false;
  }
}

async function resetFor(user, button) {
  const self = user.is_self;
  const effect = self ? '你在其他设备上的登录会退出' : '已登录的设备需要用新密码重新登录';
  if (!confirm(`给 ${user.display_name}（${user.username}）重置密码？\n原来的密码马上失效，${effect}。`)) return;
  button.disabled = true;
  try {
    const result = await api(`/api/users/${user.id}/password`, { method: 'POST' });
    showSecret(result.user, result.password);
    await loadPeople();
  } catch (error) {
    notice(`重置没有成功：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

byId('people-add').addEventListener('click', () => openPerson(null));
byId('people-body').addEventListener('click', event => {
  if (event.target.closest('[data-people-retry]')) { loadPeople(); return; }
  const edit = event.target.closest('[data-edit]');
  const reset = event.target.closest('[data-reset]');
  const id = edit?.dataset.edit ?? reset?.dataset.reset;
  const user = people.items.find(item => item.id === id);
  if (!user) return;
  if (edit) openPerson(user);
  else resetFor(user, reset);
});
byId('p-role').addEventListener('change', syncSectorField);
byId('person-form').addEventListener('submit', savePerson);
byId('person-close').addEventListener('click', () => byId('person').close());
byId('secret-close').addEventListener('click', () => byId('secret').close());
// 关闭后清掉，密码不留在页面上。
byId('secret').addEventListener('close', () => { byId('secret-value').value = ''; });
byId('secret-copy').addEventListener('click', async () => {
  const input = byId('secret-value');
  try { await navigator.clipboard.writeText(input.value); byId('secret-copy').textContent = '已复制'; }
  catch { input.select(); byId('secret-copy').textContent = '请按 Ctrl+C 复制'; }
});

byId('retry').addEventListener('click', load);
byId('keywords').addEventListener('click', event => {
  const index = event.target.dataset.remove;
  if (index === undefined) return;
  keywords.splice(Number(index), 1);
  renderKeywords();
});
byId('s-new').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addKeyword();
});
byId('form').addEventListener('submit', async event => {
  event.preventDefault();
  addKeyword();
  if (byId('form-error').textContent) return;
  const form = event.currentTarget;
  const body = { intent_keywords: keywords };
  if (autoAvailable) Object.assign(body, { dm_auto_reply_enabled: byId('s-auto').checked, dm_auto_reply_text: byId('s-auto-text').value, dm_auto_reply_daily_limit: Number(byId('s-auto-limit').value) });
  for (const name of ASSIGNEES) body[name] = form.elements[name].value || null;
  byId('save').disabled = true;
  notice('');
  try {
    fill(await api('/api/inbox/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }));
    notice('已保存。');
  } catch (error) {
    byId('form-error').textContent = error.message;
  } finally {
    byId('save').disabled = false;
  }
});

if (shell.user.role === 'ADMIN') loadPeople();
await load();
