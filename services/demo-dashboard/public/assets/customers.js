import { api, escapeHtml, initShell } from './shell.js';

const PAGE = 50;
const TABS = [['', '全部', 'all'], ['new', '待联系'], ['contacted', '已联系'], ['viewing', '已看场'], ['negotiating', '洽谈中'], ['signed', '已签约'], ['lost', '已放弃']];
const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'customers' });
const state = { stage: '', q: '', mine: false, items: [], total: 0 };

function followUpText(item) {
  if (!item.next_follow_up_at) return '未设置';
  const date = new Date(item.next_follow_up_at);
  const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (dayDiff < 0) return `逾期 ${-dayDiff} 天`;
  if (dayDiff === 0) return `今天 ${time}`;
  if (dayDiff === 1) return `明天 ${time}`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function renderTabs(counts) {
  byId('tabs').innerHTML = TABS.map(([key, label, countKey]) => `<button type="button" role="tab" data-stage="${key}" aria-selected="${key === state.stage}">${label}<span> ${counts[countKey ?? key]}</span></button>`).join('');
}

function renderList() {
  if (!state.items.length) {
    const text = state.q || state.mine || state.stage ? ['没有符合的客户', '换个条件再看'] : ['还没有跟进中的客户', '在“企业发现”里复核通过的企业会出现在这里'];
    byId('list').innerHTML = `<div class="state"><b>${text[0]}</b>${text[1]}</div>`;
  } else {
    byId('list').innerHTML = `<table class="cands">
      <thead><tr><th scope="col">企业</th><th scope="col">板块 · 阶段</th><th scope="col">负责人</th><th scope="col">意向</th><th scope="col">下次跟进</th></tr></thead>
      <tbody>${state.items.map(item => `<tr>
        <td><a class="rowlink" href="/company.html?id=${item.company_id}"><div class="co">${escapeHtml(item.company_name)}</div><div class="meta">${escapeHtml(item.address || '')}</div></a></td>
        <td>${escapeHtml(item.sector_name)} · ${escapeHtml(item.stage_name)}${item.lost_reason_name ? `<div class="meta">${escapeHtml(item.lost_reason_name)}</div>` : ''}</td>
        <td>${escapeHtml(item.owner_name || '未分配')}</td>
        <td>${escapeHtml(item.intended_property_label || item.intended_service || '—')}${item.below_floor_price ? '<div class="meta late">意向价偏低，待管理员确认</div>' : ''}</td>
        <td class="num${item.overdue ? ' down' : ''}">${['signed', 'lost'].includes(item.stage) ? '—' : followUpText(item)}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  byId('more').hidden = state.items.length >= state.total;
}

async function load({ append = false } = {}) {
  byId('error').hidden = true;
  try {
    const params = new URLSearchParams({ sector: shell.sector, limit: PAGE, offset: append ? state.items.length : 0 });
    if (state.stage) params.set('stage', state.stage);
    if (state.q) params.set('q', state.q);
    if (state.mine) params.set('mine', '1');
    const data = await api(`/api/customers?${params}`);
    state.items = append ? [...state.items, ...data.items] : data.items;
    state.total = data.total;
    renderTabs(data.counts);
    renderList();
  } catch (error) {
    byId('error-text').textContent = `客户列表没有加载出来：${error.message}`;
    byId('error').hidden = false;
    byId('list').innerHTML = '<div class="state"><b>没有加载出来</b>点上方“重新加载”再试</div>';
  }
}

byId('tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-stage]');
  if (!tab || tab.dataset.stage === state.stage) return;
  state.stage = tab.dataset.stage;
  load();
});
let typing;
byId('q').addEventListener('input', event => {
  clearTimeout(typing);
  typing = setTimeout(() => { state.q = event.target.value.trim(); load(); }, 300);
});
byId('mine').addEventListener('change', event => { state.mine = event.target.checked; load(); });
byId('load-more').addEventListener('click', () => load({ append: true }));
byId('retry').addEventListener('click', () => load());
shell.onSectorChange(() => load());
await load();
