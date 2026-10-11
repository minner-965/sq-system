import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOST_REASON_NAME, STAGES, STAGE_NAME, matchPenalty, updateTrack } from '../src/customers/customerService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = fields => ({ area_sqm: 73, list_rent_per_sqm: 30, management_fee_per_sqm: 10, ...fields });
const need = fields => ({ need_area_min: null, need_area_max: null, need_budget_per_sqm: null, need_open_flame: false, ...fields });

test('a unit inside the asked area and budget fits, others are ranked by how far off they are', () => {
  const asked = need({ need_area_min: 60, need_area_max: 100, need_budget_per_sqm: 42 });
  const fit = matchPenalty(asked, unit());
  assert.equal(fit.penalty, 0);
  assert.deepEqual(fit.reasons, ['面积 73 ㎡，在 60–100 ㎡ 的需求内', '挂牌 40 元/㎡·月（含管理费），在预算内']);

  const big = matchPenalty(asked, unit({ area_sqm: 193 }));
  const slightlyBig = matchPenalty(asked, unit({ area_sqm: 110 }));
  assert.ok(big.penalty > slightlyBig.penalty && slightlyBig.penalty > 0);
  assert.match(big.reasons[0], /比 60–100 ㎡ 的需求大/);

  const pricey = matchPenalty(need({ need_budget_per_sqm: 35 }), unit());
  assert.ok(pricey.penalty > 0);
  assert.deepEqual(pricey.reasons, ['面积 73 ㎡', '挂牌 40 元/㎡·月（含管理费），比预算高 5 元']);
  assert.equal(matchPenalty(need(), unit()).penalty, 0);
});

test('stages cover the whole path and every lost reason has a label', () => {
  assert.deepEqual(STAGES, ['new', 'contacted', 'viewing', 'negotiating', 'signed', 'lost']);
  assert.deepEqual(STAGES.map(stage => STAGE_NAME[stage]), ['待联系', '已联系', '已看场', '洽谈中', '已签约', '已放弃']);
  assert.deepEqual(Object.values(LOST_REASON_NAME), ['价格贵', '位置不合适', '格局不合适', '其他']);
});

// Just enough of a database to drive updateTrack: one track, one unit, the office floor price.
function trackPool({ track, floor = '35.00' }) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/FOR UPDATE OF t/.test(sql)) return { rows: [{ ...track }] };
      if (/FROM leadgen\.properties WHERE id/.test(sql)) return { rows: [{ id: params[0], property_type: 'office', status: 'available', building: '1栋', unit_no: '1307' }] };
      if (/FROM leadgen\.leasing_policy/.test(sql)) return { rows: [{ floor_price_per_sqm: floor }] };
      if (/^\s*SELECT t\.id/.test(sql)) return { rows: [{ ...track, stage: 'x' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { queries, connect: async () => client };
}

const TRACK = {
  id: '11111111-1111-4111-8111-111111111111', company_id: '22222222-2222-4222-8222-222222222222', company_name: '示例公司',
  sector_key: 'office_retail', stage: 'negotiating', intended_property_id: '33333333-3333-4333-8333-333333333333',
  intended_price: null, below_floor_price: false, need_property_type: null, lost_reason_category: null
};
const leasing = { id: '44444444-4444-4444-8444-444444444444', role: 'LEASING', displayName: '陈经理', sectors: ['office_retail'] };
const admin = { ...leasing, role: 'ADMIN', displayName: 'Simon' };
const change = (pool, user, changes) => updateTrack(pool, { trackId: TRACK.id, user, changes });

test('a price under the floor warns, notifies administrators and never returns the floor', async () => {
  const pool = trackPool({ track: TRACK });
  const result = await change(pool, leasing, { intended_price: 33 });
  assert.equal(result.price_warning, true);
  assert.doesNotMatch(JSON.stringify(result), /35|floor_price_per_sqm/);
  const notification = pool.queries.find(query => /INSERT INTO leadgen\.notifications/.test(query.sql));
  assert.match(notification.sql, /'admin', 'below_floor_price'/);
  assert.match(notification.params[0], /示例公司，意向价 33 元/);
  assert.doesNotMatch(notification.params.join(' '), /35/);

  const atFloor = trackPool({ track: TRACK });
  assert.equal((await change(atFloor, leasing, { intended_price: 35 })).price_warning, false);
  assert.equal(atFloor.queries.some(query => /INSERT INTO leadgen\.notifications/.test(query.sql)), false);
});

test('only an administrator can sign a deal priced under the floor', async () => {
  const below = { ...TRACK, intended_price: '33.00', below_floor_price: true };
  await assert.rejects(change(trackPool({ track: below }), leasing, { stage: 'signed' }), { code: 'BELOW_FLOOR_NEEDS_ADMIN', status: 403 });
  assert.equal((await change(trackPool({ track: below }), admin, { stage: 'signed' })).price_warning, true);
  assert.equal((await change(trackPool({ track: { ...TRACK, intended_price: '38.00' } }), leasing, { stage: 'signed' })).price_warning, false);
});

test('giving up needs a reason, signing needs a unit, other sectors are refused', async () => {
  await assert.rejects(change(trackPool({ track: TRACK }), leasing, { stage: 'lost' }), { code: 'LOST_REASON_REQUIRED', status: 400 });
  const pool = trackPool({ track: TRACK });
  await change(pool, leasing, { stage: 'lost', lost_reason_category: 'price', lost_reason: '预算不够' });
  const activity = pool.queries.find(query => /INSERT INTO leadgen\.activities/.test(query.sql));
  assert.equal(activity.params[1], '洽谈中 → 已放弃，原因：价格贵（预算不够）');

  await assert.rejects(change(trackPool({ track: { ...TRACK, intended_property_id: null } }), leasing, { stage: 'signed' }), { code: 'SIGNED_NEEDS_PROPERTY' });
  await assert.rejects(change(trackPool({ track: { ...TRACK, sector_key: 'dining' } }), leasing, { stage: 'contacted' }), { code: 'SECTOR_FORBIDDEN', status: 403 });
  await assert.rejects(change(trackPool({ track: TRACK }), leasing, { need_area_min: 100, need_area_max: 60 }), { code: 'TRACK_FIELD_INVALID' });
  await assert.rejects(change(trackPool({ track: TRACK }), leasing, { stage: 'won' }), { code: 'STAGE_INVALID' });
});

test('follow-up writes need an account that can edit, and no response carries the floor column', () => {
  const routes = readFileSync(path.join(appRoot, 'src', 'customers', 'customerRoutes.js'), 'utf8');
  assert.match(routes, /router\.patch\('\/tracks\/:trackId', \.\.\.write/);
  assert.match(routes, /router\.post\('\/tracks\/:trackId\/activities', \.\.\.write/);
  const service = readFileSync(path.join(appRoot, 'src', 'customers', 'customerService.js'), 'utf8');
  // The floor is read once, inside updateTrack, only to compare.
  assert.equal(service.match(/floor_price_per_sqm/g).length, 3);
  assert.doesNotMatch(service.match(/const TRACK_COLUMNS = `[^`]+`/)[0], /floor_price_per_sqm/);
  for (const page of ['company.js', 'customers.js']) {
    assert.doesNotMatch(readFileSync(path.join(appRoot, 'public', 'assets', page), 'utf8'), /floor_price_per_sqm|底价/);
  }
});
