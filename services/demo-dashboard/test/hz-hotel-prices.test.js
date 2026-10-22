import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canEditHotel, hotelFactLines, hotelPriceLines, parseHotelPrices, parseRate, updateHotelPrices } from '../src/hotels/hotelService.js';
import { asksAboutHotel, hotelReplyFacts } from '../src/inbox/inboxService.js';
import { buildPrompt, findForbidden } from '../src/publishing/copywriter.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const HOTEL_ID = '33333333-3333-4333-8333-333333333333';
const hotel = {
  id: HOTEL_ID, name: '宜尚酒店', brand_note: '中端酒店', address: '黄埔区长贝二路', room_count: 114, opened_year: 2025,
  check_in_time: '14:00 后', check_out_time: '次日 12:00 前', location_notes: ['近演艺中心'], room_highlights: [], facilities: ['健身房'],
  meeting_room_area_sqm: 200, meeting_room_capacity_min: 75, meeting_room_capacity_max: 110,
  long_stay_price_note: null, meeting_room_price_note: null,
  rooms: [
    { id: ROOM_A, name: '智能标准大床房', area_sqm: 35, rack_rate: null, weekend_rate: null, corporate_rate: null, price_note: null },
    { id: ROOM_B, name: '山景双床房', area_sqm: null, rack_rate: null, weekend_rate: null, corporate_rate: null, price_note: null }
  ]
};
const priced = {
  ...hotel, long_stay_price_note: '月租 3500 元起', meeting_room_price_note: '半天 1500 元',
  rooms: [{ ...hotel.rooms[0], rack_rate: 299, weekend_rate: 349, corporate_rate: 259, price_note: '含单早' }, hotel.rooms[1]]
};

test('hotel prices must be positive numbers with at most two decimals', () => {
  assert.equal(parseRate('', '门市价'), null);
  assert.equal(parseRate(null, '门市价'), null);
  assert.equal(parseRate(' 299 ', '门市价'), 299);
  assert.equal(parseRate('299.5元', '门市价'), 299.5);
  assert.throws(() => parseRate('abc', '门市价'), { code: 'HOTEL_RATE_INVALID', message: '门市价要填数字，最多两位小数' });
  assert.throws(() => parseRate('0', '门市价'), { message: '门市价要大于 0' });
  assert.throws(() => parseRate('-5', '门市价'), { code: 'HOTEL_RATE_INVALID' });
  assert.throws(() => parseRate('1.234', '门市价'), { code: 'HOTEL_RATE_INVALID' });
  assert.throws(() => parseRate('100000', '门市价'), { message: '门市价不能超过 99999 元' });
});

test('submitted prices are cleaned and checked room by room', () => {
  const parsed = parseHotelPrices({ rooms: [{ id: ROOM_A, name: '智能标准大床房', rack_rate: '299', weekend_rate: '', corporate_rate: '259', price_note: ' 含单早 ' }], long_stay_price_note: '  ', meeting_room_price_note: '半天 1500 元' });
  assert.deepEqual(parsed, { long_stay_price_note: null, meeting_room_price_note: '半天 1500 元', rooms: [{ id: ROOM_A, rack_rate: 299, weekend_rate: null, corporate_rate: 259, price_note: '含单早' }] });
  assert.throws(() => parseHotelPrices({ rooms: [{ id: 'x' }] }), { code: 'HOTEL_ROOM_INVALID' });
  assert.throws(() => parseHotelPrices({ rooms: [{ id: ROOM_A }, { id: ROOM_A }] }), { message: '同一个房型提交了两次' });
  assert.throws(() => parseHotelPrices({ rooms: [{ id: ROOM_A, name: '影音房', corporate_rate: '便宜' }] }), { message: '影音房的协议价要填数字，最多两位小数' });
  assert.throws(() => parseHotelPrices({ rooms: [{ id: ROOM_A, price_note: '底价可谈' }] }), { code: 'HOTEL_NOTE_FORBIDDEN' });
  assert.throws(() => parseHotelPrices({ long_stay_price_note: '长'.repeat(201) }), { message: '长住价格不超过 200 字' });
});

test('only administrators and writers on the hotel sector may change prices', () => {
  assert.equal(canEditHotel({ role: 'ADMIN', canWrite: true, sectors: [] }), true);
  assert.equal(canEditHotel({ role: 'LEASING', canWrite: true, sectors: ['hotel_apartment'] }), true);
  assert.equal(canEditHotel({ role: 'LEASING', canWrite: true, sectors: ['office_retail'] }), false);
  assert.equal(canEditHotel({ role: 'BOSS', canWrite: false, allSectors: true, sectors: ['hotel_apartment'] }), false);
  assert.equal(canEditHotel(null), false);
});

test('only filled prices become public price lines', () => {
  assert.deepEqual(hotelPriceLines(hotel), []);
  assert.deepEqual(hotelPriceLines(priced), [
    '房价：智能标准大床房（35 ㎡），每晚 299 元起，周末 349 元，企业协议价 259 元（含单早）',
    '长住价格：月租 3500 元起',
    '会议室价格：半天 1500 元'
  ]);
  const facts = hotelFactLines(priced);
  assert.equal(facts[0], '酒店：宜尚酒店，中端酒店');
  assert.ok(facts.includes('房型：智能标准大床房（35 ㎡）；山景双床房'));
  assert.ok(facts.includes('房价：智能标准大床房（35 ㎡），每晚 299 元起，周末 349 元，企业协议价 259 元（含单早）'));
  assert.ok(!facts.some(line => line.includes('山景双床房，每晚')));
  assert.deepEqual(hotelFactLines(null), []);
  // 对外价格不会被当成底价拦下来。
  assert.equal(findForbidden(facts.join('\n'), [35]), null);
});

test('hotel copy quotes the filled prices and only says 欢迎咨询 when there are none', () => {
  const material = { topic: '演唱会住哪里', content_type: 'hotel', note: null, image_count: 3, video_count: 0 };
  const [withPrices, facts] = buildPrompt({ platform: 'douyin', material: { ...material, venue_lines: hotelFactLines(priced) }, property: null, project: null });
  assert.match(facts.content, /房价：智能标准大床房（35 ㎡），每晚 299 元起/);
  assert.match(withPrices.content, /不要再写“价格欢迎咨询”/);
  assert.match(withPrices.content, /不写任何优惠价、最低价、底价/);
  const [without] = buildPrompt({ platform: 'douyin', material: { ...material, venue_lines: hotelFactLines(hotel) }, property: null, project: null });
  assert.match(without.content, /资料里没有酒店房价，房价只写“欢迎咨询”/);
  const [office] = buildPrompt({ platform: 'douyin', material: { ...material, content_type: 'property' }, property: null, project: null });
  assert.doesNotMatch(office.content, /酒店房价|酒店价格/);
});

test('reply drafts get the hotel prices for stay questions, not for dining or office ones', async () => {
  assert.equal(asksAboutHotel({ content: '大床房一晚多少钱', intent: 'chat' }, null), true);
  assert.equal(asksAboutHotel({ content: '周六两个人', intent: 'booking' }, null), true);
  assert.equal(asksAboutHotel({ content: '周六订个包间', intent: 'booking' }, null), false);
  assert.equal(asksAboutHotel({ content: '1307 还租吗', intent: 'inquiry' }, null), false);
  assert.equal(asksAboutHotel({ content: '多少钱', intent: 'inquiry' }, { content_type: 'hotel' }), true);
  assert.equal(asksAboutHotel({ content: '酒店在哪', intent: 'chat' }, { content_type: 'property' }), false);

  const db = rows => ({ async query(sql) { return { rows: /FROM leadgen\.hotels h/.test(sql) ? [{ ...rows, rooms: undefined }] : rows.rooms.map(room => ({ ...room, hotel_id: HOTEL_ID })) }; } });
  const lines = await hotelReplyFacts(db(priced));
  assert.equal(lines[0], '酒店：宜尚酒店，黄埔区长贝二路');
  assert.ok(lines.includes('房价：智能标准大床房（35 ㎡），每晚 299 元起，周末 349 元，企业协议价 259 元（含单早）'));
  assert.match((await hotelReplyFacts(db(hotel))).at(-1), /没有对外报价/);

  const service = readFileSync(path.join(appRoot, 'src', 'inbox', 'inboxService.js'), 'utf8');
  assert.match(service, /酒店房价只报事实里“房价”“长住价格”“会议室价格”给出的/);
});

test('prices are saved in one transaction and only for the hotel\'s own room types', async () => {
  const user = { id: 'u1', role: 'LEASING', canWrite: true, sectors: ['hotel_apartment'] };
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
      if (/FROM leadgen\.hotels WHERE id/.test(sql)) return { rows: [{ id: HOTEL_ID }] };
      if (/SELECT id FROM leadgen\.hotel_room_types/.test(sql)) return { rows: [{ id: ROOM_A }] };
      if (/FROM leadgen\.hotels h/.test(sql)) return { rows: [{ ...priced, rooms: undefined }] };
      if (/FROM leadgen\.hotel_room_types WHERE hotel_id = ANY/.test(sql)) return { rows: [{ ...priced.rooms[0], hotel_id: HOTEL_ID }] };
      return { rows: [], params };
    },
    release() {}
  };
  const pool = { connect: async () => client, query: client.query };
  const saved = await updateHotelPrices(pool, { hotelId: HOTEL_ID, user, body: { rooms: [{ id: ROOM_A, rack_rate: '299' }] } });
  assert.equal(saved.rooms[0].rack_rate, 299);
  assert.deepEqual(calls.slice(0, 6), ['BEGIN', 'SELECT id', 'SELECT id', 'UPDATE leadgen.hotel_room_types', 'UPDATE leadgen.hotels', 'COMMIT']);

  calls.length = 0;
  await assert.rejects(() => updateHotelPrices(pool, { hotelId: HOTEL_ID, user, body: { rooms: [{ id: ROOM_B, rack_rate: '199' }] } }), { code: 'HOTEL_ROOM_INVALID' });
  assert.equal(calls.at(-1), 'ROLLBACK');
  await assert.rejects(() => updateHotelPrices(pool, { hotelId: HOTEL_ID, user: { ...user, sectors: ['dining'] }, body: {} }), { status: 403, code: 'HOTEL_EDIT_FORBIDDEN' });
  await assert.rejects(() => updateHotelPrices(pool, { hotelId: 'nope', user, body: {} }), { status: 404 });
});

test('the price columns arrive in a new idempotent migration', () => {
  const sql = readFileSync(path.resolve(appRoot, '..', '..', 'database', 'migrations', '097_hz_hotel_prices.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS weekend_rate numeric\(8,2\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS long_stay_price_note text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS meeting_room_price_note text/);
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'hotel_room_types_prices_positive'\)/);
  assert.doesNotMatch(sql, /DROP |floor_price/);
});
