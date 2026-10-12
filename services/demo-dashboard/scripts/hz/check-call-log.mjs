// 用真实数据库核对“打电话并记录”：核实结果、跟进记录的方式、阶段、下次跟进时间。事务里跑，结束回滚。
// 用法（在 services/demo-dashboard 下）：npm run check:call-log
import assert from 'node:assert/strict';
import { createHostPool } from '../../src/db/pool.js';
import { updateTrack } from '../../src/customers/customerService.js';

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
  const { rows: [track] } = await client.query(`SELECT id FROM leadgen.company_sector_tracks WHERE stage = 'new' AND sector_key = 'office_retail' LIMIT 1`);
  assert.ok(track, '需要一条待联系的客户');
  const last = () => client.query(`SELECT activity_type, content, snapshot->>'stage' AS stage_then FROM leadgen.activities WHERE track_id = $1 ORDER BY created_at DESC, id LIMIT 3`, [track.id]).then(result => result.rows);

  await updateTrack(pool, { trackId: track.id, user, changes: { demand_check: 'unreachable', contact_via: 'call' } });
  await updateTrack(pool, { trackId: track.id, user, changes: { demand_check: 'unreachable', contact_via: 'call' } });
  let rows = await last();
  assert.equal(rows.filter(row => row.activity_type === 'call' && row.content === '联系后核实：没联系上').length, 2);
  console.log('连着两次没联系上：记了两条电话记录 ✔');

  const next = new Date(Date.now() + 3 * 86400000).toISOString();
  const { track: updated } = await updateTrack(pool, { trackId: track.id, user, changes: { demand_check: 'confirmed', demand_check_note: '想要 150 平，年底前搬', contact_via: 'call', stage: 'contacted', next_follow_up_at: next } });
  assert.equal(updated.stage, 'contacted'); assert.equal(updated.demand_check, 'confirmed'); assert.equal(updated.demand_check_name, '确有需求');
  assert.ok(updated.demand_checked_at); assert.equal(new Date(updated.next_follow_up_at).toISOString(), next);
  rows = await last();
  assert.ok(rows.some(row => row.activity_type === 'call' && row.content === '联系后核实：确有需求（想要 150 平，年底前搬）'));
  assert.ok(rows.some(row => row.activity_type === 'stage' && row.content.includes('待联系 → 已联系')));
  console.log('第三次打通：核实结果、对方原话、阶段改为已联系、下次跟进时间都存上了，跟进记录里有电话和阶段变化各一条 ✔');

  await assert.rejects(() => updateTrack(pool, { trackId: track.id, user, changes: { demand_check: 'maybe' } }), error => error.code === 'TRACK_FIELD_INVALID');
  console.log('不认识的核实结果被拒绝 ✔');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows: [left] } = await real.query(`SELECT count(*)::int AS n FROM leadgen.company_sector_tracks WHERE demand_check IS NOT NULL`);
  console.log('回滚后记了核实结果的客户数：', left.n);
  await real.end();
}
