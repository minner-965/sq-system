// 用真实数据库核对“酒店对外房价”：录价格、校验、酒店内容的资料里带上价格、收件箱回复能报价。事务里跑，结束回滚。
// 097 迁移还没执行时，在事务里先执行一遍（随回滚撤销）。
// 配了大模型时再各生成一条酒店文案和一条订房私信的回复草稿，看价格有没有用上（也在事务里，回滚后不留记录）。
// 用法（在 services/demo-dashboard 下）：npm run check:hotel-prices      不调大模型：npm run check:hotel-prices -- --no-llm
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostPool } from '../../src/db/pool.js';
import { hotelFacts } from '../../src/publishing/publishingService.js';
import { findForbidden, writeDraft } from '../../src/publishing/copywriter.js';
import { listHotels, updateHotelPrices } from '../../src/hotels/hotelService.js';
import { draftReply, hotelReplyFacts } from '../../src/inbox/inboxService.js';
import { createLlmClient } from '../../src/llm/llmClient.js';

const migrationFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'database', 'migrations', '097_hz_hotel_prices.sql');
const real = createHostPool();
const client = await real.connect();
const inner = {
  query: (sql, params) => {
    const text = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
    if (text === 'BEGIN') return client.query('SAVEPOINT step');
    if (text === 'COMMIT') return client.query('RELEASE SAVEPOINT step');
    if (text === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT step');
    return client.query(sql, params);
  },
  release() {}
};
const pool = { connect: async () => inner, query: (sql, params) => client.query(sql, params) };
const llm = createLlmClient();
const useLlm = llm.configured && !process.argv.includes('--no-llm');
try {
  await client.query('BEGIN');
  const { rows: [applied] } = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'leadgen' AND table_name = 'hotel_room_types' AND column_name = 'weekend_rate'`);
  if (!applied) {
    await client.query(await readFile(migrationFile, 'utf8'));
    console.log('097 迁移还没执行，已在本次事务里执行（回滚后撤销）');
  } else console.log('097 迁移已执行');

  const { rows: [admin] } = await client.query(`SELECT id, display_name FROM leadgen.users WHERE username = 'admin'`);
  const user = { id: admin.id, role: 'ADMIN', canWrite: true, allSectors: true, sectors: ['office_retail', 'hotel_apartment', 'dining'] };
  const [hotel] = await listHotels(pool);
  assert.ok(hotel, '库里要有酒店档案');
  const standard = hotel.rooms.find(room => room.name === '智能标准大床房');
  const twin = hotel.rooms.find(room => room.name === '山景双床房');
  assert.ok(standard && twin, '要有智能标准大床房和山景双床房');

  const before = await hotelFacts(pool);
  assert.ok(!before.some(line => line.startsWith('房价：')), '没录价格前资料里不该有房价');
  console.log(`录价格前：酒店资料 ${before.length} 行，没有房价 ✔`);

  const saved = await updateHotelPrices(pool, { hotelId: hotel.id, user, body: {
    rooms: [
      { id: standard.id, name: standard.name, rack_rate: '299', weekend_rate: '349', corporate_rate: '259', price_note: '含单早' },
      { id: twin.id, name: twin.name, rack_rate: '329', weekend_rate: '', corporate_rate: '', price_note: '' }
    ],
    long_stay_price_note: '月租 3500 元起，含水电',
    meeting_room_price_note: '半天 1500 元，全天 2500 元'
  } });
  assert.equal(saved.rooms.find(room => room.id === standard.id).rack_rate, 299);
  assert.equal(saved.prices_updated_by_name, admin.display_name);
  const facts = await hotelFacts(pool);
  const expected = [
    '房价：智能标准大床房（35 ㎡），每晚 299 元起，周末 349 元，企业协议价 259 元（含单早）',
    '房价：山景双床房，每晚 329 元起',
    '长住价格：月租 3500 元起，含水电',
    '会议室价格：半天 1500 元，全天 2500 元'
  ];
  for (const line of expected) assert.ok(facts.includes(line), `资料里缺：${line}`);
  assert.ok(!facts.some(line => /山景大床房，每晚|臻享浴缸房，每晚/.test(line)), '没填价格的房型不该出现价格');
  const { rows: floors } = await client.query('SELECT floor_price_per_sqm FROM leadgen.leasing_policy WHERE floor_price_per_sqm IS NOT NULL');
  const floorPrices = floors.map(row => Number(row.floor_price_per_sqm));
  assert.equal(findForbidden(facts.join('\n'), floorPrices), null);
  console.log('录价格后，酒店内容的资料里多了这几行（没填的房型不出现，底价检查照常通过）：');
  for (const line of expected) console.log(`  ${line}`);

  await assert.rejects(() => updateHotelPrices(pool, { hotelId: hotel.id, user, body: { rooms: [{ id: standard.id, name: standard.name, rack_rate: '二百九' }] } }),
    error => error.code === 'HOTEL_RATE_INVALID' && error.message === '智能标准大床房的门市价要填数字，最多两位小数');
  await assert.rejects(() => updateHotelPrices(pool, { hotelId: hotel.id, user, body: { rooms: [{ id: standard.id, price_note: '底价 199' }] } }), error => error.code === 'HOTEL_NOTE_FORBIDDEN');
  await assert.rejects(() => updateHotelPrices(pool, { hotelId: hotel.id, user: { ...user, role: 'LEASING', allSectors: false, sectors: ['office_retail'] }, body: {} }), error => error.code === 'HOTEL_EDIT_FORBIDDEN');
  const { rows: [still] } = await client.query('SELECT rack_rate FROM leadgen.hotel_room_types WHERE id = $1', [standard.id]);
  assert.equal(Number(still.rack_rate), 299);
  console.log('填错数字、价格说明里写底价、只管商铺写字楼的账号改价格，都被拦下，原价格不变 ✔');

  const reply = await hotelReplyFacts(pool);
  assert.ok(reply.includes(expected[0]));
  console.log('收件箱：问订房的消息起草回复时，资料里带上了房价 ✔');

  if (useLlm) {
    const material = { topic: '去宝能演艺中心看演唱会，住哪里方便', content_type: 'hotel', note: null, image_count: 3, video_count: 0, venue_lines: facts };
    const { rows: [project] } = await client.query('SELECT address, transport_notes, target_industries, parking_monthly_fee, parking_hourly_fee, parking_free_hours FROM leadgen.project_profile WHERE id = 1');
    const draft = await writeDraft({ llm, platform: 'douyin', material, property: null, project, floorPrices });
    console.log(`\n大模型写的抖音文案（${llm.model}）：\n标题：${draft.title}\n正文：${draft.body}\n话题：${draft.topics.join('、')}\n问题：${draft.problems.join('；') || '无'}${draft.removed.length ? `\n校对删掉：${draft.removed.join('；')}` : ''}`);
    assert.equal(findForbidden(`${draft.title}\n${draft.body}`, floorPrices), null);
    console.log(/299|329|259|349/.test(draft.body) ? '文案里用上了录入的房价 ✔' : '这一版文案没有写价格（模型选了别的卖点）');
    assert.doesNotMatch(draft.body, /价格欢迎咨询/);

    const { rows: [message] } = await client.query(`
      INSERT INTO leadgen.interaction_messages (platform, kind, platform_message_id, sender_name, content, sent_at, source, intent)
      VALUES ('douyin', 'direct_message', 'check-hotel-prices', '自测', '你好，演唱会那天想订个大床房，一晚多少钱？公司出差有协议价吗', now(), 'manual', 'booking') RETURNING id`);
    const drafted = await draftReply(pool, { messageId: message.id, llm });
    console.log(`\n订房私信的回复草稿：${drafted.reply}`);
    console.log(/299|259/.test(drafted.reply) ? '回复里报了录入的房价 ✔' : '这一版回复没有报价');
  } else {
    console.log(llm.configured ? '按 --no-llm 跳过大模型' : '没有配置大模型，跳过生成文案');
  }
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows: [left] } = await real.query(`
    SELECT (SELECT count(*)::int FROM leadgen.interaction_messages WHERE platform_message_id = 'check-hotel-prices') AS messages,
           (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'leadgen' AND table_name = 'hotel_room_types' AND column_name = 'weekend_rate') AS weekend_rate_column,
           (SELECT count(*)::int FROM leadgen.hotel_room_types WHERE rack_rate IS NOT NULL) AS priced_rooms`);
  console.log('回滚后残留：', left);
  await real.end();
}
