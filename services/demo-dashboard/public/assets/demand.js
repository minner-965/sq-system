import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'demand' });
const canWrite = shell.user.can_write;
const isAdmin = shell.user.role === 'ADMIN';
const TABS = [['open', '待处理'], ['converted', '已转线索'], ['closed', '已关闭'], ['filtered', '筛掉的']];
const SECTORS = [['office_retail', '商铺写字楼'], ['hotel_apartment', '酒店公寓'], ['dining', '餐饮']];
const FACT_NAME = { area: '面积', budget: '预算', region: '区域', industry: '行业或用途' };
const state = { view: 'open', accounts: [], modelReady: false };

const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body ?? {}) });

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function showError(text) {
  byId('error-text').textContent = text;
  byId('error').hidden = false;
}

function card(item) {
  const facts = Object.entries(item.facts || {}).filter(([key]) => FACT_NAME[key]).map(([key, value]) => `<span class="tag">${FACT_NAME[key]} ${escapeHtml(value)}</span>`).join(' ');
  const accounts = state.accounts.filter(account => account.platform === item.platform);
  const open = item.status === 'new' && item.verdict === 'need';
  return `<article class="msg" data-post="${item.id}">
    <div class="msg-head">
      <span class="tag">${escapeHtml(item.platform_name)}${escapeHtml(item.kind_name)}</span>
      <b>${escapeHtml(item.author_name || '昵称未显示')}</b>
      <span class="meta">${item.posted_at ? dateTime(item.posted_at) : '时间未知'}${item.keyword ? ` · 搜“${escapeHtml(item.keyword)}”找到` : ''}</span>
      ${item.sector_name ? `<span class="status st-ok">${escapeHtml(item.sector_name)}</span>` : `<span class="status st-wait">${escapeHtml(item.verdict_name)}</span>`}
    </div>
    ${item.kind === 'comment' && item.parent_title ? `<div class="meta">评论在帖子《${escapeHtml(item.parent_title)}》下</div>` : ''}
    ${item.title ? `<p class="msg-text"><b>${escapeHtml(item.title)}</b></p>` : ''}
    <p class="msg-text">${escapeHtml(item.content)}</p>
    <div class="msg-intent">${facts}<span class="meta">${escapeHtml(item.reason || '')}</span></div>
    ${item.contacted_at ? `<div class="meta">${escapeHtml(item.contacted_by_name || '')} ${dateTime(item.contacted_at)} 已联系：${escapeHtml(item.contact_text || '')}</div>` : ''}
    ${open && canWrite && !item.contacted_at ? `<div class="reply" data-contact hidden>
      <textarea data-text rows="2" maxlength="300" placeholder="要留给对方的话。写好后复制，到手机上在原帖下发出，发完回来点“已联系”">${escapeHtml(item.contact_draft || '')}</textarea>
      <div class="msg-actions">
        ${state.modelReady ? '<button class="btn sm" type="button" data-act="draft">起草一条</button>' : ''}
        <button class="btn sm" type="button" data-act="copy">复制</button>
        <select data-account aria-label="用哪个账号联系的">${accounts.length ? accounts.map(account => `<option value="${account.id}">${escapeHtml(account.account_name)}</option>`).join('') : '<option value="">还没有这个平台的发布账号</option>'}</select>
        <button class="btn sm pri" type="button" data-act="contacted"${accounts.length ? '' : ' disabled'}>已联系</button>
      </div>
    </div>` : ''}
    <div class="msg-actions">
      ${item.post_url ? `<a class="btn sm" href="${escapeHtml(item.post_url)}" target="_blank" rel="noopener noreferrer">看原帖</a>` : ''}
      ${item.company_id ? `<a class="btn sm" href="/company.html?id=${item.company_id}">看客户档案</a>` : ''}
      ${item.status === 'new' && canWrite ? `
        ${open && !item.contacted_at ? '<button class="btn sm" type="button" data-act="contact">联系对方</button>' : ''}
        <span class="spacer"></span>
        ${open ? '' : `<select data-sector aria-label="属于哪个板块">${SECTORS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select>`}
        <button class="btn sm pri" type="button" data-act="convert">转成线索</button>
        ${open ? `<button class="btn sm" type="button" data-act="dismissed">不合适</button>
        <button class="btn sm" type="button" data-act="not_interested" title="这个人以后的帖子不再出现">对方不感兴趣</button>` : ''}` : ''}
    </div>
  </article>`;
}

const EMPTY = {
  open: ['还没有发现新的需求帖', '搜索专用账号登录好以后，每天自动搜两次；也可以点右上角“现在搜一次”'],
  converted: ['还没有转成线索的', '在“待处理”里点“转成线索”，就会进“招商客户”的待联系'],
  closed: ['没有关闭的', '标为“不合适”或“对方不感兴趣”的会放在这里'],
  filtered: ['没有筛掉的', '判断为中介、同行广告或无关的帖子放在这里，判断错了可以在这里转成线索']
};

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/demand/posts?view=${state.view}`);
    state.accounts = data.contact_accounts;
    state.modelReady = data.model_ready;
    byId('tabs').innerHTML = TABS.map(([key, label]) => `<button type="button" role="tab" data-view="${key}" aria-selected="${key === state.view}">${label}<span> ${data.counts[key]}</span></button>`).join('');
    byId('list').innerHTML = data.items.length ? data.items.map(card).join('') : `<div class="state"><b>${EMPTY[state.view][0]}</b>${EMPTY[state.view][1]}</div>`;
    const search = data.search;
    const names = search.accounts.map(account => `${account.platform_name}“${account.account_name}”${account.login_status === 'ok' ? '' : '（要扫码登录）'}`).join('、');
    byId('not-ready').hidden = search.ready;
    byId('not-ready').textContent = search.accounts.length
      ? `搜索专用账号 ${names} 还没有登录好，登录后才会开始搜索。请到“发布账号”里扫码。`
      : '还没有搜索专用的账号，所以还没开始搜索。请到“发布账号”里添加一个搜索专用的小号（不要用发帖的号）并扫码登录。';
    byId('search-now').disabled = !search.ready;
    byId('foot').textContent = [
      search.last_run_at ? `上次搜索 ${dateTime(search.last_run_at)}${search.last_run_note ? `：${search.last_run_note}` : ''}` : '还没有搜索过',
      search.enabled ? (search.next_run_at && search.ready ? `下次大约 ${dateTime(search.next_run_at)}` : '') : '自动搜索已关闭',
      data.counts.pending ? `还有 ${data.counts.pending} 条在排队等筛选` : ''
    ].filter(Boolean).join(' · ');
  } catch (error) {
    showError(`没有加载出来：${error.message}`);
    byId('list').innerHTML = '<div class="state">没有加载出来</div>';
  }
}

byId('tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-view]');
  if (!tab) return;
  state.view = tab.dataset.view;
  notice('');
  load();
});

byId('list').addEventListener('click', async event => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const post = button.closest('[data-post]');
  const id = post.dataset.post;
  const act = button.dataset.act;
  const box = post.querySelector('[data-contact]');
  if (act === 'contact') { box.hidden = !box.hidden; if (!box.hidden) box.querySelector('[data-text]').focus(); return; }
  if (act === 'copy') {
    const text = box.querySelector('[data-text]').value.trim();
    if (!text) { notice('先写好要说的话再复制。'); return; }
    try { await navigator.clipboard.writeText(text); notice('已复制。到手机上打开原帖，贴进评论发出，发完回来点“已联系”。'); } catch { notice('没能自动复制，请手动选中文字复制。'); }
    return;
  }
  button.disabled = true;
  try {
    if (act === 'draft') {
      const result = await send(`/api/demand/posts/${id}/draft`, 'POST');
      box.querySelector('[data-text]').value = result.draft;
      notice('已起草，请改成自己的话再发。');
    } else if (act === 'contacted') {
      const result = await send(`/api/demand/posts/${id}/contact`, 'POST', { text: box.querySelector('[data-text]').value, account_id: box.querySelector('[data-account]').value });
      await load();
      notice(`已记下。这个账号今天主动联系了 ${result.used_today} 人，每天最多 ${result.daily_limit} 人。`);
    } else if (act === 'convert') {
      const sector = post.querySelector('[data-sector]')?.value || null;
      const result = await send(`/api/demand/posts/${id}/convert`, 'POST', { sector });
      await load();
      notice(result.merged ? '这个人之前已经有记录，已并到原来的客户档案里。' : '已转成线索，进了“招商客户”的待联系。');
    } else {
      const result = await send(`/api/demand/posts/${id}/close`, 'POST', { reason: act });
      await load();
      notice(act === 'not_interested' ? `已记下，这个人以后的帖子不再出现${result.also_closed ? `（同时关掉了他的另外 ${result.also_closed} 条）` : ''}。` : '已标为不合适。');
    }
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

byId('search-now').addEventListener('click', async event => {
  event.target.disabled = true;
  try { await send('/api/demand/search', 'POST'); notice('已经安排，一两分钟内开始搜索，搜完筛好的会出现在这里。'); }
  catch (error) { showError(error.message); }
  finally { event.target.disabled = false; }
});

function countKeywords() {
  const count = byId('keywords').value.split(/[\n,，]+/).map(word => word.trim()).filter(Boolean).length;
  byId('keyword-count').textContent = `${count} / 30 个`;
  byId('keyword-count').className = count > 30 ? 'down' : '';
}

if (isAdmin) {
  byId('open-settings').hidden = false;
  byId('open-settings').addEventListener('click', async () => {
    try {
      const settings = await api('/api/demand/settings');
      byId('keywords').value = settings.keywords.join('\n');
      byId('enabled').checked = settings.enabled;
      byId('settings-error').textContent = '';
      byId('settings').hidden = false;
      countKeywords();
      byId('keywords').focus();
    } catch (error) { showError(error.message); }
  });
  byId('keywords').addEventListener('input', countKeywords);
  byId('cancel-settings').addEventListener('click', () => { byId('settings').hidden = true; });
  byId('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await send('/api/demand/settings', 'PUT', { keywords: byId('keywords').value, enabled: byId('enabled').checked });
      byId('settings').hidden = true;
      notice('关键词已保存，下一次搜索开始用。');
      load();
    } catch (error) { byId('settings-error').textContent = error.message; }
  });
}

byId('retry').addEventListener('click', load);
await load();
