import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createSessionAuth } from '../src/auth/sessionAuth.js';
import { getOverview, visibleSectors } from '../src/overview/overviewService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(appRoot, 'public');
const walk = dir => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

test('passwords are stored as salted scrypt hashes and verified in constant time', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$131072\$8\$1\$/);
  assert.notEqual(hash, await hashPassword('correct horse battery'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterx', hash), false);
  assert.equal(await verifyPassword('anything', null), false);
  await assert.rejects(hashPassword('short'), { code: 'PASSWORD_TOO_SHORT' });
});

test('login refuses to start without a session secret', () => {
  assert.throws(() => createSessionAuth({ pool: {}, env: {} }), { code: 'SESSION_SECRET_REQUIRED' });
  assert.throws(() => createSessionAuth({ pool: {}, env: { SESSION_SECRET: 'too-short' } }), { code: 'SESSION_SECRET_REQUIRED' });
});

function respond(middleware, req) {
  let status = null;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  middleware({ method: 'GET', get: () => undefined, ...req }, res, () => { passed = true; });
  return passed ? 'next' : status;
}

test('read-only accounts and cross-site requests cannot write', () => {
  const auth = createSessionAuth({ pool: { query: async () => ({ rows: [] }) }, env: { SESSION_SECRET: 'x'.repeat(48) } });
  assert.equal(respond(auth.requireWrite, { managementUser: { canWrite: false } }), 403);
  assert.equal(respond(auth.requireWrite, { managementUser: { canWrite: true } }), 'next');
  assert.equal(respond(auth.requireRoles('ADMIN'), { managementUser: { role: 'BOSS' } }), 403);

  const headers = values => ({ get: name => values[name] });
  assert.equal(respond(auth.sameOriginWrites, { method: 'POST', ...headers({ origin: 'https://other.example', host: 'hz.example' }) }), 403);
  assert.equal(respond(auth.sameOriginWrites, { method: 'POST', ...headers({ origin: 'https://hz.example', host: 'hz.example' }) }), 'next');
  assert.equal(respond(auth.sameOriginWrites, { method: 'GET', ...headers({ origin: 'https://other.example', host: 'hz.example' }) }), 'next');
});

test('a user only sees the sectors assigned to them', () => {
  const leasing = { sectors: ['office_retail', 'dining'] };
  assert.deepEqual(visibleSectors(leasing, undefined), ['office_retail', 'dining']);
  assert.deepEqual(visibleSectors(leasing, 'all'), ['office_retail', 'dining']);
  assert.deepEqual(visibleSectors(leasing, 'dining'), ['dining']);
  assert.equal(visibleSectors(leasing, 'hotel_apartment'), null);
});

// Routes each overview query to canned rows by the table it reads first.
function overviewPool(stageRows) {
  return {
    async query(sql) {
      if (/FROM leadgen\.properties/.test(sql)) return { rows: [{ property_type: 'office', units: 44, area_sqm: 4189 }, { property_type: 'retail', units: 10, area_sqm: 2570 }] };
      if (/FROM leadgen\.companies WHERE/.test(sql)) return { rows: [{ this_week: 3, last_week: 1, pending_review: 2 }] };
      if (/viewings_this_month/.test(sql)) return { rows: [{ viewings_this_month: 4, due_today: 2, overdue: 1 }] };
      if (/SELECT stage, count/.test(sql)) return { rows: stageRows };
      if (/FROM leadgen\.sectors s/.test(sql)) return { rows: [{ key: 'office_retail', name: '商铺写字楼', companies: 5 }] };
      if (/AS planned/.test(sql)) return { rows: [{ planned: 2, waiting: 1 }] };
      if (/FROM leadgen\.publish_accounts/.test(sql)) return { rows: [{ platform: 'douyin', ready: false, n: 1 }] };
      return { rows: [] };
    }
  };
}

test('overview funnel counts everyone who reached each stage', async () => {
  const pool = overviewPool([{ stage: 'new', n: 10 }, { stage: 'contacted', n: 5 }, { stage: 'viewing', n: 3 }, { stage: 'signed', n: 1 }, { stage: 'lost', n: 4 }]);
  const data = await getOverview(pool, { user: { sectors: ['office_retail'] }, sector: 'all' });
  assert.deepEqual(data.funnel.steps.map(step => step.count), [19, 9, 4, 1, 1]);
  assert.equal(data.funnel.lost, 4);
  assert.deepEqual(data.properties, { available_units: 54, available_area_sqm: 6759, retail_units: 10, office_units: 44 });
  assert.deepEqual([data.publishing.planned_this_week, data.publishing.waiting_confirmation, data.publishing.items], [2, 1, []]);
  assert.deepEqual(data.publishing.platforms.map(platform => platform.state), ['待登录', '未添加账号', '未添加账号', '未添加账号']);
});

test('overview hides properties from users outside the office and retail sector and rejects other sectors', async () => {
  const pool = overviewPool([]);
  const data = await getOverview(pool, { user: { sectors: ['dining'] }, sector: 'all' });
  assert.equal(data.properties, null);
  assert.deepEqual(data.funnel.steps.map(step => step.count), [0, 0, 0, 0, 0]);
  await assert.rejects(getOverview(pool, { user: { sectors: ['dining'] }, sector: 'office_retail' }), { code: 'SECTOR_FORBIDDEN' });
});

test('pages are Chinese-only, load nothing from other sites and reference files that exist', () => {
  for (const file of walk(publicDir)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /https?:\/\/|\/\/fonts\.|cdn\./, path.relative(publicDir, file));
    if (!file.endsWith('.html')) continue;
    assert.match(text, /<html lang="zh-CN">/);
    for (const [, url] of text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      assert.ok(existsSync(path.join(publicDir, url)), `${path.basename(file)} -> ${url}`);
    }
  }
  assert.ok(existsSync(path.join(appRoot, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));
});

test('every business route sits behind login and the fixed identity is gone', () => {
  const server = readFileSync(path.join(appRoot, 'src', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /managementAuth|DPV_WORKSPACE/);
  const open = [...server.matchAll(/app\.(get|put|post|delete)\('([^']+)',\s*(async|\()/g)].map(match => match[2]);
  assert.deepEqual(open, ['/api/health', '/login.html']);
  const compose = readFileSync(path.resolve(appRoot, '..', '..', 'compose.yaml'), 'utf8');
  assert.match(compose, /SESSION_SECRET: \$\{SESSION_SECRET\}/);
  assert.doesNotMatch(compose, /DPV_WORKSPACE/);
});

test('edit controls are marked so read-only accounts never see them', () => {
  const index = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const shell = readFileSync(path.join(publicDir, 'assets', 'shell.js'), 'utf8');
  for (const [button] of index.matchAll(/<button[^>]*class="btn pri"[^>]*>/g)) assert.match(button, /data-requires="write"/);
  assert.match(shell, /if \(!user\.can_write\) document\.querySelectorAll\('\[data-requires="write"\]'\)\.forEach\(element => element\.remove\(\)\)/);
});
