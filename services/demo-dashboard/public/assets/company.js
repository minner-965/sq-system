import { api, escapeHtml, initShell } from './shell.js';

const STAGES = [['new', '待联系'], ['contacted', '已联系'], ['viewing', '已看场'], ['negotiating', '洽谈中'], ['signed', '已签约'], ['lost', '已放弃']];
const LOST_REASONS = [['price', '价格贵'], ['location', '位置不合适'], ['layout', '格局不合适'], ['other', '其他']];
const ACTIVITY_TYPES = [['call', '电话'], ['visit', '拜访'], ['viewing', '看场'], ['wechat', '微信'], ['note', '备注']];
const PRICE_WARNING = '意向价低于公司可接受的最低条件，已通知管理员。按这个价格只有管理员能办理签约。';

const byId = id => document.getElementById(id);
const companyId = new URLSearchParams(location.search).get('id');
const shell = await initShell({ page: 'customers' });
const canWrite = shell.user.can_write;
const owners = {};

const SOURCE_NAME = { douyin: '抖音', xiaohongshu: '小红书', channels: '视频号', moments: '朋友圈' };
const dateTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const distance = metres => (metres >= 1000 ? `${(metres / 1000).toFixed(1)} 公里` : `${metres} 米`);
// <input type="datetime-local"> 用的是本地时间，不带时区。
const toLocalInput = value => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = value => (value ? new Date(value).toISOString() : null);
const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
const options = (pairs, selected, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${pairs.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}`;
const off = canWrite ? '' : ' disabled';

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
  if (text) byId('notice').scrollIntoView({ block: 'nearest' });
}

function renderFacts(company) {
  document.title = `${company.company_name} · 恒兆广场招商系统`;
  byId('name').textContent = company.company_name;
  byId('sub').textContent = `${company.industry || (SOURCE_NAME[company.source] ? '来自评论和私信' : '企业')} · 收录于 ${new Date(company.created_at).toLocaleDateString('zh-CN')}`;
  const fact = (label, value) => `<div><span>${label}</span><b>${value || '—'}</b></div>`;
  byId('facts').innerHTML = [
    fact('地址', escapeHtml(company.address)),
    fact('电话', escapeHtml(company.phone)),
    fact('距恒兆广场', company.distance_m == null ? '' : distance(company.distance_m)),
    fact('统一社会信用代码', escapeHtml(company.unified_social_credit_code)),
    fact('规模', escapeHtml(company.employee_scale)),
    fact('资料来源', company.source_url ? `<a href="${escapeHtml(company.source_url)}" target="_blank" rel="noopener noreferrer">高德地图</a>` : escapeHtml(SOURCE_NAME[company.source] || company.source || '手工录入'))
  ].join('');
}

function renderScores(candidates) {
  byId('scores').innerHTML = candidates.length ? candidates.map(item => `
    <details class="why"${candidates.length === 1 ? ' open' : ''}><summary>${escapeHtml(item.sector_name)} <b class="score">${item.score}</b> 分</summary>
      <ul>${item.score_items.map(part => `<li><span>${escapeHtml(part.item)}</span><b>${part.points}<small> / ${part.max}</small></b><em>${escapeHtml(part.reason)}</em></li>`).join('')}</ul>
      ${item.notices.map(text => `<p class="meta late">${escapeHtml(text)}</p>`).join('')}
    </details>`).join('<div style="height:10px"></div>') : '<div class="state">没有评分记录</div>';
}

let timeline = [];

function renderTimeline(activities) {
  timeline = activities;
  // 每条记录是一个按钮：点开看完整内容和记录当时的客户情况。
  byId('timeline').innerHTML = activities.length ? `<ul class="timeline">${activities.map((item, index) => `
    <li><button class="record" type="button" data-record="${index}" aria-haspopup="dialog">
      <span class="when"><span>${dateTime(item.occurred_at)}</span><span>${escapeHtml(item.sector_name)} · ${escapeHtml(item.activity_name)}</span><span>${escapeHtml(item.created_by_name || '')}</span></span>
      <span class="text">${escapeHtml(item.content)}</span><span class="more">查看</span></button></li>`).join('')}</ul>` : '<div class="state">还没有跟进记录</div>';
}

function openRecord(item) {
  const then = item.snapshot;
  const range = (low, high, unit) => (low == null && high == null ? null : `${low ?? '不限'} – ${high ?? '不限'} ${unit}`);
  const rows = then ? [
    ['阶段', then.stage_name], ['负责人', then.owner_name], ['联系人', then.contact_name], ['联系电话', then.contact_phone],
    ['下次跟进时间', then.next_follow_up_at && dateTime(then.next_follow_up_at)], ['看场预约时间', then.viewing_at && dateTime(then.viewing_at)],
    ['需要的业态', { office: '写字楼', retail: '商铺' }[then.need_property_type]], ['面积需求', range(then.need_area_min, then.need_area_max, '㎡')],
    ['预算', then.need_budget_per_sqm != null ? `${then.need_budget_per_sqm} 元/㎡·月` : null], ['需要明火', then.need_open_flame ? '是' : null],
    ['意向房源', then.intended_property_label], ['意向服务', then.intended_service],
    ['意向面积', then.intended_area_sqm != null ? `${then.intended_area_sqm} ㎡` : null], ['意向价', then.intended_price != null ? `${then.intended_price} 元/㎡·月` : null]
  ].filter(([, value]) => value != null && value !== '') : [];
  byId('record-title').textContent = `${item.sector_name} · ${item.activity_name}`;
  byId('record-body').innerHTML = `
    <div class="facts">
      <div><span>发生时间</span><b>${dateTime(item.occurred_at)}</b></div>
      <div><span>记录人</span><b>${escapeHtml(item.created_by_name || '—')}</b></div>
      <div><span>录入时间</span><b>${dateTime(item.created_at)}</b></div>
    </div>
    <h4 class="sub-title">记录内容</h4>
    <p class="record-text">${escapeHtml(item.content)}</p>
    <h4 class="sub-title">当时的客户情况</h4>
    ${rows.length ? `<dl class="record-then">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join('')}</dl>`
    : `<p class="meta">${then ? '当时还没有填写客户情况' : '这条记录是早些时候写的，当时没有留存客户情况'}</p>`}`;
  byId('record').showModal();
}

function trackCard(track) {
  if (track.restricted) {
    return `<section class="card"><div class="ph"><div><h3>${escapeHtml(track.sector_name)}</h3><p>${escapeHtml(track.stage_name)} · 负责人 ${escapeHtml(track.owner_name || '未分配')}</p></div></div>
      <div class="pb"><div class="state">这个板块由其他同事跟进</div></div></section>`;
  }
  const isProperty = track.sector_key === 'office_retail';
  const ownerOptions = options((owners[track.sector_key] || []).map(user => [user.id, user.display_name]), track.owner_user_id, '未分配');
  return `<section class="card" data-track="${track.id}">
    <div class="ph"><div><h3>${escapeHtml(track.sector_name)}</h3><p>当前阶段：${escapeHtml(track.stage_name)}${track.lost_reason_name ? `（${escapeHtml(track.lost_reason_name)}）` : ''}</p></div></div>
    <div class="pb">
      ${track.below_floor_price ? `<div class="warn-box" role="alert">${PRICE_WARNING}</div>` : ''}
      <div class="steps" role="group" aria-label="跟进阶段">${STAGES.map(([key, label]) => `<button type="button" data-stage="${key}" class="${key === 'lost' ? 'lost' : ''}" aria-pressed="${key === track.stage}"${off}>${label}</button>`).join('')}</div>
      <form class="track-form lost-form" hidden>
        <div class="field"><label>放弃原因（必选）</label><select name="lost_reason_category" required>${options(LOST_REASONS, track.lost_reason_category, '请选择')}</select></div>
        <div class="field"><label>补充说明</label><input name="lost_reason" value="${escapeHtml(track.lost_reason || '')}" maxlength="300"></div>
        <div class="wide form-actions"><button class="btn" type="button" data-cancel-lost>取消</button><button class="btn pri" type="submit">确认放弃</button></div>
      </form>
      <form class="track-form detail-form">
        <div class="field"><label>负责人</label><select name="owner_user_id"${off}>${ownerOptions}</select></div>
        <div class="field"><label>下次跟进时间</label><input type="datetime-local" name="next_follow_up_at" value="${toLocalInput(track.next_follow_up_at)}"${off}></div>
        <div class="field"><label>联系人</label><input name="contact_name" value="${escapeHtml(track.contact_name || '')}" maxlength="40"${off}></div>
        <div class="field"><label>联系电话</label><input name="contact_phone" value="${escapeHtml(track.contact_phone || '')}" maxlength="40"${off}></div>
        ${isProperty ? `
        <div class="field"><label>看场预约时间</label><input type="datetime-local" name="viewing_at" value="${toLocalInput(track.viewing_at)}"${off}></div>
        <div class="field"><label>需要的业态</label><select name="need_property_type"${off}>${options([['office', '写字楼'], ['retail', '商铺']], track.need_property_type, '未确定')}</select></div>
        <div class="field"><label>面积下限（㎡）</label><input type="number" name="need_area_min" min="1" step="1" value="${track.need_area_min ?? ''}"${off}></div>
        <div class="field"><label>面积上限（㎡）</label><input type="number" name="need_area_max" min="1" step="1" value="${track.need_area_max ?? ''}"${off}></div>
        <div class="field"><label>预算（元/㎡·月，含管理费）</label><input type="number" name="need_budget_per_sqm" min="1" step="0.5" value="${track.need_budget_per_sqm ?? ''}"${off}></div>
        <div class="field"><label>意向价（元/㎡·月，含管理费）</label><input type="number" name="intended_price" min="1" step="0.5" value="${track.intended_price ?? ''}"${off}></div>
        <label class="check wide"><input type="checkbox" name="need_open_flame"${track.need_open_flame ? ' checked' : ''}${off}>需要明火</label>
        <div class="field wide"><label>意向房源</label><input value="${escapeHtml(track.intended_property_label || '未选，可在下方推荐里加入')}" disabled></div>` : `
        <div class="field wide"><label>意向服务</label><input name="intended_service" value="${escapeHtml(track.intended_service || '')}" maxlength="200" placeholder="${track.sector_key === 'dining' ? '例如：每周三次午市团餐，约 40 人' : '例如：差旅协议价，每月约 20 间夜'}"${off}></div>
        <div class="field"><label>意向价（元）</label><input type="number" name="intended_price" min="1" step="1" value="${track.intended_price ?? ''}"${off}></div>`}
        ${canWrite ? '<div class="wide form-actions"><span class="form-error" role="alert"></span><button class="btn pri" type="submit">保存</button></div>' : ''}
      </form>
      ${isProperty ? `<h4 class="sub-title">房源推荐</h4><div class="matches"><button class="btn" type="button" data-load-matches>按需求推荐房源</button></div>` : ''}
      ${canWrite ? `<h4 class="sub-title">记一条跟进</h4>
      <form class="track-form activity-form">
        <div class="field"><label>方式</label><select name="type">${options(ACTIVITY_TYPES, 'call')}</select></div>
        <div class="field"><label>时间</label><input type="datetime-local" name="occurred_at" value="${toLocalInput(new Date())}"></div>
        <div class="field wide"><label>内容</label><textarea name="content" required maxlength="2000"></textarea></div>
        <div class="wide form-actions"><span class="form-error" role="alert"></span><button class="btn pri" type="submit">记录</button></div>
      </form>` : ''}
    </div></section>`;
}

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api(`/api/companies/${encodeURIComponent(companyId)}/profile`);
    for (const track of data.tracks.filter(item => !item.restricted && !owners[item.sector_key])) {
      owners[track.sector_key] = (await api(`/api/sectors/${track.sector_key}/owners`)).items;
    }
    renderFacts(data.company);
    renderScores(data.candidates);
    renderTimeline(data.activities);
    byId('tracks').innerHTML = data.tracks.length ? data.tracks.map(trackCard).join('')
      : '<section class="card"><div class="state"><b>还没有进入跟进</b>在“企业发现”里复核通过后，这里会出现对应板块的跟进</div></section>';
  } catch (error) {
    byId('error-text').textContent = `企业详情没有加载出来：${error.message}`;
    byId('error').hidden = false;
  }
}

async function changeTrack(card, changes, done) {
  try {
    const result = await send(`/api/tracks/${card.dataset.track}`, 'PATCH', changes);
    await load();
    notice(result.price_warning && changes.intended_price != null ? PRICE_WARNING : done);
  } catch (error) {
    notice(error.message);
  }
}

async function loadMatches(card) {
  const box = card.querySelector('.matches');
  try {
    const data = await api(`/api/tracks/${card.dataset.track}/matches`);
    box.innerHTML = data.items.length ? data.items.map(unit => `
      <div class="match"><div>
        <b>${escapeHtml(unit.building)} ${escapeHtml(unit.unit_no)}</b> <span class="tag">${unit.fits ? '符合需求' : '接近需求'}</span>
        <div class="meta">${unit.floor} 层${unit.fit_out ? ` · ${escapeHtml(unit.fit_out)}` : ''}</div>
        ${unit.reasons.map(reason => `<div class="meta">${escapeHtml(reason)}</div>`).join('')}
      </div><div class="acts">
        ${unit.floor_plan_url ? `<a class="back" href="${escapeHtml(unit.floor_plan_url)}" target="_blank" rel="noopener">平面图</a>` : ''}
        ${unit.selected ? '<span class="status st-ok">已是意向房源</span>' : canWrite ? `<button class="btn sm" type="button" data-intend="${unit.id}">加入意向</button>` : ''}
      </div></div>`).join('') : '<div class="state">没有在租的同类房源</div>';
  } catch (error) {
    box.innerHTML = `<div class="state"><b>推荐没有加载出来</b>${escapeHtml(error.message)}</div>`;
  }
}

byId('tracks').addEventListener('click', event => {
  const card = event.target.closest('[data-track]');
  if (!card) return;
  const stage = event.target.closest('[data-stage]');
  if (stage && stage.getAttribute('aria-pressed') !== 'true') {
    if (stage.dataset.stage === 'lost') { card.querySelector('.lost-form').hidden = false; card.querySelector('.lost-form select').focus(); return; }
    changeTrack(card, { stage: stage.dataset.stage }, `阶段已改为“${stage.textContent}”`);
    return;
  }
  if (event.target.closest('[data-cancel-lost]')) { card.querySelector('.lost-form').hidden = true; return; }
  if (event.target.closest('[data-load-matches]')) { loadMatches(card); return; }
  const intend = event.target.closest('[data-intend]');
  if (intend) changeTrack(card, { intended_property_id: intend.dataset.intend }, '已加入意向房源');
});

byId('tracks').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const card = form.closest('[data-track]');
  const data = new FormData(form);
  if (form.classList.contains('lost-form')) {
    if (!data.get('lost_reason_category')) { form.querySelector('select').focus(); return; }
    await changeTrack(card, { stage: 'lost', lost_reason_category: data.get('lost_reason_category'), lost_reason: data.get('lost_reason') || null }, '已标为放弃');
  } else if (form.classList.contains('detail-form')) {
    const changes = {};
    for (const element of form.elements) {
      if (!element.name) continue;
      if (element.type === 'checkbox') changes[element.name] = element.checked;
      else if (element.type === 'datetime-local') changes[element.name] = fromLocalInput(element.value);
      else changes[element.name] = element.value === '' ? null : element.value;
    }
    await changeTrack(card, changes, '已保存');
  } else if (form.classList.contains('activity-form')) {
    try {
      await send(`/api/tracks/${card.dataset.track}/activities`, 'POST', { type: data.get('type'), content: data.get('content'), occurred_at: fromLocalInput(data.get('occurred_at')) });
      await load();
      notice('跟进已记录');
    } catch (error) {
      form.querySelector('.form-error').textContent = error.message;
    }
  }
});

byId('timeline').addEventListener('click', event => {
  const button = event.target.closest('[data-record]');
  if (button) openRecord(timeline[Number(button.dataset.record)]);
});
byId('record-close').addEventListener('click', () => byId('record').close());
// 点弹窗外面的灰色区域也能关。
byId('record').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
byId('retry').addEventListener('click', load);
if (companyId) await load();
else { byId('error-text').textContent = '没有指定企业'; byId('error').hidden = false; }
