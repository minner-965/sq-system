import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'settings' });
const ASSIGNEES = ['assignee_property', 'assignee_event', 'assignee_hotel', 'assignee_dining'];
const MAX_KEYWORDS = 300;
let keywords = [];

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
  const options = '<option value="">不指定（管理员处理）</option>' + settings.users.map(user => `<option value="${user.id}">${escapeHtml(user.display_name)}</option>`).join('');
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
    byId('body').innerHTML = '<div class="card"><div class="state"><b>这一页只有管理员能改</b>需要调整分配或关键词时请找管理员</div></div>';
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
  const body = { intent_keywords: keywords, dm_auto_reply_enabled: byId('s-auto').checked, dm_auto_reply_text: byId('s-auto-text').value, dm_auto_reply_daily_limit: Number(byId('s-auto-limit').value) };
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

await load();
