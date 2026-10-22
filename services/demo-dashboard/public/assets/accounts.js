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

let phone = { known: false, note: '' };

function phoneLine() {
  const tag = phone.ready && phone.moments_ready ? '<span class="status st-ok">手机可以用</span>'
    : phone.connected ? '<span class="status st-warn">手机已连接，还不能发</span>' : '<span class="status st-wait">手机没有连接</span>';
  const detail = phone.ready && !phone.moments_ready ? '手机已连接，发朋友圈还没有打开，见下方“专用手机”' : phone.note;
  return `${tag}<div class="meta">${escapeHtml(detail)}${phone.model ? ` · ${escapeHtml(phone.model)}` : ''}</div>`;
}

function loginLine(account) {
  if (account.uses_phone) return phoneLine();
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
        <div><span>${account.uses_phone ? '专用手机' : '登录状态'}</span><b>${loginLine(account)}</b></div>
        <div><span>今天已发 / 每日上限</span><b>${account.published_today} / ${account.daily_limit} 条</b></div>
        <div><span>待发布</span><b>${account.queued} 条</b></div>
      </div>
      ${canWrite ? `<div class="msg-actions" style="margin-top:16px">
        ${account.uses_phone ? '' : `<button class="btn sm pri" type="button" data-act="login"${account.connected && !waiting ? '' : ' disabled'}>${account.login_status === 'ok' ? '重新扫码 / 换一个号' : '扫码登录'}</button>`}
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
    phone = data.phone;
    byId('network-line').textContent = data.publisher.network_note || '';
    byId('network-line').hidden = !data.publisher.network_note;
    byId('network-line').classList.toggle('late', Boolean(data.publisher.network_note) && !data.publisher.network_note.includes('直连（'));
    byId('publisher-line').textContent = data.publisher.online ? '发布程序正在这台电脑上运行'
      : `发布程序没有在运行${data.publisher.last_seen_at ? `（最后在线 ${dateTime(data.publisher.last_seen_at)}）` : ''}。扫码登录和到点发布都需要它：双击 publisher 文件夹里的 start-publisher.cmd`;
    byId('list').innerHTML = data.items.length ? `<div class="stack">${data.items.map(accountCard).join('')}</div>`
      : `<div class="card"><div class="state"><b>还没有发布账号</b>${canWrite ? '点右上角“添加账号”' : '系统负责人添加后会显示在这里'}</div></div>`;
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

if (!canWrite) byId('publisher-line').insertAdjacentHTML('afterend', '<p class="meta">这个账号只能查看，添加账号和扫码登录请用招商或系统负责人账号</p>');
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
// ---------- 专用手机 ----------

let phonePolling;
const SWITCHES = [['moments', '发朋友圈', 'wechat'], ['dm', '在手机上回私信', 'douyin']];

function appFact(panel, app) {
  const check = panel.checks[app];
  const installed = panel[`${app}_installed`];
  const install = !panel.known ? '<span class="status st-wait">不知道</span>'
    : installed ? '<span class="status st-ok">已安装</span>' : `<span class="status st-bad">手机上没有装${check.app_name}</span>`;
  let last = '<div class="meta">还没有测试过</div>';
  if (check.running) last = '<div class="meta">正在测试，手机上会自动打开 App，请不要动手机</div>';
  else if (check.status) {
    const tag = check.status === 'succeeded' ? '<span class="status st-ok">测试通过</span>' : '<span class="status st-bad">测试没通过</span>';
    last = `<div class="meta">${tag} ${check.finished_at ? dateTime(check.finished_at) : ''}${check.message ? `：${escapeHtml(check.message)}` : ''}
      ${check.screenshot_url ? ` <a class="lk" href="${escapeHtml(check.screenshot_url)}" target="_blank" rel="noopener">看手机截图</a>` : ''}</div>`;
  }
  return `<div><span>${check.app_name}</span><b>${install}${last}</b></div>`;
}

function switchRow(panel, [key, label, app]) {
  const item = panel.switches[key];
  const appName = panel.checks[app].app_name;
  const state = item.enabled
    ? `<span class="status ${item.working ? 'st-ok' : 'st-warn'}">已打开</span>${item.enabled_by ? `<span class="meta">${escapeHtml(item.enabled_by)} ${item.enabled_at ? dateTime(item.enabled_at) : ''} 打开</span>` : ''}
       ${item.working ? '' : `<span class="meta late">现在发不了：${panel.connected ? `${appName}的测试要在 ${panel.test_valid_days} 天内重新通过` : '手机没有连接'}</span>`}`
    : `<span class="status st-wait">关着</span><span class="meta">${item.can_enable ? `${appName}测试已通过，可以打开` : `先点“测试一下${appName}”，通过后才能打开`}</span>`;
  const button = isAdmin
    ? `<button class="btn sm${item.enabled ? '' : ' pri'}" type="button" data-switch="${key}" data-enabled="${item.enabled}"${item.enabled || item.can_enable ? '' : ' disabled'}>${item.enabled ? '关闭' : '打开'}</button>` : '';
  return `<div class="phone-switch"><b>${label}</b>${state}<span class="spacer"></span>${button}</div>`;
}

function renderPhone(panel) {
  const running = Object.values(panel.checks).some(check => check.running);
  const connection = !panel.known ? `<span class="status st-wait">不知道</span><div class="meta">${escapeHtml(panel.note)}</div>`
    : `<span class="status ${panel.ready ? 'st-ok' : panel.connected ? 'st-warn' : 'st-wait'}">${panel.connected ? '已连接' : '没有连接'}</span>
       <div class="meta">${escapeHtml(panel.note)}${panel.model ? ` · ${escapeHtml(panel.model)}` : ''}</div>`;
  const testable = canWrite && panel.publisher_online && panel.connected && !running;
  byId('phone-body').innerHTML = `
    <div class="facts">
      <div><span>连接</span><b>${connection}</b></div>
      ${appFact(panel, 'wechat')}
      ${appFact(panel, 'douyin')}
    </div>
    ${canWrite ? `<div class="msg-actions" style="margin-top:16px">
      <button class="btn sm" type="button" data-check="wechat"${testable ? '' : ' disabled'}>测试一下微信</button>
      <button class="btn sm" type="button" data-check="douyin"${testable ? '' : ' disabled'}>测试一下抖音</button>
      <span class="meta">只打开 App 看一眼、截一张图，不会发任何内容</span>
    </div>` : ''}
    <div class="phone-switches">${SWITCHES.map(row => switchRow(panel, row)).join('')}</div>
    ${isAdmin ? '' : '<p class="meta">两个开关由系统负责人在测试通过后打开</p>'}`;
  clearTimeout(phonePolling);
  if (running) phonePolling = setTimeout(loadPhone, 4000);
}

async function loadPhone() {
  try {
    renderPhone(await api('/api/inbox/phone'));
  } catch (error) {
    byId('phone-body').innerHTML = `<div class="state">手机状态没有读出来：${escapeHtml(error.message)}</div>`;
  }
}

byId('phone-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-check],[data-switch]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.check) {
      await send('/api/inbox/phone/checks', 'POST', { app: button.dataset.check });
      notice('已发起测试。手机上会自动打开 App，半分钟左右出结果，请不要动手机。');
      await loadPhone();
    } else {
      const enable = button.dataset.enabled !== 'true';
      const label = SWITCHES.find(([key]) => key === button.dataset.switch)[1];
      if (enable && !window.confirm(`打开“${label}”以后，确认过的内容会由这台手机发出。确定打开吗？`)) { button.disabled = false; return; }
      renderPhone(await send(`/api/inbox/phone/switches/${button.dataset.switch}`, 'PUT', { enabled: enable }));
      notice(enable ? `“${label}”已打开。` : `“${label}”已关闭，手机上不会再发。`);
    }
  } catch (error) {
    notice(error.message);
    button.disabled = false;
  }
});

byId('retry').addEventListener('click', load);
await Promise.all([load(), loadPhone()]);
