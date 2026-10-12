import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAmapProvider, normalizePoi } from '../src/discovery/providers/amap.js';
import { isInsideProject, planQueries } from '../src/discovery/discoveryService.js';
import { RULE_VERSION, scoreCompany } from '../src/discovery/scoring.js';
import { validateSignals } from '../src/discovery/signals.js';
import { clipQuery } from '../src/discovery/providers/baiduSearch.js';

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

test('demand signals add up to 30 points, each tied to the page it came from', () => {
  const company = normalizePoi(POI);
  const office = options => scoreCompany(company, options)[0];
  assert.equal(office().items[3].reason, '还没有查过');
  assert.equal(office({ signalsChecked: true }).items[3].reason, '近一年没有查到找场地、迁址、新设、扩张、本地项目、招聘方面的公开信息');

  const hiring = { type: 'hiring', evidence: '正在招聘销售和工程师', sourceTitle: '示例科技招聘', sourceUrl: 'https://jobs.example/1' };
  const moving = { type: 'relocation', evidence: '计划年内搬到新园区', sourceTitle: '示例科技搬迁公告', sourceUrl: 'https://news.example/2' };
  const one = office({ signals: [hiring], signalsChecked: true });
  assert.deepEqual([one.items[3].points, one.score], [10, 66]);
  assert.equal(one.items[3].source.url, 'https://jobs.example/1');

  const both = office({ signals: [hiring, moving], signalsChecked: true });
  assert.equal(both.items[3].points, 30);
  assert.equal(both.items[3].reason, '招聘：正在招聘销售和工程师；迁址：计划年内搬到新园区');
  assert.equal(both.items[3].source.url, 'https://news.example/2');
  const expanding = { type: 'expansion', evidence: '新增产线', sourceUrl: 'https://news.example/3' };
  assert.equal(office({ signals: [hiring, moving, expanding] }).items[3].points, 30);
});

test('a signal is kept only when it points at a real search result', () => {
  const results = [{ title: '示例科技招聘', url: 'https://jobs.example/1', date: '2026-09-30 01:53:02' }, { title: '别的公司', url: 'https://other.example', date: null }];
  const signals = validateSignals({ signals: [
    { type: 'hiring', result: 1, evidence: '在招人' },
    { type: 'hiring', result: 2, evidence: '重复的类型' },
    { type: 'relocation', result: 9, evidence: '编号不存在' },
    { type: 'bankrupt', result: 1, evidence: '不认识的类型' },
    { type: 'expansion', result: 2, evidence: '' }
  ] }, results);
  assert.deepEqual(signals, [{ type: 'hiring', evidence: '在招人', openings: null, sourceTitle: '示例科技招聘', sourceUrl: 'https://jobs.example/1', sourceDate: '2026-09-30' }]);
  assert.deepEqual(validateSignals({}, results), []);
  assert.deepEqual(validateSignals({ signals: 'none' }, results), []);
});

test('search queries are cut to the length the search service accepts', () => {
  assert.equal(clipQuery('abc'), 'abc');
  assert.equal(clipQuery('企'.repeat(40)).length, 36);
  assert.equal(clipQuery(`${'a'.repeat(70)}企业`), `${'a'.repeat(70)}企`);
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

test('evidence is graded by how directly it points at a need for space', async () => {
  const { STRENGTH, demandLevel, strengthOf, validateSignals: validate } = await import('../src/discovery/signals.js');
  assert.equal(strengthOf({ type: 'seeking_space' }), 'strong');
  assert.equal(strengthOf({ type: 'relocation' }), 'strong');
  assert.equal(strengthOf({ type: 'expansion' }), 'medium');
  assert.equal(strengthOf({ type: 'project_site' }), 'medium');
  // A couple of openings says little about space; a large intake means the team is growing.
  assert.equal(strengthOf({ type: 'hiring', openings: 2 }), 'weak');
  assert.equal(strengthOf({ type: 'hiring', openings: null }), 'weak');
  assert.equal(strengthOf({ type: 'hiring', openings: 31 }), 'medium');
  assert.equal(demandLevel([], false), 'unchecked');
  assert.equal(demandLevel([], true), 'none');
  assert.equal(demandLevel([{ type: 'hiring', openings: 3 }, { type: 'relocation' }], true), 'strong');
  assert.ok(STRENGTH.weak.meaning.includes('不能说明'));
  const results = [{ title: '示例科技招聘', url: 'https://jobs.example/1', date: null }];
  assert.equal(validate({ signals: [{ type: 'hiring', result: 1, evidence: '在招 18 个岗位', openings: 18 }] }, results)[0].openings, 18);
  assert.equal(validate({ signals: [{ type: 'hiring', result: 1, evidence: '在招人', openings: '很多' }] }, results)[0].openings, null);
  assert.equal(validate({ signals: [{ type: 'expansion', result: 1, evidence: '扩产', openings: 50 }] }, results)[0].openings, null);
});

test('the result of a call is recorded on the customer and a single company can be looked up before calling', () => {
  const customers = readFileSync(path.join(appRoot, 'src', 'customers', 'customerService.js'), 'utf8');
  assert.match(customers, /demand_check: value =>/);
  assert.match(customers, /联系后核实：\$\{DEMAND_CHECK_NAME\[next\.demand_check\]\}/);
  const routes = readFileSync(path.join(appRoot, 'src', 'discovery', 'discoveryRoutes.js'), 'utf8');
  assert.match(routes, /router\.post\('\/companies\/:companyId\/signals', \.\.\.write/);
  const signals = readFileSync(path.join(appRoot, 'src', 'discovery', 'signals.js'), 'utf8');
  assert.match(signals, /SIGNAL_CHECKED_RECENTLY/);
});

test('evidence must be about now: old events and undated new companies are dropped, project offices are read off the listing', async () => {
  const { nameSignals, validateSignals: validate } = await import('../src/discovery/signals.js');
  const results = [{ title: '某公司', url: 'https://news.example/1', date: null }];
  const now = new Date('2026-10-12T00:00:00Z');
  const kept = raw => validate({ signals: raw }, results, now).map(signal => signal.type);
  assert.deepEqual(kept([{ type: 'new_setup', result: 1, evidence: '2025 年 2 月成立', event_month: '2025-02' }]), []);
  assert.deepEqual(kept([{ type: 'new_setup', result: 1, evidence: '今年 3 月成立', event_month: '2026-03' }]), ['new_setup']);
  assert.deepEqual(kept([{ type: 'new_setup', result: 1, evidence: '新成立' }]), []);
  assert.deepEqual(kept([{ type: 'expansion', result: 1, evidence: '2024 年启动扩建', event_month: '2024-06' }]), []);
  assert.deepEqual(kept([{ type: 'hiring', result: 1, evidence: '在招人' }]), ['hiring']);
  assert.deepEqual(nameSignals({ name: '中建四局水西旧改项目部', sourceRef: 'B0ABC' }).map(signal => [signal.type, signal.sourceUrl]),
    [['project_site', 'https://www.amap.com/place/B0ABC']]);
  assert.deepEqual(nameSignals({ name: '广州某某科技有限公司', sourceRef: 'B0ABD' }), []);
});

test('a published licence is matched to a map listing by the distinctive part of the name', async () => {
  const { coreName, sameBusiness, searchName } = await import('../src/discovery/permits.js');
  assert.equal(searchName('广州市黄埔区星记餐饮店(个体工商户)'), '星记餐饮店');
  assert.equal(searchName('广州黄埔龙湖街火焰旺潮烧烤档(个体工商户)'), '火焰旺潮烧烤档');
  assert.equal(coreName('广东乐佳乐餐饮服务有限公司'), '乐佳乐');
  assert.equal(coreName('广州国康医药连锁有限公司萝岗分店'), '国康');
  assert.ok(sameBusiness('广州市黄埔区星记餐饮店(个体工商户)', '星记餐饮'));
  assert.ok(sameBusiness('广东乐佳乐餐饮服务有限公司', '乐佳乐餐饮(黄埔店)'));
  assert.ok(!sameBusiness('广州市黄埔区星记餐饮店(个体工商户)', '阿星美食'));
  // One character apart is usually a different business.
  assert.ok(!sameBusiness('广东乐佳乐餐饮服务有限公司', '乐佳餐饮'));
  assert.ok(sameBusiness('广州市黄埔区早来包子店', '早来包子'));
  const service = readFileSync(path.join(appRoot, 'src', 'discovery', 'signals.js'), 'utf8');
  // Re-checking a company on the web must not wipe evidence that came from the government disclosure.
  assert.match(service, /DELETE FROM leadgen\.company_signals WHERE company_id = \$1 AND origin <> 'permit'/);
});
