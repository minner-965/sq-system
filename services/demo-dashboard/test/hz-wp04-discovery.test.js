import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAmapProvider, normalizePoi } from '../src/discovery/providers/amap.js';
import { isInsideProject, planQueries } from '../src/discovery/discoveryService.js';
import { RULE_VERSION, scoreCompany } from '../src/discovery/scoring.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const POI = {
  id: 'B0TEST0001', name: '广州示例科技有限公司', type: '公司企业;公司;公司', typecode: '170200', adname: '黄埔区',
  cityname: '广州市', address: '示例路 8 号', location: '113.500000,23.210000', distance: '2400', tel: '020-80000000;13800000000'
};

test('a map result becomes a company record with its source link', () => {
  assert.deepEqual(normalizePoi(POI), {
    source: 'amap', sourceRef: 'B0TEST0001', sourceUrl: 'https://www.amap.com/place/B0TEST0001',
    name: '广州示例科技有限公司', address: '黄埔区示例路 8 号', district: '黄埔区', city: '广州市',
    longitude: 113.5, latitude: 23.21, distanceM: 2400, phone: '020-80000000', categoryCode: '170200', industry: '公司'
  });
  // 高德对没有的字段返回空数组
  const sparse = normalizePoi({ ...POI, tel: [], address: [], distance: [] });
  assert.deepEqual([sparse.phone, sparse.address, sparse.distanceM], [null, '黄埔区', null]);
});

test('the provider sends the search to the official endpoint and surfaces its errors', async () => {
  const calls = [];
  const reply = body => async url => { calls.push(new URL(url)); return { ok: true, json: async () => body }; };
  const provider = createAmapProvider({ key: 'test-key', fetchImpl: reply({ status: '1', count: '1', pois: [POI, { id: '', name: '' }] }) });
  const result = await provider.search({ longitude: 113.48, latitude: 23.2, radiusM: 5000, categoryCode: '170200', page: 2 });
  assert.equal(result.total, 1);
  assert.equal(result.companies.length, 1);
  assert.equal(calls[0].origin + calls[0].pathname, 'https://restapi.amap.com/v3/place/around');
  assert.deepEqual(['location', 'radius', 'types', 'page', 'offset'].map(name => calls[0].searchParams.get(name)), ['113.48,23.2', '5000', '170200', '2', '25']);

  const limited = createAmapProvider({ key: 'test-key', fetchImpl: reply({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }) });
  await assert.rejects(limited.search({ longitude: 1, latitude: 1, radiusM: 1000, page: 1 }), { code: 'AMAP_10003' });
  assert.equal(createAmapProvider({}).configured, false);
  await assert.rejects(createAmapProvider({}).search({}), { code: 'AMAP_KEY_MISSING' });
});

test('scores add up from distance, company type and reachability, each with a reason and source', () => {
  const company = normalizePoi(POI);
  const results = scoreCompany(company);
  // 2.4 公里：写字楼和餐饮都在范围内；名称带“科技”，也是差旅协议的候选。
  assert.deepEqual(results.map(result => [result.sectorKey, result.score]), [['office_retail', 56], ['hotel_apartment', 60], ['dining', 36]]);
  const office = results[0];
  assert.deepEqual(office.items.map(item => [item.item, item.points, item.max]), [['距离', 32, 40], ['企业类型', 14, 20], ['可联系', 10, 10], ['需求信号', 0, 30]]);
  assert.equal(office.items[0].reason, '距恒兆广场 2.4 公里');
  assert.equal(office.items[0].source.url, 'https://www.amap.com/place/B0TEST0001');
  for (const result of results) {
    assert.ok(result.score <= 100);
    assert.equal(result.items.reduce((sum, item) => sum + item.max, 0), 100);
  }
  assert.match(RULE_VERSION, /^hz-/);
});

test('sector routing follows distance and company size', () => {
  const sectors = company => scoreCompany({ ...normalizePoi(POI), ...company }).map(result => result.sectorKey);
  assert.deepEqual(sectors({ name: '某某商行', distanceM: 800 }), ['office_retail', 'dining']);
  assert.deepEqual(sectors({ name: '某某贸易有限公司', distanceM: 6000 }), ['office_retail']);
  assert.deepEqual(sectors({ name: '某某制造厂', categoryCode: '170300', distanceM: 8000 }), ['office_retail', 'hotel_apartment']);
  assert.deepEqual(sectors({ distanceM: 12000 }), []);
  assert.deepEqual(sectors({ distanceM: null }), []);
  const [flagged] = scoreCompany({ ...normalizePoi(POI), name: '广州某某化工有限公司' });
  assert.deepEqual(flagged.notices, ['特殊业态，入驻前需确认消防和环评要求']);
});

test('existing tenants of the project are kept out', () => {
  const settings = { exclude_within_m: 150, exclude_address_keywords: ['恒兆广场', '福业一街3号'] };
  const company = fields => ({ name: '某公司', address: '黄埔区别处 1 号', distanceM: 900, ...fields });
  assert.equal(isInsideProject(company(), settings), false);
  assert.equal(isInsideProject(company({ distanceM: 49 }), settings), true);
  assert.equal(isInsideProject(company({ address: '黄埔区水西福业一街3号6层' }), settings), true);
  assert.equal(isInsideProject(company({ name: '广州恒兆运营管理有限公司' }), settings), true);
});

test('a small call budget still reaches every category before paging deeper', () => {
  const plan = planQueries({ category_codes: ['170100', '170200'], keywords: ['直播电商'] });
  assert.equal(plan.length, 24);
  assert.deepEqual(plan.slice(0, 4), [
    { categoryCode: '170100', page: 1 }, { categoryCode: '170200', page: 1 }, { keyword: '直播电商', page: 1 }, { categoryCode: '170100', page: 2 }
  ]);
});

test('discovery writes are limited to accounts that can edit, settings to administrators', () => {
  const routes = readFileSync(path.join(appRoot, 'src', 'discovery', 'discoveryRoutes.js'), 'utf8');
  assert.match(routes, /router\.post\('\/candidates\/:candidateId\/review', \.\.\.write/);
  assert.match(routes, /router\.post\('\/runs', \.\.\.write/);
  assert.match(routes, /router\.(get|put)\('\/settings', \.\.\.admin/);
  assert.match(routes, /const write = \[auth\.authenticate, auth\.requireWrite\]/);
  // 接口 Key 只在服务端使用，不出现在页面脚本里。
  assert.doesNotMatch(readFileSync(path.join(appRoot, 'public', 'assets', 'discovery.js'), 'utf8'), /AMAP_KEY|restapi\.amap/);
});
