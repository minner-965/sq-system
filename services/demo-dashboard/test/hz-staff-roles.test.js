import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagementAuth } from '../src/auth/managementAuth.js';
import { verifyPassword } from '../src/auth/password.js';
import { ASSIGNABLE_ROLES, ROLE_CODE, STAFF_ROLE_CODES, seesOnlyOwnWorkload } from '../src/auth/roles.js';
import { createLeasingRouter } from '../src/leasing/leasingRoutes.js';
import { createUserRouter } from '../src/users/userRoutes.js';
import {
  createUser, generatePassword, parseDisplayName, parseRoleAndSectors, parseUsername, recordPassword, resetPassword, updateUser
} from '../src/users/userService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const read = file => readFileSync(file, 'utf8');

const ROLES = [
  { key: 'admin', name: '系统负责人', can_write: true, all_sectors: true },
  { key: 'boss', name: '老板', can_write: false, all_sectors: true },
  { key: 'operations', name: '运营', can_write: true, all_sectors: true },
  { key: 'sales', name: '销售', can_write: true, all_sectors: false },
  { key: 'leasing', name: '招商人员', can_write: true, all_sectors: false }
];
const SECTOR_KEYS = ['office_retail', 'hotel_apartment', 'dining'];
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const LIN_ID = '22222222-2222-4222-8222-222222222222';
const actor = { id: ADMIN_ID, identity: 'admin', role: 'ADMIN' };

test('migration 096 adds the operations and sales roles and moves the four accounts without failing on a rerun', () => {
  const sql = read(path.join(repoRoot, 'database', 'migrations', '096_hz_staff_roles.sql'));
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT)\s*;/im);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS roles_key_check/);
  assert.match(sql, /CHECK \(key IN \('admin', 'boss', 'leasing', 'operations', 'sales'\)\)/);
  assert.match(sql, /\('operations', '运营', true, true, false\)/);
  assert.match(sql, /\('sales', '销售', true, false, false\)/);
  assert.match(sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(sql, /username = 'admin' AND display_name = 'Simon'/);
  assert.match(sql, /username = 'chen' AND role_key = 'leasing'/);
  assert.match(sql, /username = 'lin' AND role_key = 'leasing'/);
  assert.match(sql, /ON CONFLICT DO NOTHING/);
});

test('every role maps to a code and only sales-type roles see just their own workload', () => {
  assert.deepEqual(ROLE_CODE, { admin: 'ADMIN', boss: 'BOSS', operations: 'OPERATIONS', sales: 'SALES', leasing: 'LEASING' });
  assert.deepEqual(ASSIGNABLE_ROLES, ['admin', 'boss', 'operations', 'sales']);
  for (const role of ['ADMIN', 'BOSS', 'OPERATIONS', 'SALES', 'LEASING']) assert.ok(STAFF_ROLE_CODES.includes(role));
  assert.equal(seesOnlyOwnWorkload({ role: 'SALES' }), true);
  assert.equal(seesOnlyOwnWorkload({ role: 'LEASING' }), true);
  assert.equal(seesOnlyOwnWorkload({ role: 'OPERATIONS' }), false);
  assert.equal(seesOnlyOwnWorkload({ role: 'BOSS' }), false);
  assert.equal(seesOnlyOwnWorkload({ role: 'ADMIN' }), false);
});

test('operations is shown publishing and inbox notices meant for the system owner, nothing else', () => {
  const service = read(path.join(appRoot, 'src', 'customers', 'customerService.js'));
  assert.match(service, /\$2 = 'operations' AND n\.recipient_role = 'admin' AND n\.kind IN \('publishing', 'interaction'\)/);
});

test('the floor price stays with the system owner for the new roles too', async () => {
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); return { rows: [{ property_type: 'office', min_lease_years: 2 }] }; } };
  for (const role of ['OPERATIONS', 'SALES']) {
    const app = express();
    app.use('/api', createLeasingRouter({ pool, auth: createManagementAuth({ DPV_WORKSPACE_ROLE: role }) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leasing-policy`);
      assert.equal(response.status, 200, role);
      assert.doesNotMatch(await response.text(), /floor_price/, role);
    } finally { server.close(); }
  }
  assert.doesNotMatch(queries.join('\n'), /floor_price/);
});

test('names, login names, roles and sectors are checked with Chinese messages', () => {
  assert.equal(parseDisplayName(' 王经理 '), '王经理');
  assert.throws(() => parseDisplayName('  '), { code: 'USER_NAME_REQUIRED', message: '请填写姓名或称呼' });
  assert.throws(() => parseDisplayName('名'.repeat(21)), { code: 'USER_NAME_TOO_LONG' });
  assert.equal(parseUsername(' Wang.Li '), 'wang.li');
  for (const bad of ['w', '王', 'a b', 'x'.repeat(41), undefined]) assert.throws(() => parseUsername(bad), { code: 'USERNAME_INVALID' });

  const reference = { roles: ROLES, sectorKeys: SECTOR_KEYS };
  assert.deepEqual(parseRoleAndSectors({ role_key: 'operations', sectors: ['dining'] }, reference), { roleKey: 'operations', sectors: [] });
  assert.deepEqual(parseRoleAndSectors({ role_key: 'sales', sectors: ['dining', 'office_retail', 'dining'] }, reference),
    { roleKey: 'sales', sectors: ['office_retail', 'dining'] });
  assert.throws(() => parseRoleAndSectors({ role_key: 'sales', sectors: [] }, reference), { code: 'SECTORS_REQUIRED', message: '请至少选一个负责的板块' });
  assert.throws(() => parseRoleAndSectors({ role_key: 'sales', sectors: ['moon'] }, reference), { code: 'SECTOR_INVALID' });
  assert.throws(() => parseRoleAndSectors({ role_key: 'root', sectors: [] }, reference), { code: 'ROLE_INVALID' });
  // 旧的招商人员角色不再分配给新人，已经是这个角色的账号保存时照样可以。
  assert.throws(() => parseRoleAndSectors({ role_key: 'leasing', sectors: ['dining'] }, reference), { code: 'ROLE_INVALID' });
  assert.deepEqual(parseRoleAndSectors({ role_key: 'leasing', sectors: ['dining'] }, { ...reference, currentRole: 'leasing' }),
    { roleKey: 'leasing', sectors: ['dining'] });
});

test('generated passwords are long, random and pass the password rules', () => {
  const seen = new Set(Array.from({ length: 50 }, generatePassword));
  assert.equal(seen.size, 50);
  for (const password of seen) assert.match(password, /^[A-Za-z0-9_-]{16}$/);
});

/** 一个够用的假数据库：记下每条语句，按语句内容给出账号数据。 */
function fakePool({ users }) {
  const log = [];
  const client = {
    async query(sql, params = []) {
      log.push({ sql, params });
      if (/FROM leadgen\.roles/.test(sql)) return { rows: ROLES };
      if (/SELECT key FROM leadgen\.sectors/.test(sql)) return { rows: SECTOR_KEYS.map(key => ({ key })) };
      if (/FROM leadgen\.users u JOIN leadgen\.roles r ON r\.key = u\.role_key WHERE u\.id = \$1/.test(sql)) {
        const user = users.find(item => item.id === params[0]);
        return { rows: user ? [user] : [] };
      }
      if (/INSERT INTO leadgen\.users/.test(sql)) {
        if (users.some(item => item.username === params[0])) return { rows: [] };
        const created = { id: '33333333-3333-4333-8333-333333333333', username: params[0], display_name: params[1], role_key: params[2], sectors: [] };
        users.push(created);
        return { rows: [{ id: created.id }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { log, connect: async () => client, query: client.query };
}

const people = () => [
  { id: ADMIN_ID, username: 'admin', display_name: '系统负责人', role_key: 'admin', all_sectors: true, sectors: [] },
  { id: LIN_ID, username: 'lin', display_name: '销售', role_key: 'sales', all_sectors: false, sectors: ['dining'] }
];

test('the system owner cannot take away their own admin role, but can rename themselves', async () => {
  const pool = fakePool({ users: people() });
  await assert.rejects(updateUser(pool, { userId: ADMIN_ID, input: { role_key: 'operations' }, actor }),
    { code: 'CANNOT_DROP_OWN_ADMIN', status: 400 });
  assert.ok(pool.log.some(entry => entry.sql === 'ROLLBACK'));
  assert.ok(!pool.log.some(entry => /UPDATE leadgen\.users/.test(entry.sql)));

  await updateUser(pool, { userId: ADMIN_ID, input: { display_name: 'Simon', role_key: 'admin' }, actor });
  const update = pool.log.find(entry => /UPDATE leadgen\.users/.test(entry.sql));
  assert.deepEqual(update.params, [ADMIN_ID, 'Simon', 'admin']);

  await assert.rejects(updateUser(pool, { userId: 'not-a-uuid', input: { display_name: 'x' }, actor }), { code: 'USER_NOT_FOUND', status: 404 });
  await assert.rejects(updateUser(pool, { userId: LIN_ID, input: {}, actor }), { code: 'NOTHING_TO_CHANGE' });
});

test('changing a salesperson to all three sectors rewrites their sector list', async () => {
  const pool = fakePool({ users: people() });
  await updateUser(pool, { userId: LIN_ID, input: { sectors: ['dining', 'hotel_apartment', 'office_retail'] }, actor });
  const insert = pool.log.find(entry => /INSERT INTO leadgen\.user_sectors/.test(entry.sql));
  assert.deepEqual(insert.params, [LIN_ID, SECTOR_KEYS]);
  assert.ok(pool.log.findIndex(entry => /DELETE FROM leadgen\.user_sectors/.test(entry.sql)) < pool.log.indexOf(insert));
});

test('a password reset returns the new password once, stores only its hash, keeps the current session and logs it locally', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hz-users-'));
  try {
    const file = path.join(dir, 'nested', 'accounts.local.txt');
    const pool = fakePool({ users: people() });
    const result = await resetPassword(pool, { userId: LIN_ID, credentialsFile: file, actor, keepSessionId: 'current-sid' });
    assert.match(result.password, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(result.saved_to_file, true);
    assert.equal(result.user.username, 'lin');

    const update = pool.log.find(entry => /SET password_hash = \$2, failed_login_count = 0, locked_until = NULL/.test(entry.sql));
    assert.equal(update.params[0], LIN_ID);
    assert.notEqual(update.params[1], result.password);
    assert.equal(await verifyPassword(result.password, update.params[1]), true);
    const sessions = pool.log.find(entry => /DELETE FROM leadgen\.user_sessions/.test(entry.sql));
    assert.deepEqual(sessions.params, [LIN_ID, 'current-sid']);

    const line = read(file);
    assert.match(line, new RegExp(`账号 lin  密码 ${result.password}  （网页重置密码，操作人 admin）\\n$`));
    assert.ok(!pool.log.some(entry => JSON.stringify(entry.params).includes(result.password)), 'the plain password never reaches the database');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a local accounts file the password is only returned, and a write failure does not lose it', async () => {
  assert.equal(await recordPassword(null, { username: 'lin', password: 'x', actor, action: '重置密码' }), false);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hz-users-'));
  try {
    // 目标是一个目录，写不进去。
    assert.equal(await recordPassword(dir, { username: 'lin', password: 'x', actor, action: '重置密码' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const result = await resetPassword(fakePool({ users: people() }), { userId: LIN_ID, credentialsFile: null, actor });
  assert.equal(result.saved_to_file, false);
  assert.match(result.password, /^[A-Za-z0-9_-]{16}$/);
});

test('a new account needs a free login name and gets its own initial password', async () => {
  const pool = fakePool({ users: people() });
  await assert.rejects(createUser(pool, { input: { username: 'lin', display_name: '另一个', role_key: 'boss' }, actor }),
    { code: 'USERNAME_TAKEN', status: 409 });
  await assert.rejects(createUser(pool, { input: { username: 'wang', display_name: '王', role_key: 'sales', sectors: [] }, actor }),
    { code: 'SECTORS_REQUIRED' });
  const result = await createUser(pool, { input: { username: 'Wang', display_name: '王经理', role_key: 'sales', sectors: ['office_retail'] }, actor });
  assert.equal(result.user.username, 'wang');
  assert.equal(result.saved_to_file, false);
  const insert = pool.log.find(entry => /INSERT INTO leadgen\.users/.test(entry.sql) && entry.params[0] === 'wang');
  assert.equal(await verifyPassword(result.password, insert.params[3]), true);
});

test('only the system owner reaches the people endpoints', async () => {
  const pool = fakePool({ users: people() });
  for (const [role, expected] of [['BOSS', 403], ['OPERATIONS', 403], ['SALES', 403], ['LEASING', 403], ['ADMIN', 200]]) {
    const app = express();
    app.use(express.json());
    app.use('/api/users', createUserRouter({ pool, auth: createManagementAuth({ DPV_WORKSPACE_ROLE: role }) }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/users`;
      assert.equal((await fetch(base)).status, expected, role);
      if (expected === 403) assert.equal((await fetch(`${base}/${LIN_ID}/password`, { method: 'POST' })).status, 403, role);
    } finally { server.close(); }
  }
});

test('the settings page shows people and roles to the system owner only, with a one-time password view', () => {
  const html = read(path.join(appRoot, 'public', 'settings.html'));
  const script = read(path.join(appRoot, 'public', 'assets', 'settings.js'));
  assert.match(html, /<h3 id="people-title">人员和权限<\/h3>/);
  assert.match(html, /id="people" aria-labelledby="people-title" hidden/);
  assert.match(html, /密码只显示这一次/);
  assert.match(script, /if \(shell\.user\.role === 'ADMIN'\) loadPeople\(\);/);
  assert.match(script, /navigator\.clipboard\.writeText/);
  assert.match(script, /addEventListener\('close', \(\) => \{ byId\('secret-value'\)\.value = ''; \}\)/);
  assert.doesNotMatch(html + script, /管理员/);
});
