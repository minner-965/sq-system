import { api, escapeHtml, initShell } from './shell.js';

const SECTOR_COLORS = ['#2563EB', '#5B8DEF', '#9DB9F3'];
const number = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
const byId = id => document.getElementById(id);
const empty = (title, hint) => `<div class="state"><b>${title}</b>${hint}</div>`;

function setKpi(id, value, unit, sub) {
  const card = byId(id);
  card.querySelector('.val').innerHTML = `${escapeHtml(value)}<small>${unit}</small>`;
  card.querySelector('.sub').innerHTML = sub || '&nbsp;';
}

function renderKpis(data) {
  if (data.properties) {
    setKpi('kpi-properties', number(data.properties.available_units), '套',
      `<span class="tag">商铺 ${data.properties.retail_units}</span><span class="tag">写字楼 ${data.properties.office_units}</span><span>共 ${number(data.properties.available_area_sqm)} ㎡</span>`);
  } else {
    setKpi('kpi-properties', '—', '', '<span>房源属于商铺写字楼板块</span>');
  }
  const { this_week: thisWeek, last_week: lastWeek, pending_review: pending } = data.companies;
  const change = thisWeek - lastWeek;
  setKpi('kpi-companies', number(thisWeek), '家', [
    change ? `<span class="${change > 0 ? 'up' : 'down'}">较上周 ${change > 0 ? '+' : ''}${change}</span>` : '<span>与上周持平</span>',
    pending ? `<span>其中待复核 ${pending}</span>` : ''
  ].join(''));
  setKpi('kpi-viewings', number(data.viewings_this_month), '次', '');
  const { due_today: due, overdue } = data.follow_ups;
  setKpi('kpi-follow', number(due), '条', overdue ? `<span class="late">${overdue} 条已逾期</span>` : '');
  byId('kpi-follow').classList.toggle('attn', overdue > 0);
  byId('kpis').classList.remove('loading');
}

function renderFunnel({ steps, lost }) {
  const top = steps[0].count;
  if (!top && !lost) { byId('funnel').innerHTML = empty('还没有跟进中的客户', '企业进入跟进后，这里显示各阶段的数量'); return; }
  const rows = steps.map((step, index) => {
    const previous = index ? steps[index - 1].count : 0;
    const rate = index && previous ? `${Math.round((step.count / previous) * 100)}%` : '—';
    return `<div class="fun-row"><span class="n">${step.name}</span><div class="track"><span style="width:${top ? (step.count / top) * 100 : 0}%"></span></div><span class="v">${number(step.count)}</span><span class="r">${rate}</span></div>`;
  }).join('');
  byId('funnel').innerHTML = `<div class="fun">${rows}</div><div class="fun-foot"><span>已流失<b>${number(lost)}</b></span></div>`;
}

let chart;
function renderDistribution(items) {
  const total = items.reduce((sum, item) => sum + item.companies, 0);
  chart?.destroy();
  chart = null;
  if (!total) { byId('distribution').innerHTML = empty('还没有跟进中的企业', '各板块的客户数量会显示在这里'); return; }
  byId('distribution').innerHTML = `
    <div class="donut-wrap">
      <div class="donut"><canvas width="180" height="180" role="img" aria-label="各板块跟进中的企业数量"></canvas><div class="mid"><b>${number(total)}</b><span>家企业</span></div></div>
      <div class="legend">${items.map((item, index) => `<div><i style="background:${SECTOR_COLORS[index]}"></i>${escapeHtml(item.name)}<b>${number(item.companies)}</b></div>`).join('')}</div>
    </div>`;
  chart = new window.Chart(byId('distribution').querySelector('canvas'), {
    type: 'doughnut',
    data: { labels: items.map(item => item.name), datasets: [{ data: items.map(item => item.companies), backgroundColor: SECTOR_COLORS, borderWidth: 0 }] },
    options: { cutout: '72%', responsive: false, animation: false, plugins: { legend: { display: false } } }
  });
}

function renderPublishing(publishing) {
  if (!publishing) byId('publishing').innerHTML = empty('内容发布尚未开通', '开通后这里显示本周的发布任务和各平台状态');
}

function followUpTime(item) {
  const date = new Date(item.next_follow_up_at);
  const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (dayDiff < 0) return `逾期 ${-dayDiff} 天`;
  if (dayDiff === 0) return `今天 ${time}`;
  if (dayDiff === 1) return `明天 ${time}`;
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

function renderFollowUps(items) {
  if (!items.length) { byId('follow-ups').innerHTML = empty('没有待跟进的客户', '设置了下次跟进时间的客户会排在这里'); return; }
  byId('follow-ups').innerHTML = `<table>
    <thead><tr><th scope="col">企业</th><th scope="col">板块 · 阶段</th><th scope="col">负责人</th></tr></thead>
    <tbody>${items.map(item => `<tr>
      <td><div class="co">${escapeHtml(item.company_name)}</div></td>
      <td>${escapeHtml(item.sector_name)} · ${escapeHtml(item.stage_name)}<div class="meta${item.overdue ? ' overdue' : ''}">${followUpTime(item)}</div></td>
      <td>${escapeHtml(item.owner_name || '未分配')}</td>
    </tr>`).join('')}</tbody></table>`;
}

const shell = await initShell({ page: 'overview' });

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/overview?sector=${encodeURIComponent(shell.sector)}`);
    const now = new Date(data.generated_at);
    byId('updated').textContent = `${now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} · 数据更新于 ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    byId('funnel-scope').textContent = `当前全部客户 · ${shell.sectorName(shell.sector)}`;
    renderKpis(data);
    renderFunnel(data.funnel);
    renderDistribution(data.sector_distribution);
    renderPublishing(data.publishing);
    renderFollowUps(data.follow_ups.items);
  } catch (error) {
    byId('error-text').textContent = `总览数据没有加载出来：${error.message}`;
    byId('error').hidden = false;
    for (const id of ['funnel', 'distribution', 'publishing', 'follow-ups']) byId(id).innerHTML = empty('没有加载出来', '点上方“重新加载”再试');
  }
}

byId('retry').addEventListener('click', load);
shell.onSectorChange(load);
await load();
