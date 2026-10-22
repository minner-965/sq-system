import { api, escapeHtml, initShell } from './shell.js';

const byId = id => document.getElementById(id);
await initShell({ page: 'hotel' });
let canEdit = false;

const RATES = [['rack_rate', '门市价'], ['weekend_rate', '周末价'], ['corporate_rate', '企业协议价']];
const dateTime = value => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const price = value => (value == null ? '<span class="meta">未填</span>' : `${Number(value)} 元`);
const list = value => (value?.length ? value.map(escapeHtml).join('；') : '—');

function notice(text) {
  byId('notice').textContent = text;
  byId('notice').hidden = !text;
}

function profileCard(hotel) {
  const meeting = hotel.meeting_room_area_sqm ? `${hotel.meeting_room_area_sqm} ㎡，${hotel.meeting_room_capacity_min}–${hotel.meeting_room_capacity_max} 人` : '—';
  return `<section class="card">
    <div class="ph"><div><h3>${escapeHtml(hotel.name)}</h3><p>${escapeHtml(hotel.brand_note || '')}</p></div></div>
    <div class="pb">
      <div class="facts hotel-facts">
        <div><span>地址</span><b>${escapeHtml(hotel.address || '—')}</b></div>
        <div><span>电话</span><b>${escapeHtml(hotel.phone || '—')}</b></div>
        <div><span>客房</span><b>${hotel.room_count ? `${hotel.room_count} 间` : '—'}${hotel.opened_year ? `，${hotel.opened_year} 年开业` : ''}</b></div>
        <div><span>入住 / 退房</span><b>${escapeHtml(hotel.check_in_time || '—')} / ${escapeHtml(hotel.check_out_time || '—')}</b></div>
        <div><span>会议室</span><b>${meeting}</b></div>
        <div><span>主要客人</span><b>${list(hotel.target_guests)}</b></div>
        <div class="wide"><span>位置</span><b>${list(hotel.location_notes)}</b></div>
        <div class="wide"><span>设施</span><b>${list(hotel.facilities)}</b></div>
        <div class="wide"><span>客房特点</span><b>${list(hotel.room_highlights)}</b></div>
      </div>
    </div></section>`;
}

function rateCell(room, field, label) {
  if (!canEdit) return `<td data-label="${label}" class="num">${price(room[field])}</td>`;
  return `<td data-label="${label}"><label class="rate-input"><input type="text" inputmode="decimal" name="${field}" value="${room[field] ?? ''}" aria-label="${escapeHtml(room.name)} ${label}（元/晚）" maxlength="9"><span>元</span></label></td>`;
}

function roomRow(room) {
  const note = canEdit
    ? `<input type="text" name="price_note" value="${escapeHtml(room.price_note || '')}" maxlength="60" placeholder="如：含单早" aria-label="${escapeHtml(room.name)} 价格说明">`
    : escapeHtml(room.price_note || '—');
  return `<tr data-room="${room.id}" data-name="${escapeHtml(room.name)}">
    <td data-label="房型"><div class="co">${escapeHtml(room.name)}</div>${room.features ? `<div class="meta">${escapeHtml(room.features)}</div>` : ''}</td>
    <td data-label="面积">${room.area_sqm != null ? `${room.area_sqm} ㎡` : '—'}</td>
    ${RATES.map(([field, label]) => rateCell(room, field, label)).join('')}
    <td data-label="价格说明" class="note-cell">${note}</td>
  </tr>`;
}

function noteField(hotel, field, label, placeholder) {
  if (!canEdit) return `<div><span>${label}</span><b>${escapeHtml(hotel[field] || '未填')}</b></div>`;
  return `<div class="field"><label for="${field}-${hotel.id}">${label}</label>
    <textarea id="${field}-${hotel.id}" name="${field}" maxlength="200" placeholder="${placeholder}">${escapeHtml(hotel[field] || '')}</textarea></div>`;
}

function pricesCard(hotel) {
  const updated = hotel.prices_updated_at ? `最近修改：${dateTime(hotel.prices_updated_at)}${hotel.prices_updated_by_name ? `，${escapeHtml(hotel.prices_updated_by_name)}` : ''}` : '还没有填过价格';
  const lines = hotel.public_price_lines.length
    ? `<ul class="price-lines">${hotel.public_price_lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
    : '<p class="meta">还没有对外价格，写文案和回复时只说欢迎咨询。</p>';
  return `<section class="card">
    <form class="hotel-prices" data-hotel="${hotel.id}" novalidate>
      <div class="ph"><div><h3>对外房价</h3><p>每晚价格，单位元；不对外说的价格留空</p></div></div>
      <div class="table-wrap"><table class="price-table">
        <thead><tr><th>房型</th><th>面积</th>${RATES.map(([, label]) => `<th>${label}</th>`).join('')}<th>价格说明</th></tr></thead>
        <tbody>${hotel.rooms.length ? hotel.rooms.map(roomRow).join('') : '<tr><td colspan="6"><div class="state">还没有房型</div></td></tr>'}</tbody>
      </table></div>
      <div class="pb">
        <div class="${canEdit ? 'form-grid price-notes' : 'facts price-notes'}">
          ${noteField(hotel, 'long_stay_price_note', '长住价格', '如：月租 3500 元起，含水电')}
          ${noteField(hotel, 'meeting_room_price_note', '会议室价格', '如：半天 1500 元，全天 2500 元')}
        </div>
        ${canEdit ? `<div class="form-actions"><span class="meta">${updated}</span><span class="form-error" role="alert"></span><button class="btn pri" type="submit">保存价格</button></div>` : `<p class="meta">${updated}</p>`}
        <h4 class="price-lines-title">写文案和回复时会这样说</h4>
        ${lines}
      </div>
    </form>
  </section>`;
}

async function load() {
  byId('error').hidden = true;
  try {
    const data = await api('/api/hotels');
    canEdit = data.can_edit;
    byId('hotels').innerHTML = data.items.length
      ? `<div class="stack">${data.items.map(hotel => profileCard(hotel) + pricesCard(hotel)).join('')}</div>`
      : '<div class="card"><div class="state"><b>还没有酒店资料</b>请联系管理员录入</div></div>';
  } catch (error) {
    byId('error-text').textContent = `酒店资料没有加载出来：${error.message}`;
    byId('error').hidden = false;
    byId('hotels').innerHTML = '';
  }
}

byId('hotels').addEventListener('submit', async event => {
  const form = event.target.closest('form.hotel-prices');
  if (!form) return;
  event.preventDefault();
  const error = form.querySelector('.form-error');
  const button = form.querySelector('button[type="submit"]');
  error.textContent = '';
  const rooms = [...form.querySelectorAll('tr[data-room]')].map(row => ({
    id: row.dataset.room,
    name: row.dataset.name,
    ...Object.fromEntries([...RATES.map(([field]) => field), 'price_note'].map(field => [field, row.querySelector(`[name="${field}"]`).value.trim()]))
  }));
  button.disabled = true;
  button.textContent = '正在保存';
  try {
    await api(`/api/hotels/${form.dataset.hotel}/prices`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        rooms,
        long_stay_price_note: form.querySelector('[name="long_stay_price_note"]').value,
        meeting_room_price_note: form.querySelector('[name="meeting_room_price_note"]').value
      })
    });
    await load();
    notice('价格已保存');
  } catch (failure) {
    error.textContent = failure.message;
    button.disabled = false;
    button.textContent = '保存价格';
  }
});

byId('retry').addEventListener('click', load);
await load();
