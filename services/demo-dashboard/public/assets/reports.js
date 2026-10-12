import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'reports' });
const number = value => Number(value).toLocaleString('zh-CN');
const rate = value => (value == null ? '—' : `${value}%`);
// 日期一律按广州时间算，和服务端一致。
const day = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);

function preset(key) {
  const today = day(new Date());
  const [year, month] = today.split('-').map(Number);
  const pad = value => String(value).padStart(2, '0');
  if (key === 'month') return [`${year}-${pad(month)}-01`, today];
  if (key === 'last-month') {
    const lastYear = month === 1 ? year - 1 : year;
    const lastMonth = month === 1 ? 12 : month - 1;
    return [`${lastYear}-${pad(lastMonth)}-01`, `${lastYear}-${pad(lastMonth)}-${pad(new Date(Date.UTC(lastYear, lastMonth, 0)).getUTCDate())}`];
  }
  return [day(new Date(Date.now() - 29 * 86400000)), today];
}

const query = () => new URLSearchParams({ sector: shell.sector, from: byId('from').value, to: byId('to').value });

function renderFunnel(funnel) {
  const groups = funnel.sectors.length > 1 ? [{ name: '合计', ...funnel.all }, ...funnel.sectors] : funnel.sectors.length ? funnel.sectors : [];
  if (!funnel.all.total) {
    byId('funnel').innerHTML = '<div class="state"><b>这段时间没有新开始跟进的客户</b>在“企业发现”里通过的企业、转成线索的评论私信、扫码留资的客人，都会算进来</div>';
    return;
  }
  byId('funnel').innerHTML = groups.map(group => {
    const top = Math.max(group.stages[0].reached, 1);
    return `<div class="report-group">
      <h4>${escapeHtml(group.name)}<span>新增 ${number(group.total)} 家${group.lost ? `，其中已放弃 ${number(group.lost)} 家` : ''}</span></h4>
      <table class="cands report-table">
        <thead><tr><th scope="col">阶段</th><th scope="col" class="wide-col">到过这一步</th><th scope="col" class="num">客户数</th><th scope="col" class="num">相对上一步</th><th scope="col" class="num">现在停在这</th></tr></thead>
        <tbody>${group.stages.map(stage => `<tr>
          <td>${stage.name}</td>
          <td class="wide-col"><div class="bar"><i style="width:${Math.round((stage.reached / top) * 100)}%"></i></div></td>
          <td class="num">${number(stage.reached)}</td><td class="num">${rate(stage.rate)}</td><td class="num">${number(stage.now)}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }).join('');
}

function renderChannels(items) {
  const active = items.filter(item => item.posts || item.removed || item.messages || item.form_submissions);
  if (!active.length) {
    byId('channels').innerHTML = '<div class="state"><b>这段时间没有发布，也没有收到消息和留资</b></div>';
    return;
  }
  byId('channels').innerHTML = `<table class="cands report-table">
    <thead><tr><th scope="col">渠道</th><th scope="col" class="num">发布</th><th scope="col" class="num">浏览</th><th scope="col" class="num">点赞</th>
      <th scope="col" class="num">评论和私信</th><th scope="col" class="num">其中有意向</th><th scope="col" class="num">转成线索</th><th scope="col" class="num">扫码留资</th></tr></thead>
    <tbody>${items.map(item => `<tr${active.includes(item) ? '' : ' class="quiet"'}>
      <td>${escapeHtml(item.name)}${item.removed ? `<div class="meta">另有 ${item.removed} 条后来删除</div>` : ''}</td>
      <td class="num">${number(item.posts)}</td>
      <td class="num">${item.numbers_missing ? '读不到' : number(item.views)}</td><td class="num">${item.numbers_missing ? '读不到' : number(item.likes)}</td>
      <td class="num">${number(item.messages)}</td><td class="num">${number(item.enquiries)}</td><td class="num">${number(item.message_leads)}</td><td class="num">${number(item.form_leads)}</td>
    </tr>`).join('')}</tbody></table>
    <p class="report-note">浏览和点赞是这段时间发布的帖子到现在的累计数。线索和留资按人数算。</p>`;
}

function renderEvidence(rows) {
  if (!rows.some(row => row.checked)) {
    byId('evidence').innerHTML = '<div class="state"><b>这段时间还没有记过核实结果</b>联系客户以后，在客户页的“联系后核实”里点一下对方有没有需求，这里就能看出哪类依据准</div>';
    return;
  }
  byId('evidence').innerHTML = `<table class="cands report-table">
    <thead><tr><th scope="col">联系前的依据</th><th scope="col" class="num">核实过</th><th scope="col" class="num">确有需求</th><th scope="col" class="num">以后可能有</th>
      <th scope="col" class="num">没有需求</th><th scope="col" class="num">没联系上</th><th scope="col" class="num">联系上的里面确有需求</th></tr></thead>
    <tbody>${rows.map(row => `<tr${row.checked ? '' : ' class="quiet"'}>
      <td>${escapeHtml(row.name)}</td><td class="num">${number(row.checked)}</td><td class="num">${number(row.confirmed)}</td><td class="num">${number(row.later)}</td>
      <td class="num">${number(row.none)}</td><td class="num">${number(row.unreachable)}</td><td class="num">${rate(row.hit_rate)}</td>
    </tr>`).join('')}</tbody></table>
    <p class="report-note">只统计联系后记了核实结果的客户。核实的客户还少的时候，比例没有参考意义。</p>`;
}

function renderWorkload(rows, ownOnly) {
  byId('workload-sub').textContent = ownOnly ? '你这段时间做了什么' : '每个人这段时间做了什么';
  if (!rows.length) { byId('workload').innerHTML = '<div class="state">没有可以统计的人员</div>'; return; }
  byId('workload').innerHTML = `<table class="cands report-table">
    <thead><tr><th scope="col">姓名</th><th scope="col" class="num">跟进记录</th><th scope="col" class="num">电话</th><th scope="col" class="num">微信</th><th scope="col" class="num">拜访</th>
      <th scope="col" class="num">看场</th><th scope="col" class="num">推进阶段</th><th scope="col" class="num">新增客户</th><th scope="col" class="num">签约</th>
      <th scope="col" class="num">手上在跟</th><th scope="col" class="num">回复</th><th scope="col" class="num">确认发布</th></tr></thead>
    <tbody>${rows.map(row => `<tr>
      <td><div class="co">${escapeHtml(row.display_name)}</div><div class="meta">${escapeHtml(row.role_name)}</div></td>
      <td class="num">${number(row.follow_ups)}</td><td class="num">${number(row.calls)}</td><td class="num">${number(row.wechats)}</td><td class="num">${number(row.visits)}</td>
      <td class="num">${number(row.viewings)}</td><td class="num">${number(row.stage_changes)}</td><td class="num">${number(row.new_customers)}</td><td class="num">${number(row.signed)}</td>
      <td class="num">${number(row.open_now)}</td><td class="num">${number(row.replies)}</td><td class="num">${number(row.posts)}</td>
    </tr>`).join('')}</tbody></table>
    <p class="report-note">“手上在跟”是现在的数，其余是这段时间里发生的。</p>`;
}

async function load() {
  byId('error').hidden = true;
  byId('export').href = `/api/reports/export?${query()}`;
  try {
    const data = await api(`/api/reports?${query()}`);
    byId('sub').textContent = `${data.period.from} 至 ${data.period.to} · ${shell.sectorName(shell.sector)}`;
    renderFunnel(data.funnel);
    renderChannels(data.channels);
    renderEvidence(data.evidence);
    renderWorkload(data.workload, data.own_row_only);
  } catch (error) {
    byId('error-text').textContent = error.message;
    byId('error').hidden = false;
    for (const id of ['funnel', 'channels', 'evidence', 'workload']) byId(id).innerHTML = '<div class="state">没有加载出来</div>';
  }
}

function applyPreset(key) {
  [byId('from').value, byId('to').value] = preset(key);
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === key)));
  load();
}

byId('period').addEventListener('click', event => {
  const button = event.target.closest('[data-preset]');
  if (button) applyPreset(button.dataset.preset);
});
byId('period').addEventListener('submit', event => {
  event.preventDefault();
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  load();
});
byId('retry').addEventListener('click', load);
shell.onSectorChange(() => load());

applyPreset('30');
