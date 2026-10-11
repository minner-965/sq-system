import { api, escapeHtml, initShell } from './shell.js';

const PAGE = 50;
const byId = id => document.getElementById(id);
const distance = metres => (metres >= 1000 ? `${(metres / 1000).toFixed(1)} 公里` : `${metres} 米`);
const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const splitList = value => value.split(/[、,，\s]+/).map(item => item.trim()).filter(Boolean);
const post = (path, body, method = 'POST') => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });

const shell = await initShell({ page: 'discovery' });
const state = { status: 'pending', q: '', items: [], total: 0, polling: null };

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function scoreDetail(item) {
  const rows = item.score_items.map(part => `<li><span>${escapeHtml(part.item)}</span><b>${part.points}<small> / ${part.max}</small></b><em>${escapeHtml(part.reason)}${part.source ? ` · <a href="${escapeHtml(part.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part.source.label)}</a>` : ''}</em></li>`).join('');
  return `<details class="why"><summary><b class="score">${item.score}</b> 分</summary><ul>${rows}</ul></details>`;
}

function actions(item) {
  if (item.status === 'pending') {
    if (!shell.user.can_write) return '';
    return `<button class="btn sm pri" type="button" data-review="approve" data-id="${item.id}">通过</button><button class="btn sm" type="button" data-review="reject" data-id="${item.id}">不合适</button>`;
  }
  if (item.status === 'approved') return `<a class="btn sm" href="/company.html?id=${item.company_id}">去跟进</a>`;
  return `<span class="status st-wait">不合适</span>${item.reject_reason ? `<div class="meta">${escapeHtml(item.reject_reason)}</div>` : ''}`;
}

function renderList() {
  if (!state.items.length) {
    const text = state.q ? ['没有符合的企业', '换个名称或地址再试']
      : state.status === 'pending' ? ['没有待复核的企业', shell.user.can_write ? '点右上角“立即检索”查找周边企业' : '检索到新企业后会出现在这里']
        : ['这里还没有企业', '复核过的企业会归到这里'];
    byId('list').innerHTML = `<div class="state"><b>${text[0]}</b>${text[1]}</div>`;
  } else {
    byId('list').innerHTML = `<table class="cands">
      <thead><tr><th scope="col">企业</th><th scope="col">板块</th><th scope="col">距离</th><th scope="col">评分</th><th scope="col">电话</th><th scope="col"><span class="sr">操作</span></th></tr></thead>
      <tbody>${state.items.map(item => `<tr data-row="${item.id}">
        <td><div class="co">${escapeHtml(item.company_name)}</div><div class="meta">${escapeHtml(item.industry || '')}${item.industry && item.address ? ' · ' : ''}${escapeHtml(item.address || '')}</div>${item.notices.map(text => `<div class="meta late">${escapeHtml(text)}</div>`).join('')}</td>
        <td>${escapeHtml(item.sector_name)}</td>
        <td class="num">${distance(item.distance_m)}</td>
        <td>${scoreDetail(item)}</td>
        <td class="num">${escapeHtml(item.phone || '—')}</td>
        <td class="acts">${actions(item)}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  byId('more').hidden = state.items.length >= state.total;
}

async function loadList({ append = false } = {}) {
  const params = new URLSearchParams({ sector: shell.sector, status: state.status, limit: PAGE, offset: append ? state.items.length : 0 });
  if (state.q) params.set('q', state.q);
  const data = await api(`/api/discovery/candidates?${params}`);
  state.items = append ? [...state.items, ...data.items] : data.items;
  state.total = data.total;
  for (const key of ['pending', 'approved', 'rejected']) byId(`count-${key}`).textContent = ` ${data.counts[key]}`;
  renderList();
}

function describeRun(run) {
  const who = run.trigger === 'scheduled' ? '每日自动检索' : `${run.requested_by_name || ''}发起的检索`;
  if (run.status === 'queued' || run.status === 'running') return `${who}正在进行，完成后本页自动刷新`;
  if (run.status === 'failed') return `${dateTime(run.created_at)} ${who}没有完成：${run.error_message || '原因未知'}`;
  return `最近一次检索 ${dateTime(run.finished_at)}：看了 ${run.results_seen} 家，新增 ${run.companies_new} 家，更新 ${run.companies_updated} 家，项目内商户 ${run.companies_excluded} 家未收录`;
}

async function loadStatus() {
  const data = await api('/api/discovery/status');
  const [latest] = data.runs;
  const amap = data.providers.find(provider => provider.name === 'amap');
  const active = latest && ['queued', 'running'].includes(latest.status);
  byId('run-line').textContent = latest ? describeRun(latest) : amap.connected ? '还没有检索过' : '还没有配置高德 Key，暂时不能检索';
  const runButton = byId('run');
  if (runButton) {
    runButton.disabled = active || !amap.connected;
    runButton.textContent = active ? '正在检索' : '立即检索';
  }
  const usage = data.usage.find(row => row.provider === 'amap');
  byId('usage').textContent = usage
    ? `高德地图接口：今天调用 ${usage.calls_today} 次，本月 ${usage.calls_this_month} 次${usage.errors_this_month ? `（其中失败 ${usage.errors_this_month} 次）` : ''}，本月费用 ${usage.cost_this_month.toFixed(2)} 元。`
    : '高德地图接口：还没有调用记录。';
  clearTimeout(state.polling);
  if (active) state.polling = setTimeout(async () => { await refresh(); }, 3000);
  return active;
}

async function loadSettings() {
  if (shell.user.role !== 'ADMIN') return;
  const settings = await api('/api/discovery/settings');
  const form = byId('settings-form');
  form.radius.value = Math.round(settings.radius_m / 1000);
  form.max_calls.value = settings.max_calls_per_run;
  form.querySelectorAll('[name="category"]').forEach(box => { box.checked = settings.category_codes.includes(box.value); });
  form.keywords.value = settings.keywords.join('、');
  form.excludes.value = settings.exclude_address_keywords.join('、');
  form.daily.checked = settings.daily_run_enabled;
  byId('settings').hidden = false;
}

async function refresh() {
  byId('error').hidden = true;
  try {
    await loadStatus();
    await loadList();
  } catch (error) {
    byId('error-text').textContent = `企业发现没有加载出来：${error.message}`;
    byId('error').hidden = false;
    byId('list').innerHTML = '<div class="state"><b>没有加载出来</b>点上方“重新加载”再试</div>';
  }
}

document.querySelector('.tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-status]');
  if (!tab || tab.dataset.status === state.status) return;
  state.status = tab.dataset.status;
  document.querySelectorAll('[data-status]').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
  refresh();
});

let typing;
byId('q').addEventListener('input', event => {
  clearTimeout(typing);
  typing = setTimeout(() => { state.q = event.target.value.trim(); refresh(); }, 300);
});

byId('load-more').addEventListener('click', () => loadList({ append: true }).catch(error => notice(error.message)));
byId('retry').addEventListener('click', refresh);
shell.onSectorChange(refresh);

byId('run')?.addEventListener('click', async () => {
  notice('');
  byId('run').disabled = true;
  try { await post('/api/discovery/runs', {}); await loadStatus(); }
  catch (error) { notice(error.message); await loadStatus().catch(() => {}); }
});

byId('list').addEventListener('click', async event => {
  const button = event.target.closest('[data-review]');
  if (!button) return;
  const decision = button.dataset.review;
  let reason = null;
  if (decision === 'reject') {
    reason = window.prompt('不合适的原因（可不填）', '');
    if (reason === null) return;
  }
  button.closest('td').querySelectorAll('button').forEach(item => { item.disabled = true; });
  try {
    await post(`/api/discovery/candidates/${button.dataset.id}/review`, { decision, reason });
    notice(decision === 'approve' ? '已通过，这家企业进入了该板块的跟进' : '已标为不合适');
    await loadList();
  } catch (error) {
    notice(error.message);
    await loadList().catch(() => {});
  }
});

byId('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  byId('settings-error').textContent = '';
  try {
    await post('/api/discovery/settings', {
      radius_m: Number(form.radius.value) * 1000,
      max_calls_per_run: Number(form.max_calls.value),
      category_codes: [...form.querySelectorAll('[name="category"]:checked')].map(box => box.value),
      keywords: splitList(form.keywords.value),
      exclude_address_keywords: splitList(form.excludes.value),
      daily_run_enabled: form.daily.checked
    }, 'PUT');
    notice('检索设置已保存，下次检索生效');
    byId('settings').open = false;
  } catch (error) {
    byId('settings-error').textContent = error.message;
  }
});

await loadSettings().catch(() => {});
await refresh();
