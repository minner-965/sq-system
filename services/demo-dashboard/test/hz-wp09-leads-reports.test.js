import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_PATTERN, addressNote, parseSubmission, publicBase, publicForm, submitLead } from '../src/leads/leadService.js';
import { MAX_RANGE_DAYS, parsePeriod } from '../src/reports/reportService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a lead form submission needs a name, a mobile number and consent', () => {
  assert.deepEqual(parseSubmission({ contact_name: ' 张先生 ', phone: '138 1234-5678', need: '', sector_key: 'dining', consent: true }),
    { name: '张先生', phone: '13812345678', need: null, sector: 'dining' });
  for (const [body, code] of [
    [{ contact_name: '', phone: '13812345678', consent: true }, 'LEAD_NAME_INVALID'],
    [{ contact_name: 'x'.repeat(21), phone: '13812345678', consent: true }, 'LEAD_NAME_INVALID'],
    [{ contact_name: '张', phone: '0208200306', consent: true }, 'LEAD_PHONE_INVALID'],
    [{ contact_name: '张', phone: '13812345678', consent: 'yes' }, 'LEAD_CONSENT_REQUIRED'],
    [{ contact_name: '张', phone: '13812345678', consent: true, need: 'x'.repeat(301) }, 'LEAD_NEED_TOO_LONG']
  ]) assert.throws(() => parseSubmission(body), error => error.code === code);
});

test('a filled bot trap is answered as a success and nothing is stored', async () => {
  const pool = { connect() { throw new Error('the database must not be touched'); } };
  assert.deepEqual(await submitLead(pool, { code: 'abcdefgh', body: { contact_name: '张', phone: '13812345678', consent: true, website: 'http://spam.example' } }), { ok: true });
});

test('the public form reveals only its title and the sector list', async () => {
  const asked = [];
  const pool = { query: async sql => { asked.push(sql); return /lead_forms/.test(sql) ? { rows: [{ title: '1307 写字楼', sector_key: 'office_retail' }] } : { rows: [{ key: 'office_retail', name: '商铺写字楼' }] }; } };
  assert.deepEqual(await publicForm(pool, 'abcdefgh'), { title: '1307 写字楼', sector_key: 'office_retail', sectors: [{ key: 'office_retail', name: '商铺写字楼' }] });
  assert.equal(await publicForm(pool, '../../etc'), null);
  assert.equal(await publicForm(pool, 'ABCDEFGH'), null);
  assert.ok(CODE_PATTERN.test('k3m9x2ab'));
  assert.ok(asked.every(sql => !/price|floor|users|properties/i.test(sql)));
});

test('a code that would stop working is flagged before it is handed out', () => {
  const req = host => ({ protocol: 'http', get: () => host });
  assert.match(addressNote(publicBase(req('localhost:3000'), {})), /内部地址/);
  assert.match(addressNote(publicBase(req('192.168.1.20:3000'), {})), /内部地址/);
  assert.match(addressNote(publicBase(req('abc.trycloudflare.com'), {})), /临时演示地址/);
  assert.equal(addressNote(publicBase(req('localhost:3000'), { HZ_PUBLIC_BASE_URL: 'https://zs.example.cn/' })), null);
  assert.equal(publicBase(req('localhost:3000'), { HZ_PUBLIC_BASE_URL: 'https://zs.example.cn/' }).base, 'https://zs.example.cn');
});

test('only the form page and its two calls are reachable without signing in', () => {
  const server = readFileSync(path.join(appRoot, 'src', 'server.js'), 'utf8');
  assert.ok(server.indexOf('createPublicLeadRouter({') < server.indexOf('app.use(auth.sessionMiddleware)'));
  const routes = readFileSync(path.join(appRoot, 'src', 'leads', 'leadRoutes.js'), 'utf8');
  const open = routes.slice(routes.indexOf('export function createPublicLeadRouter'), routes.indexOf('export function createLeadRouter'));
  assert.deepEqual([...open.matchAll(/router\.(get|post)\('([^']+)'/g)].map(match => `${match[1]} ${match[2]}`),
    ['get /f/:code', 'get /api/public/forms/:code', 'post /api/public/forms/:code']);
  assert.match(open, /submitLimiter/);
  const signedIn = routes.slice(routes.indexOf('export function createLeadRouter'));
  assert.match(signedIn, /router\.get\('\/leads\/submissions', \.\.\.read/);
  assert.match(signedIn, /router\.post\('\/publishing\/tasks\/:taskId\/lead-form', \.\.\.write/);
});

test('a reporting period is two calendar days in Guangzhou time and at most a year', () => {
  const now = new Date('2026-10-11T17:30:00Z'); // 广州已经是 12 日凌晨
  assert.deepEqual(parsePeriod({}, now), { from: '2026-09-13', to: '2026-10-12' });
  assert.deepEqual(parsePeriod({ from: '2026-10-01', to: '2026-10-05' }, now), { from: '2026-10-01', to: '2026-10-05' });
  assert.throws(() => parsePeriod({ from: '2026-10-05', to: '2026-10-01' }, now), error => error.code === 'PERIOD_INVALID');
  assert.throws(() => parsePeriod({ from: '10/01/2026' }, now), error => error.code === 'PERIOD_INVALID');
  assert.throws(() => parsePeriod({ from: '2025-01-01', to: '2026-10-01' }, now), error => error.code === 'PERIOD_TOO_LONG');
  assert.equal(MAX_RANGE_DAYS, 366);
});

test('leasing staff see only their own workload row and nobody reads the floor price in a report', () => {
  const service = readFileSync(path.join(appRoot, 'src', 'reports', 'reportService.js'), 'utf8');
  assert.match(service, /seesOnlyOwnWorkload\(user\) \? user\.id : null/);
  assert.match(service, /own_row_only: seesOnlyOwnWorkload\(user\)/);
  assert.doesNotMatch(service, /floor_price|intended_price/);
});
