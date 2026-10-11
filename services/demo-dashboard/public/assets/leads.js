import { api, escapeHtml, initShell } from './shell.js';

const PAGE = 50;
const STAGE_NAME = { new: '待联系', contacted: '已联系', viewing: '已看场', negotiating: '洽谈中', signed: '已签约', lost: '已放弃' };
const byId = id => document.getElementById(id);
const shell = await initShell({ page: 'leads' });
const state = { offset: 0, total: 0 };
const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function render(items) {
  byId('list').innerHTML = items.length ? `<table class="cands">
    <thead><tr><th scope="col">客人</th><th scope="col">需求</th><th scope="col">来源</th><th scope="col">板块 · 现在的阶段</th><th scope="col">提交时间</th></tr></thead>
    <tbody>${items.map(item => `<tr>
      <td>${item.company_id ? `<a class="rowlink" href="/company.html?id=${item.company_id}"><div class="co">${escapeHtml(item.contact_name)}</div></a>` : `<div class="co">${escapeHtml(item.contact_name)}</div>`}
        <div class="meta">${escapeHtml(item.phone)}${item.merged ? ' · 之前留过，已并到原来的记录' : ''}</div></td>
      <td>${escapeHtml(item.need || '—')}</td>
      <td>${escapeHtml(item.source_name)}</td>
      <td>${escapeHtml(item.sector_name)} · ${escapeHtml(STAGE_NAME[item.stage] || '—')}<div class="meta">${escapeHtml(item.owner_name || '未分配')}</div></td>
      <td class="num">${dateTime(item.created_at)}</td>
    </tr>`).join('')}</tbody></table>`
    : '<div class="state"><b>还没有人扫码留资</b>在“内容发布”里给一条内容生成留资二维码，放进图片、视频或评论区，客人填了就会出现在这里</div>';
  byId('pager').hidden = state.total <= PAGE;
  byId('page-info').textContent = `第 ${Math.floor(state.offset / PAGE) + 1} 页，共 ${Math.ceil(state.total / PAGE)} 页`;
  byId('prev').disabled = state.offset === 0;
  byId('next').disabled = state.offset + PAGE >= state.total;
}

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/leads/submissions?sector=${encodeURIComponent(shell.sector)}&limit=${PAGE}&offset=${state.offset}`);
    state.total = data.total;
    render(data.items);
  } catch (error) {
    byId('error-text').textContent = error.message;
    byId('error').hidden = false;
    byId('list').innerHTML = '<div class="state">没有加载出来</div>';
  }
}

byId('retry').addEventListener('click', load);
byId('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE); load(); });
byId('next').addEventListener('click', () => { state.offset += PAGE; load(); });
shell.onSectorChange(() => { state.offset = 0; load(); });

await load();
