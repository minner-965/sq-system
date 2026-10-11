// 用真实数据库核对留资提交：进对应板块的待联系、记下来源、同一个电话再提交并到原来的记录。
// 全程在一个事务里，结束时回滚，不留下任何记录。
// 用法（在 services/demo-dashboard 下）：npm run check:lead-form
import assert from 'node:assert/strict';
import { createHostPool } from '../../src/db/pool.js';
import { listSubmissions, submitLead } from '../../src/leads/leadService.js';

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
const PHONE = '13900000001';

try {
  await client.query('BEGIN');
  const { rows: [form] } = await client.query(`
    SELECT f.code, t.platform, m.topic FROM leadgen.lead_forms f JOIN leadgen.publish_tasks t ON t.id = f.publish_task_id JOIN leadgen.materials m ON m.id = t.material_id LIMIT 1`);
  assert.ok(form, '先在“内容发布”里给一条内容生成过留资二维码');

  await submitLead(pool, { code: form.code, body: { contact_name: '核对用', phone: '139 0000 0001', need: '想找 100 平办公室', sector_key: 'office_retail', consent: true } });
  const { rows: [first] } = await client.query(`
    SELECT s.merged, s.source_platform, s.source_topic, c.company_name, c.data_origin, t.stage, t.sector_key, t.contact_phone, t.intended_property_id IS NOT NULL AS has_property,
           (SELECT content FROM leadgen.activities a WHERE a.track_id = t.id ORDER BY a.created_at DESC LIMIT 1) AS note,
           (SELECT title FROM leadgen.notifications ORDER BY created_at DESC LIMIT 1) AS alert
    FROM leadgen.lead_submissions s JOIN leadgen.companies c ON c.id = s.company_id JOIN leadgen.company_sector_tracks t ON t.id = s.track_id WHERE s.phone = $1`, [PHONE]);
  assert.equal(first.stage, 'new'); assert.equal(first.sector_key, 'office_retail'); assert.equal(first.contact_phone, PHONE);
  assert.equal(first.merged, false); assert.equal(first.data_origin, 'form_lead'); assert.equal(first.source_topic, form.topic);
  assert.match(first.note, /来源：扫码留资/); assert.match(first.note, /需求：想找 100 平办公室/);
  console.log(`提交一次：进了商铺写字楼的待联系，来源记为 ${first.source_platform}《${first.source_topic}》，${first.has_property ? '挂上了这条内容的房源' : '没有挂房源'}，提醒“${first.alert}” ✔`);

  await submitLead(pool, { code: form.code, body: { contact_name: '核对用', phone: PHONE, need: '再问一下酒店', sector_key: 'hotel_apartment', consent: true } });
  await submitLead(pool, { code: form.code, body: { contact_name: '核对用', phone: PHONE, sector_key: 'office_retail', consent: true } });
  const { rows: [counts] } = await client.query(`
    SELECT (SELECT count(*)::int FROM leadgen.companies WHERE source = 'lead_form' AND source_ref = $1) AS companies,
           (SELECT count(*)::int FROM leadgen.company_sector_tracks t JOIN leadgen.companies c ON c.id = t.company_id WHERE c.source_ref = $1 AND c.source = 'lead_form') AS tracks,
           (SELECT count(*)::int FROM leadgen.lead_submissions WHERE phone = $1) AS submissions,
           (SELECT count(*)::int FROM leadgen.lead_submissions WHERE phone = $1 AND merged) AS merged`, [PHONE]);
  assert.deepEqual(counts, { companies: 1, tracks: 2, submissions: 3, merged: 1 });
  console.log('同一个电话再提交两次（一次换了板块、一次同板块）：还是 1 个客户，2 个板块各一条跟进，同板块那次并到原记录 ✔');

  for (const [body, code] of [[{ contact_name: '', phone: PHONE, consent: true }, 'LEAD_NAME_INVALID'], [{ contact_name: '甲', phone: '12345', consent: true }, 'LEAD_PHONE_INVALID'],
    [{ contact_name: '甲', phone: PHONE, consent: false }, 'LEAD_CONSENT_REQUIRED'], [{ contact_name: '甲', phone: PHONE, consent: true, need: 'x'.repeat(301) }, 'LEAD_NEED_TOO_LONG']]) {
    await assert.rejects(() => submitLead(pool, { code: form.code, body }), error => error.code === code);
  }
  await assert.rejects(() => submitLead(pool, { code: 'zzzzzzzz', body: { contact_name: '甲', phone: PHONE, consent: true } }), error => error.code === 'FORM_NOT_FOUND');
  console.log('没填称呼、手机号不对、没勾同意、需求太长、链接不存在：都被拒绝 ✔');

  const visible = await listSubmissions(pool, { sectors: ['dining'] });
  assert.equal(visible.items.filter(item => item.phone === PHONE).length, 0);
  const mine = await listSubmissions(pool, { sectors: ['office_retail'] });
  assert.equal(mine.items.filter(item => item.phone === PHONE).length, 2);
  console.log('只负责餐饮的账号看不到这几条；负责商铺写字楼的能看到自己板块的 2 条 ✔');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows: [left] } = await real.query(`SELECT (SELECT count(*)::int FROM leadgen.lead_submissions) AS submissions, (SELECT count(*)::int FROM leadgen.companies WHERE source = 'lead_form') AS companies`);
  console.log('回滚后残留：', left);
  await real.end();
}
