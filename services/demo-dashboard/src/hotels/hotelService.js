// 酒店资料：酒店档案和各房型的对外房价。填了的价格就是可以告诉客户的，写文案和起草回复时引用；空着的不提。
import { findForbidden } from '../publishing/copywriter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
export const MAX_RATE = 99999;
const ROOM_NOTE_MAX = 60;
const HOTEL_NOTE_MAX = 200;
const RATE_FIELDS = { rack_rate: '门市价', weekend_rate: '周末价', corporate_rate: '协议价' };

/** Who may change hotel prices: administrators, and writers who look after the hotel and apartment sector. */
export function canEditHotel(user) {
  if (!user?.canWrite) return false;
  return user.role === 'ADMIN' || user.allSectors === true || (user.sectors || []).includes('hotel_apartment');
}

/** "" / null → null; otherwise a positive price with at most two decimals. */
export function parseRate(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim().replace(/[元¥￥\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw fail(400, 'HOTEL_RATE_INVALID', `${label}要填数字，最多两位小数`);
  const number = Number(text);
  if (number <= 0) throw fail(400, 'HOTEL_RATE_INVALID', `${label}要大于 0`);
  if (number > MAX_RATE) throw fail(400, 'HOTEL_RATE_INVALID', `${label}不能超过 ${MAX_RATE} 元`);
  return number;
}

function parseNote(value, label, max) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (text.length > max) throw fail(400, 'HOTEL_NOTE_TOO_LONG', `${label}不超过 ${max} 字`);
  const forbidden = findForbidden(text);
  if (forbidden) throw fail(400, 'HOTEL_NOTE_FORBIDDEN', `${label}里不能出现${forbidden}`);
  return text;
}

/** Checks the submitted prices; returns them cleaned. Room ids are checked against the hotel later. */
export function parseHotelPrices(body = {}) {
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const seen = new Set();
  const parsed = rooms.map(room => {
    if (!UUID.test(String(room?.id))) throw fail(400, 'HOTEL_ROOM_INVALID', '房型不正确，请刷新页面后再试');
    if (seen.has(room.id)) throw fail(400, 'HOTEL_ROOM_INVALID', '同一个房型提交了两次');
    seen.add(room.id);
    const name = String(room.name || '').trim() || '房型';
    const result = { id: room.id };
    for (const [field, label] of Object.entries(RATE_FIELDS)) result[field] = parseRate(room[field], `${name}的${label}`);
    result.price_note = parseNote(room.price_note, `${name}的价格说明`, ROOM_NOTE_MAX);
    return result;
  });
  return {
    long_stay_price_note: parseNote(body.long_stay_price_note, '长住价格', HOTEL_NOTE_MAX),
    meeting_room_price_note: parseNote(body.meeting_room_price_note, '会议室价格', HOTEL_NOTE_MAX),
    rooms: parsed
  };
}

const yuan = value => `${Number(value)} 元`;

/** One public price line per room type that has a price, e.g. “智能标准大床房（35 ㎡），每晚 299 元起，周末 349 元，企业协议价 259 元（含单早）”. */
export function hotelPriceLines(hotel) {
  const lines = [];
  for (const room of hotel.rooms || []) {
    const parts = [];
    if (room.rack_rate != null) parts.push(`每晚 ${yuan(room.rack_rate)}起`);
    if (room.weekend_rate != null) parts.push(`周末 ${yuan(room.weekend_rate)}`);
    if (room.corporate_rate != null) parts.push(`企业协议价 ${yuan(room.corporate_rate)}`);
    if (!parts.length) continue;
    const area = room.area_sqm != null ? `（${Number(room.area_sqm)} ㎡）` : '';
    lines.push(`房价：${room.name}${area}，${parts.join('，')}${room.price_note ? `（${room.price_note}）` : ''}`);
  }
  if (hotel.long_stay_price_note) lines.push(`长住价格：${hotel.long_stay_price_note}`);
  if (hotel.meeting_room_price_note) lines.push(`会议室价格：${hotel.meeting_room_price_note}`);
  return lines;
}

/** True when at least one public price is filled in. */
export const hasHotelPrices = hotel => hotelPriceLines(hotel).length > 0;

/** The facts a hotel post may use: the hotel profile plus whatever public prices are filled in. */
export function hotelFactLines(hotel) {
  if (!hotel) return [];
  const list = value => (value || []).join('；');
  const rooms = (hotel.rooms || []).map(room => `${room.name}${room.area_sqm != null ? `（${Number(room.area_sqm)} ㎡）` : ''}`);
  return [
    `酒店：${hotel.name}${hotel.brand_note ? `，${hotel.brand_note}` : ''}`,
    hotel.address ? `酒店地址：${hotel.address}` : null,
    hotel.room_count ? `客房 ${hotel.room_count} 间${hotel.opened_year ? `，${hotel.opened_year} 年开业` : ''}` : null,
    rooms.length ? `房型：${rooms.join('；')}` : null,
    hotel.room_highlights?.length ? `客房特点：${list(hotel.room_highlights)}` : null,
    hotel.facilities?.length ? `设施：${list(hotel.facilities)}` : null,
    hotel.location_notes?.length ? `位置：${list(hotel.location_notes)}` : null,
    hotel.meeting_room_area_sqm ? `会议室 ${Number(hotel.meeting_room_area_sqm)} ㎡，可容纳 ${hotel.meeting_room_capacity_min}–${hotel.meeting_room_capacity_max} 人` : null,
    hotel.check_in_time ? `入住 ${hotel.check_in_time}，退房 ${hotel.check_out_time}` : null,
    ...hotelPriceLines(hotel)
  ].filter(Boolean);
}

const HOTEL_COLUMNS = `h.id, h.key, h.name, h.brand_note, h.address, h.phone, h.room_count, h.opened_year, h.check_in_time, h.check_out_time,
  h.location_notes, h.room_highlights, h.facilities, h.meeting_room_area_sqm, h.meeting_room_capacity_min, h.meeting_room_capacity_max,
  h.target_guests, h.long_stay_price_note, h.meeting_room_price_note, h.prices_updated_at, u.display_name AS prices_updated_by_name`;

const numberOrNull = value => (value == null ? null : Number(value));

/** Every hotel with its room types and prices. */
export async function listHotels(db) {
  const { rows: hotels } = await db.query(`SELECT ${HOTEL_COLUMNS} FROM leadgen.hotels h LEFT JOIN leadgen.users u ON u.id = h.prices_updated_by ORDER BY h.name`);
  if (!hotels.length) return [];
  const { rows: rooms } = await db.query(`
    SELECT id, hotel_id, name, area_sqm, features, rack_rate, weekend_rate, corporate_rate, price_note, sort_order
    FROM leadgen.hotel_room_types WHERE hotel_id = ANY($1) ORDER BY sort_order, name`, [hotels.map(hotel => hotel.id)]);
  return hotels.map(hotel => ({
    ...hotel,
    meeting_room_area_sqm: numberOrNull(hotel.meeting_room_area_sqm),
    rooms: rooms.filter(room => room.hotel_id === hotel.id).map(({ hotel_id: _hotel, ...room }) => ({
      ...room,
      area_sqm: numberOrNull(room.area_sqm),
      rack_rate: numberOrNull(room.rack_rate),
      weekend_rate: numberOrNull(room.weekend_rate),
      corporate_rate: numberOrNull(room.corporate_rate)
    }))
  }));
}

/** The hotel posts and replies talk about (there is one: 宜尚酒店). */
export async function primaryHotel(db) {
  const [hotel] = await listHotels(db);
  return hotel || null;
}

/** Fact lines for hotel posts, prices included when filled in. */
export async function loadHotelFacts(db) {
  return hotelFactLines(await primaryHotel(db));
}

/** Saves the public prices of one hotel. Room types not in the request keep their prices. */
export async function updateHotelPrices(pool, { hotelId, body, user }) {
  if (!canEditHotel(user)) throw fail(403, 'HOTEL_EDIT_FORBIDDEN', '当前账号不能修改酒店价格');
  if (!UUID.test(String(hotelId))) throw fail(404, 'HOTEL_NOT_FOUND', '没有找到这家酒店');
  const input = parseHotelPrices(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [hotel] } = await client.query('SELECT id FROM leadgen.hotels WHERE id = $1 FOR UPDATE', [hotelId]);
    if (!hotel) throw fail(404, 'HOTEL_NOT_FOUND', '没有找到这家酒店');
    const { rows: own } = await client.query('SELECT id FROM leadgen.hotel_room_types WHERE hotel_id = $1', [hotelId]);
    const ownIds = new Set(own.map(row => row.id));
    if (input.rooms.some(room => !ownIds.has(room.id))) throw fail(400, 'HOTEL_ROOM_INVALID', '房型不正确，请刷新页面后再试');
    for (const room of input.rooms) {
      await client.query(`
        UPDATE leadgen.hotel_room_types SET rack_rate = $2, weekend_rate = $3, corporate_rate = $4, price_note = $5, updated_at = now()
        WHERE id = $1`, [room.id, room.rack_rate, room.weekend_rate, room.corporate_rate, room.price_note]);
    }
    await client.query(`
      UPDATE leadgen.hotels SET long_stay_price_note = $2, meeting_room_price_note = $3, prices_updated_at = now(), prices_updated_by = $4, updated_at = now()
      WHERE id = $1`, [hotelId, input.long_stay_price_note, input.meeting_room_price_note, user.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return (await listHotels(pool)).find(hotel => hotel.id === hotelId);
}
