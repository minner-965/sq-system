// 用真实数据库核对“中标工程转入跟进”。事务里跑，结束回滚，不留下客户。
// 用法（在 services/demo-dashboard 下）：npm run check:tender-follow
import assert from 'node:assert/strict';
import { createHostPool } from '../../src/db/pool.js';
import { getCompanyProfile } from '../../src/customers/customerService.js';
import { dismissTender, followTender, listTenders } from '../../src/discovery/tenders.js';

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
try {
  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`SELECT id, display_name FROM leadgen.users WHERE username = 'admin'`);
  const user = { id: admin.id, role: 'ADMIN', displayName: admin.display_name, sectors: ['office_retail', 'hotel_apartment', 'dining'] };
  const before = await listTenders(pool, { status: 'open', kind: 'construction' });
  assert.ok(before.items.length >= 2, '需要至少两条待看的施工类中标');
  const [first, second] = before.items;

  const result = await followTender(pool, { tenderId: first.id, user });
  assert.deepEqual(result.sectors, ['hotel_apartment', 'dining']);
  const profile = await getCompanyProfile(pool, { companyId: result.company_id, user });
  assert.equal(profile.company.company_name, first.winner_name);
  assert.equal(profile.tracks.filter(track => track.stage === 'new').length, 2);
  assert.equal(profile.demand.level, 'medium');
  assert.equal(profile.demand.items[0].type_name, '本地项目进场');
  assert.ok(profile.demand.items[0].source_url.startsWith('https://ygp.gdzwfw.gov.cn/'));
  assert.ok(profile.activities.every(item => item.content.includes('来源：黄埔区工程中标结果')));
  console.log(`转入跟进：${first.winner_name} 进了酒店公寓和餐饮两个板块的待联系，依据“${profile.demand.items[0].evidence}”，出处是交易平台的公告 ✔`);

  await assert.rejects(() => followTender(pool, { tenderId: first.id, user }), error => error.code === 'TENDER_ALREADY_FOLLOWED');
  await assert.rejects(() => followTender(pool, { tenderId: second.id, user: { ...user, sectors: ['office_retail'] } }), error => error.code === 'SECTOR_FORBIDDEN');
  console.log('同一条不能转两次；只负责商铺写字楼的账号不能转 ✔');

  await dismissTender(pool, { tenderId: second.id, user });
  const after = await listTenders(pool, { status: 'open', kind: 'construction' });
  assert.equal(after.items.length, before.items.length - 2);
  await assert.rejects(() => dismissTender(pool, { tenderId: second.id, user }), error => error.code === 'TENDER_ALREADY_HANDLED');
  console.log('标为不合适的从待看里消失，不能重复处理 ✔');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows: [left] } = await real.query(`SELECT (SELECT count(*)::int FROM leadgen.companies WHERE source = 'tender') AS companies, (SELECT count(*)::int FROM leadgen.tender_awards WHERE company_id IS NOT NULL OR dismissed) AS handled`);
  console.log('回滚后残留：', left);
  await real.end();
}
