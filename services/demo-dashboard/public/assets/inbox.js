import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'inbox' });
const canWrite = shell.user.can_write;
const TABS = [['new', '未处理'], ['in_progress', '处理中'], ['converted', '已转线索'], ['ignored', '已忽略']];
const REPLY_STATE = { drafted: '回复已起草，待确认', queued: '回复已确认，等待发出', sent: '回复已发出', failed: '系统没能发出，请复制到手机上回复', manual: '已在手机上手动回复' };
const state = { status: 'new', intents: [], modelReady: false };

const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}) });

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function card(item) {
  const editable = canWrite && item.status !== 'converted';
  const intentSelect = editable
    ? `<select data-intent aria-label="意图分类">${state.intents.map(intent => `<option value="${intent.key}"${intent.key === item.intent ? ' selected' : ''}>${intent.label}</option>`).join('')}</select>`
    : `<span class="tag">${escapeHtml(item.intent_name)}</span>`;
  const replyLocked = ['queued', 'sent', 'manual'].includes(item.reply_status);
  return `<article class="msg${item.overdue ? ' overdue' : ''}" data-message="${item.id}">
    <div class="msg-head">
      <span class="tag">${escapeHtml(item.platform_name)}${escapeHtml(item.kind_name)}</span>
      <b>${item.sender_profile_url ? `<a class="lk" href="${escapeHtml(item.sender_profile_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.sender_name)}</a>` : escapeHtml(item.sender_name)}</b>
      <span class="meta">${dateTime(item.sent_at)}${item.source === 'manual' ? ' · 手工录入' : ''}</span>
      ${item.overdue ? '<span class="status st-bad">超过 2 小时未处理</span>' : ''}
      ${item.assignee_name ? `<span class="meta">负责人 ${escapeHtml(item.assignee_name)}</span>` : ''}
    </div>
    ${item.post_title ? `<div class="meta">来自帖子：${item.material_id ? `<a class="lk" href="/publishing.html?id=${item.material_id}">${escapeHtml(item.post_title)}</a>` : escapeHtml(item.post_title)}</div>` : ''}
    <p class="msg-text">${escapeHtml(item.content)}</p>
    <div class="msg-intent">${intentSelect}<span class="meta">${escapeHtml(item.intent_reason || '')}</span></div>
    ${item.reply_status !== 'none' ? `<div class="meta ${item.reply_status === 'failed' ? 'late' : ''}">${item.reply_auto ? '自动回复 · ' : ''}${item.reply_via === 'phone' && item.reply_status === 'queued' ? '回复已确认，等专用手机发出' : item.reply_via === 'phone' && item.reply_status === 'sent' ? '回复已由专用手机发出' : REPLY_STATE[item.reply_status]}${item.reply_auto && item.reply_text && item.reply_status !== 'failed' ? `：${escapeHtml(item.reply_text)}` : ''}${item.reply_error ? `：${escapeHtml(item.reply_error)}` : ''}</div>` : ''}
    ${canWrite && item.status !== 'ignored' ? `<div class="reply">
      <textarea data-reply rows="2" maxlength="300" placeholder="${item.can_send ? '回复内容，确认后才会发出' : '回复内容，写好后点“复制”到手机上发'}"${replyLocked ? ' disabled' : ''}>${escapeHtml(item.reply_text || '')}</textarea>
      <div class="msg-actions">
        ${replyLocked ? '' : `${state.modelReady ? '<button class="btn sm" type="button" data-act="draft">生成回复</button>' : ''}
        <button class="btn sm pri" type="button" data-act="send"${item.can_send ? '' : ` disabled title="${item.kind === 'direct_message' ? '私信要在手机上回' : '这条要在手机上回'}"`}>${item.send_via_phone ? '确认，用手机发出' : '确认发送'}</button>
        <button class="btn sm${item.can_send ? '' : ' pri'}" type="button" data-act="copy">${item.can_send ? '复制' : '复制到手机上回'}</button>
        <button class="btn sm" type="button" data-act="manual">已手动回复</button>`}
        ${item.reply_status === 'queued' ? '<button class="btn sm" type="button" data-act="copy">复制</button>' : ''}
        <span class="spacer"></span>
        ${item.status === 'converted' ? `<a class="btn sm" href="/company.html?id=${item.company_id}">看线索</a>` : `<button class="btn sm" type="button" data-act="lead">转成线索</button><button class="btn sm" type="button" data-act="ignore">忽略</button>`}
      </div></div>` : item.status === 'converted' ? `<div class="msg-actions"><a class="btn sm" href="/company.html?id=${item.company_id}">看线索</a></div>`
      : canWrite ? '<div class="msg-actions"><button class="btn sm" type="button" data-act="restore">放回未处理</button></div>' : ''}
  </article>`;
}

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/inbox/messages?status=${state.status}${byId('mine').checked ? '&mine=1' : ''}`);
    state.intents = data.intents;
    state.modelReady = data.model_ready;
    byId('tabs').innerHTML = TABS.map(([key, label]) => `<button type="button" role="tab" data-status="${key}" aria-selected="${key === state.status}">${label}<span> ${data.counts[key]}</span></button>`).join('');
    byId('list').innerHTML = data.items.length ? `<div class="msgs">${data.items.map(card).join('')}</div>`
      : `<div class="state"><b>${state.status === 'new' ? '没有未处理的意向消息' : '这一栏是空的'}</b>${state.status === 'new' ? '有人在评论或私信里询价、预约时会出现在这里' : ''}</div>`;
    byId('foot').textContent = `另有普通互动 ${data.ordinary} 条（只计数，不提醒）${data.hidden_spam ? `，广告和垃圾消息 ${data.hidden_spam} 条已隐藏` : ''}${data.classifying ? `，${data.classifying} 条正在判断` : ''}。`;
  } catch (error) {
    byId('error-text').textContent = `收件箱没有加载出来：${error.message}`;
    byId('error').hidden = false;
  }
}

byId('tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-status]');
  if (!tab || tab.dataset.status === state.status) return;
  state.status = tab.dataset.status;
  load();
});
byId('mine').addEventListener('change', load);
byId('retry').addEventListener('click', load);

byId('list').addEventListener('change', async event => {
  if (!event.target.matches('[data-intent]')) return;
  const id = event.target.closest('[data-message]').dataset.message;
  try { await send(`/api/inbox/messages/${id}/intent`, 'PUT', { intent: event.target.value }); notice('分类已改，改动已记录。'); await load(); }
  catch (error) { notice(error.message); }
});

byId('list').addEventListener('click', async event => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const article = button.closest('[data-message]');
  const id = article.dataset.message;
  const box = article.querySelector('[data-reply]');
  const base = `/api/inbox/messages/${id}`;
  button.disabled = true;
  try {
    switch (button.dataset.act) {
      case 'draft': {
        button.textContent = '正在生成';
        const { reply } = await send(`${base}/reply-draft`, 'POST');
        box.value = reply;
        notice('回复已起草，请核对后再确认发送。');
        button.textContent = '重新生成';
        break;
      }
      case 'send': {
        const result = await send(`${base}/reply`, 'POST', { text: box.value });
        notice(result.reply_via === 'phone' ? '已确认，专用手机会在几分钟内用抖音 App 发出，发完这里会显示“已由专用手机发出”。'
          : result.reply_status === 'queued' ? '已确认，系统会用收到这条消息的账号发出。' :'这条消息系统发不了，请点“复制”，到手机上回复后再点“已手动回复”。');
        await load();
        break;
      }
      case 'manual':
        await send(`${base}/reply`, 'POST', { text: box.value, manual: true });
        notice('已记为手动回复。');
        await load();
        break;
      case 'copy':
        await navigator.clipboard.writeText(box.value);
        notice('回复内容已复制。');
        break;
      case 'lead': {
        const result = await send(`${base}/lead`, 'POST');
        notice(result.merged ? '这位用户以前来过，已并入原来的线索。' : '已转成线索，可以在“招商客户”里跟进。');
        await load();
        break;
      }
      case 'ignore': await send(`${base}/status`, 'PUT', { status: 'ignored' }); await load(); break;
      case 'restore': await send(`${base}/status`, 'PUT', { status: 'new' }); await load(); break;
      default:
    }
  } catch (error) {
    notice(error.message);
  } finally {
    button.disabled = false;
  }
});

byId('open-manual')?.addEventListener('click', () => { byId('manual').hidden = false; byId('m-sender').focus(); });
byId('cancel-manual').addEventListener('click', () => { byId('manual').hidden = true; });
byId('manual-form').addEventListener('submit', async event => {
  event.preventDefault();
  byId('manual-error').textContent = '';
  try {
    await send('/api/inbox/messages', 'POST', Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    byId('manual').hidden = true;
    state.status = 'new';
    await load();
    notice('已保存并完成判断。属于普通互动的不会出现在列表里，只计入下方的数字。');
  } catch (error) { byId('manual-error').textContent = error.message; }
});

// ---------- 读取状态和“立即检查” ----------

let checkTimer;
async function loadCheckStatus({ reloadWhenDone = false } = {}) {
  try {
    const status = await api('/api/inbox/check');
    const checking = status.accounts.some(account => account.checking);
    byId('sub').textContent = !status.accounts.length ? '还没有登录好的发布账号，暂时读不到评论和私信'
      : checking ? '正在读取各平台的新评论……'
        : status.accounts.map(account => `${account.platform_name}“${account.account_name}”${account.last_inbox_check_at ? `上次检查 ${dateTime(account.last_inbox_check_at)}：${account.last_inbox_check_note || ''}` : '还没有检查过'}`).join('；')
          + (status.publisher_online ? '。每小时自动检查一次' : '。发布程序没有在运行，不会自动检查');
    const button = byId('check-now');
    if (button) { button.disabled = checking; button.textContent = checking ? '正在检查' : '立即检查'; }
    clearTimeout(checkTimer);
    if (checking) checkTimer = setTimeout(() => loadCheckStatus({ reloadWhenDone: true }), 4000);
    else if (reloadWhenDone) { await load(); notice('检查完了。新评论要等一分钟左右完成判断后才会出现在列表里。'); }
  } catch { /* 状态行读不到不影响列表 */ }
}

byId('check-now')?.addEventListener('click', async () => {
  notice('');
  try { await send('/api/inbox/check', 'POST'); await loadCheckStatus(); }
  catch (error) { notice(error.message); }
});
await loadCheckStatus();

if ('Notification' in window && Notification.permission === 'default') {
  byId('ask-notify').hidden = false;
  byId('allow-notify').addEventListener('click', async () => { await Notification.requestPermission(); byId('ask-notify').hidden = true; });
}

await load();
