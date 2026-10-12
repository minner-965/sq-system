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

const DEMAND_CHECKS = [['confirmed', '确有需求'], ['later', '以后可能有'], ['none', '没有需求'], ['unreachable', '没联系上']];
const SOURCE_NAME = { douyin: '抖音', xiaohongshu: '小红书', channels: '视频号', moments: '朋友圈', tender: '工程中标公告', lead_form: '扫码留资' };
const SOURCE_KIND = { tender: '黄埔区工程的中标单位', lead_form: '客人扫码留的联系方式' };
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
  byId('sub').textContent = `${company.industry || (SOURCE_KIND[company.source] || (SOURCE_NAME[company.source] ? '来自评论和私信' : '企业'))} · 收录于 ${new Date(company.created_at).toLocaleDateString('zh-CN')}`;
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

// 每类依据对应的、打电话时先要核实的问题。问的是事实，不是推销。
const ASK = {
  seeking_space: ['还在找场地吗，找到了没有', '要多大面积，什么时候要用', '除了办公，还需要门面、仓库或住宿吗'],
  relocation: ['是不是要搬，打算什么时候搬', '现在的地方哪里不合适（面积、租金、位置）', '搬的话需要多大面积'],
  new_setup: ['新公司或新分支现在在哪里办公', '是临时落脚还是已经定了长期的地方', '大概多少人办公'],
  expansion: ['扩了以后现在的办公位够不够', '有没有打算把部分团队分出来单独办公', '来往的客户和外地同事住宿、接待怎么安排'],
  project_site: ['项目部驻地定了没有，多少人常驻', '项目周期多长', '住宿和用餐是自己解决还是统一安排'],
  hiring: ['这批招的人到岗以后，现在的地方坐得下吗', '有没有计划换大一点的地方或加一处办公点']
};
const day = value => (value ? String(value).slice(0, 10) : '');
let demandCompanyId = null;
let companyPhone = null;
let demandItems = [];
const tracksById = new Map();

function renderDemand(demand, companyId) {
  demandCompanyId = companyId;
  demandItems = demand.items;
  const canCheck = canWrite && (!demand.checked_at || Date.now() - new Date(demand.checked_at).getTime() > 24 * 3600 * 1000);
  const recheck = canCheck ? `<button class="btn sm" type="button" data-recheck>${demand.checked_at ? '重新查一遍' : '现在查一下'}</button>` : '';
  if (demand.level === 'unchecked') {
    byId('demand').innerHTML = `<p class="meta">还没有查过这家企业的公开信息。它是周边的企业，现在不知道有没有需求。</p><div class="demand-check">${recheck}</div>`;
    return;
  }
  if (demand.level === 'none') {
    byId('demand').innerHTML = `<p class="meta">${day(demand.checked_at)} 查过，近一年没有查到找场地、迁址、新设、扩张、本地项目、招聘方面的公开信息。打电话时按陌生拜访对待，先问对方有没有用房、住宿、用餐方面的打算。</p><div class="demand-check">${recheck}</div>`;
    return;
  }
  const questions = [...new Set(demand.items.flatMap(signal => ASK[signal.type] || []))].slice(0, 5);
  byId('demand').innerHTML = `
    <p><span class="status ev-${demand.level}">${demand.level_name}</span> <span class="meta">${escapeHtml(demand.level_meaning)}</span></p>
    <ul class="evidence">${demand.items.map(signal => `<li><b>${escapeHtml(signal.type_name)}</b> ${escapeHtml(signal.evidence)}
      <span class="meta">${signal.source_date ? `${day(signal.source_date)} · ` : '没有日期 · '}<a href="${escapeHtml(signal.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml((signal.source_title || '看出处').slice(0, 30))}</a></span></li>`).join('')}</ul>
    <h4 class="sub-title">打电话先核实</h4>
    <ol class="ask">${questions.map(text => `<li>${text}</li>`).join('')}</ol>
    <p class="meta">这些是公开网页上的迹象，不等于对方一定有需求。核实后在左边的跟进里记下结果。${day(demand.checked_at)} 查的。</p>
    <div class="demand-check">${recheck}</div>`;
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
      ${canWrite ? '<div class="form-actions call-row"><button class="btn pri" type="button" data-call>打电话并记录</button></div>' : ''}
      <div class="field"><label>联系后核实：对方有没有需求</label>
        <div class="demand-check" role="group" aria-label="联系后核实">${DEMAND_CHECKS.map(([key, label]) => `<button class="btn sm" type="button" data-demand="${key}" aria-pressed="${track.demand_check === key}"${off}>${label}</button>`).join('')}</div>
        ${track.demand_checked_at ? `<div class="meta">${dateTime(track.demand_checked_at)} 记的${track.demand_check_note ? `：${escapeHtml(track.demand_check_note)}` : ''}</div>` : '<div class="meta">打过电话或见过面以后点一下，用来回头看哪类依据准</div>'}
      </div>
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
    companyPhone = data.company.phone || null;
    tracksById.clear();
    for (const track of data.tracks) tracksById.set(track.id, track);
    renderDemand(data.demand, data.company.id);
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
  if (event.target.closest('[data-call]')) { openCall(card.dataset.track); return; }
  const demand = event.target.closest('[data-demand]');
  if (demand && demand.getAttribute('aria-pressed') !== 'true') {
    const note = prompt(`记为“${demand.textContent}”。可以补一句对方怎么说的（可不填）：`);
    if (note === null) return;
    changeTrack(card, { demand_check: demand.dataset.demand, demand_check_note: note.trim() || null }, `已记下：${demand.textContent}`);
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

byId('demand').addEventListener('click', async event => {
  const button = event.target.closest('[data-recheck]');
  if (!button) return;
  button.disabled = true;
  button.textContent = '正在查';
  try {
    const result = await send(`/api/discovery/companies/${demandCompanyId}/signals`, 'POST', {});
    await load();
    byId('notice').textContent = result.found ? `查到 ${result.found} 条依据。` : '查过了，近一年没有相关的公开信息。';
    byId('notice').hidden = false;
  } catch (error) {
    byId('notice').textContent = error.message;
    byId('notice').hidden = false;
    button.disabled = false;
  }
});

// 打电话并记录：电话由人用自己的手机打，这里只负责把号码、要问的话和结果放在一起。
let callTrackId = null;

function openCall(trackId) {
  const track = tracksById.get(trackId);
  callTrackId = trackId;
  const phone = track.contact_phone || companyPhone;
  byId('call-number').innerHTML = phone
    ? `<a class="btn" href="tel:${encodeURIComponent(phone)}">拨打 ${escapeHtml(phone)}</a><span class="meta">${track.contact_name ? escapeHtml(track.contact_name) : '用手机打开这一页可以直接拨出'}</span>`
    : '<span class="meta">还没有这家的电话。问到以后填在“联系电话”里。</span>';
  const questions = [...new Set(demandItems.flatMap(signal => ASK[signal.type] || []))].slice(0, 4);
  byId('call-ask').innerHTML = questions.length
    ? `<h4 class="sub-title">先核实</h4><ol class="ask">${questions.map(text => `<li>${text}</li>`).join('')}</ol>`
    : '<p class="meta">这家没有查到需求依据，先问对方近期有没有用房、住宿或用餐方面的打算。</p>';
  byId('call-form').reset();
  byId('call-error').textContent = '';
  byId('call-stage-row').hidden = track.stage !== 'new';
  byId('call').showModal();
}

byId('call-close').addEventListener('click', () => byId('call').close());
byId('call').addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
byId('call-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const track = tracksById.get(callTrackId);
  const result = data.get('result');
  const changes = { demand_check: result, demand_check_note: String(data.get('note') || '').trim() || null, contact_via: 'call' };
  if (data.get('next')) changes.next_follow_up_at = fromLocalInput(data.get('next'));
  if (track.stage === 'new' && result !== 'unreachable' && data.get('advance')) changes.stage = 'contacted';
  try {
    await send(`/api/tracks/${callTrackId}`, 'PATCH', changes);
    byId('call').close();
    await load();
    notice('通话已记下');
  } catch (error) {
    byId('call-error').textContent = error.message;
  }
});
