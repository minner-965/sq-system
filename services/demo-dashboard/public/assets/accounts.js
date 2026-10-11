import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'accounts' });
const isAdmin = shell.user.role === 'ADMIN';
const canWrite = shell.user.can_write;
const LOGIN_NAME = { never: '还没有登录过', ok: '登录正常', expired: '需重新扫码' };
const TYPE_NAME = { personal: '个人号', enterprise: '企业号', professional: '专业号' };
let polling;

const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}) });

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function loginLine(account) {
  if (!account.connected) return `<span class="status st-wait">${escapeHtml(account.platform_name)}还没有接入</span>`;
  if (['queued', 'opened'].includes(account.login_request_status)) return '<span class="status st-warn">等待扫码，请看这台电脑上弹出的浏览器窗口</span>';
  const tag = `<span class="status ${account.login_status === 'ok' ? 'st-ok' : 'st-warn'}">${LOGIN_NAME[account.login_status]}</span>`;
  const failed = account.login_request_status === 'failed' && account.login_status !== 'ok' ? `<div class="meta late">上次扫码没有成功：${escapeHtml(account.login_request_message || '')}</div>` : '';
  return `${tag}${account.last_login_at ? `<div class="meta">最近登录 ${dateTime(account.last_login_at)}</div>` : ''}${failed}`;
}

function accountCard(account) {
  const waiting = ['queued', 'opened'].includes(account.login_request_status);
  return `<section class="card account" data-account="${account.id}">
    <div class="ph"><div><h3>${escapeHtml(account.platform_name)} · ${escapeHtml(account.account_name)}</h3>
      <p>${TYPE_NAME[account.account_type]}${account.purpose === 'search' ? ' · 搜索专用' : ''}${account.is_paused ? ' · 已暂停发布' : ''}</p></div></div>
    <div class="pb">
      <div class="facts">
        <div><span>登录状态</span><b>${loginLine(account)}</b></div>
        <div><span>今天已发 / 每日上限</span><b>${account.published_today} / ${account.daily_limit} 条</b></div>
        <div><span>待发布</span><b>${account.queued} 条</b></div>
      </div>
      ${canWrite ? `<div class="msg-actions" style="margin-top:16px">
        <button class="btn sm pri" type="button" data-act="login"${account.connected && !waiting ? '' : ' disabled'}>${account.login_status === 'ok' ? '重新扫码 / 换一个号' : '扫码登录'}</button>
        ${isAdmin ? `<button class="btn sm" type="button" data-act="pause" data-paused="${account.is_paused}">${account.is_paused ? '恢复发布' : '暂停发布'}</button>
        <button class="btn sm" type="button" data-act="limit" data-limit="${account.daily_limit}">改每日上限</button>
        <button class="btn sm" type="button" data-act="rename" data-name="${escapeHtml(account.account_name)}">改名称</button>` : ''}
      </div>` : ''}
    </div></section>`;
}

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api('/api/publishing/accounts');
    byId('publisher-line').textContent = data.publisher.online ? '发布程序正在这台电脑上运行'
      : `发布程序没有在运行${data.publisher.last_seen_at ? `（最后在线 ${dateTime(data.publisher.last_seen_at)}）` : ''}。扫码登录和到点发布都需要它：双击 publisher 文件夹里的 start-publisher.cmd`;
    byId('list').innerHTML = data.items.length ? `<div class="stack">${data.items.map(accountCard).join('')}</div>`
      : `<div class="card"><div class="state"><b>还没有发布账号</b>${canWrite ? '点右上角“添加账号”' : '管理员添加后会显示在这里'}</div></div>`;
    clearTimeout(polling);
    // 有账号在等扫码时自动刷新，扫完马上能看到结果。
    if (data.items.some(account => ['queued', 'opened'].includes(account.login_request_status))) polling = setTimeout(load, 4000);
  } catch (error) {
    byId('error-text').textContent = `发布账号没有加载出来：${error.message}`;
    byId('error').hidden = false;
  }
}

byId('list').addEventListener('click', async event => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const id = button.closest('[data-account]').dataset.account;
  try {
    if (button.dataset.act === 'login') {
      await send(`/api/publishing/accounts/${id}/login`, 'POST');
      notice('已发起扫码。几秒后这台电脑上会弹出浏览器窗口，用对应平台的手机 App 扫码，最多等 10 分钟。');
    } else if (button.dataset.act === 'pause') {
      await send(`/api/publishing/accounts/${id}`, 'PATCH', { is_paused: button.dataset.paused !== 'true' });
      notice(button.dataset.paused === 'true' ? '已恢复，到点的内容会照常发布。' : '已暂停，这个账号不会再发布，直到恢复。');
    } else if (button.dataset.act === 'limit') {
      const value = window.prompt('每天最多发几条（1–50）', button.dataset.limit);
      if (value === null) return;
      await send(`/api/publishing/accounts/${id}`, 'PATCH', { daily_limit: Number(value) });
      notice('每日上限已修改。');
    } else if (button.dataset.act === 'rename') {
      const value = window.prompt('账号名称', button.dataset.name);
      if (value === null) return;
      await send(`/api/publishing/accounts/${id}`, 'PATCH', { account_name: value });
      notice('名称已修改。');
    }
    await load();
  } catch (error) {
    notice(error.message);
  }
});

if (!canWrite) byId('publisher-line').insertAdjacentHTML('afterend', '<p class="meta">这个账号只能查看，添加账号和扫码登录请用招商或管理员账号</p>');
if (canWrite) {
  byId('open-add').hidden = false;
  byId('open-add').addEventListener('click', () => { byId('add').hidden = false; byId('a-name').focus(); });
  byId('cancel-add').addEventListener('click', () => { byId('add').hidden = true; });
  byId('a-platform').addEventListener('change', event => { byId('a-limit').value = event.target.value === 'moments' ? 3 : 5; });
  byId('add-form').addEventListener('submit', async event => {
    event.preventDefault();
    byId('add-error').textContent = '';
    try {
      const data = Object.fromEntries(new FormData(event.target));
      await send('/api/publishing/accounts', 'POST', { ...data, daily_limit: Number(data.daily_limit) });
      event.target.reset();
      byId('add').hidden = true;
      await load();
      notice('账号已添加。接下来点“扫码登录”。');
    } catch (error) { byId('add-error').textContent = error.message; }
  });
}
byId('retry').addEventListener('click', load);
await load();
