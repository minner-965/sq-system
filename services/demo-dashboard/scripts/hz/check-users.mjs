// 用真实数据库核对“人员和权限”：四个角色、四个账号、改角色/板块、重置密码、新建账号。
// 全部在一个事务里跑，结束回滚，不改任何账号和密码；迁移 096 还没执行时先在事务里执行一遍再核对。
// 重置出来的密码随事务回滚作废，不写进账号文件，也不打印。
// 用法（在 services/demo-dashboard 下）：npm run check:users
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../../src/auth/password.js';
import { loadUser } from '../../src/auth/sessionAuth.js';
import { listNotifications, listOwners } from '../../src/customers/customerService.js';
import { createHostPool } from '../../src/db/pool.js';
import { createUser, listUsers, resetPassword, updateUser } from '../../src/users/userService.js';

const MIGRATION = '096_hz_staff_roles.sql';
const migrationSql = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'database', 'migrations', MIGRATION), 'utf8');

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
// 所有语句走同一个事务连接，排队执行（名单接口会并发查几张表）。
let queue = Promise.resolve();
const serial = (sql, params) => (queue = queue.catch(() => {}).then(() => client.query(sql, params)));
const pool = { connect: async () => inner, query: serial };
const ALL = ['office_retail', 'hotel_apartment', 'dining'];

try {
  await client.query('BEGIN');
  const { rows: [{ applied }] } = await client.query('SELECT EXISTS (SELECT 1 FROM leadgen.schema_migrations WHERE migration_key = $1) AS applied', [MIGRATION]);
  if (!applied) await client.query(migrationSql);
  // 再执行一次，结果不能变。
  await client.query(migrationSql);
  console.log(`迁移 ${MIGRATION}：${applied ? '已执行过' : '还没执行，已在事务里执行'}，重复执行没有报错 ✔`);

  const { rows: roles } = await client.query('SELECT key, name, can_write, all_sectors, sees_floor_price FROM leadgen.roles ORDER BY key');
  const role = Object.fromEntries(roles.map(row => [row.key, row]));
  assert.deepEqual(role.operations, { key: 'operations', name: '运营', can_write: true, all_sectors: true, sees_floor_price: false });
  assert.deepEqual(role.sales, { key: 'sales', name: '销售', can_write: true, all_sectors: false, sees_floor_price: false });
  assert.equal(role.admin.name, '系统负责人');
  assert.equal(role.boss.can_write, false);
  console.log(`角色：${roles.map(row => `${row.key}=${row.name}`).join('，')} ✔`);

  const admin = await userByName('admin');
  const actor = await loadUser(pool, admin.id);
  const sessionUsers = {};
  for (const username of ['admin', 'boss', 'chen', 'lin']) sessionUsers[username] = await loadUser(pool, (await userByName(username)).id);
  const summary = Object.entries(sessionUsers).map(([username, user]) => `${username}=${user.displayName}/${user.role}/${user.canWrite ? '可写' : '只读'}/${user.sectors.join('+')}`);
  assert.equal(sessionUsers.admin.role, 'ADMIN');
  assert.equal(sessionUsers.boss.role, 'BOSS');
  assert.equal(sessionUsers.boss.canWrite, false);
  assert.equal(sessionUsers.chen.role, 'OPERATIONS');
  assert.equal(sessionUsers.chen.canWrite, true);
  assert.deepEqual([...sessionUsers.chen.sectors], ALL);
  assert.equal(sessionUsers.lin.role, 'SALES');
  assert.deepEqual([...sessionUsers.lin.sectors], ALL);
  console.log(`登录后的身份：${summary.join('；')} ✔`);

  const list = await listUsers(pool, { actor });
  assert.deepEqual(list.roles.map(row => row.key), ['admin', 'boss', 'operations', 'sales']);
  assert.deepEqual(list.sectors.map(row => row.key), ALL);
  assert.equal(list.items.find(item => item.username === 'admin').is_self, true);
  assert.ok(list.items.every(item => !('password_hash' in item)), '名单里不能带密码');
  console.log(`人员名单：${list.items.map(item => `${item.display_name}（${item.role_name}）`).join('、')}，不带密码 ✔`);

  for (const sector of ALL) {
    const owners = (await listOwners(pool, sector)).map(row => row.id);
    assert.ok(owners.includes(sessionUsers.chen.id) && owners.includes(sessionUsers.lin.id), sector);
    assert.ok(!owners.includes(sessionUsers.boss.id), sector);
  }
  console.log('三个板块的负责人候选里都有运营和销售，没有老板 ✔');

  await client.query(`INSERT INTO leadgen.notifications (recipient_role, kind, title) VALUES ('admin', 'publishing', '核对用：发布提醒'), ('admin', 'below_floor_price', '核对用：底价提醒')`);
  const opsNotes = (await listNotifications(pool, sessionUsers.chen)).items.map(item => item.title);
  const salesNotes = (await listNotifications(pool, sessionUsers.lin)).items.map(item => item.title);
  assert.ok(opsNotes.includes('核对用：发布提醒') && !opsNotes.includes('核对用：底价提醒'));
  assert.ok(!salesNotes.includes('核对用：发布提醒'));
  console.log('发布提醒运营能看到，底价提醒只给系统负责人 ✔');

  await assert.rejects(() => updateUser(pool, { userId: admin.id, input: { role_key: 'operations' }, actor }), error => error.code === 'CANNOT_DROP_OWN_ADMIN');
  assert.equal((await loadUser(pool, admin.id)).role, 'ADMIN');
  const lin = await updateUser(pool, { userId: sessionUsers.lin.id, input: { display_name: '林销售', sectors: ['dining'] }, actor });
  assert.equal(lin.display_name, '林销售');
  assert.deepEqual(lin.sectors, ['dining']);
  assert.deepEqual([...(await loadUser(pool, lin.id)).sectors], ['dining']);
  await assert.rejects(() => updateUser(pool, { userId: lin.id, input: { role_key: 'sales', sectors: [] }, actor }), error => error.code === 'SECTORS_REQUIRED');
  console.log('自己的系统负责人权限取消不了；销售改名、改成只负责餐饮后马上生效；不选板块保存不了 ✔');

  await client.query(`INSERT INTO leadgen.user_sessions (sid, sess, expire) VALUES ('check-users-a', $1, now() + interval '1 hour'), ('check-users-b', $1, now() + interval '1 hour')`,
    [JSON.stringify({ cookie: {}, userId: lin.id })]);
  const reset = await resetPassword(pool, { userId: lin.id, credentialsFile: null, actor, keepSessionId: 'check-users-b' });
  const { rows: [stored] } = await client.query('SELECT password_hash, failed_login_count, locked_until FROM leadgen.users WHERE id = $1', [lin.id]);
  assert.equal(await verifyPassword(reset.password, stored.password_hash), true);
  assert.equal(stored.failed_login_count, 0);
  assert.equal(stored.locked_until, null);
  assert.equal(reset.saved_to_file, false);
  const { rows: sessionsLeft } = await client.query(`SELECT sid FROM leadgen.user_sessions WHERE sess->>'userId' = $1`, [lin.id]);
  assert.deepEqual(sessionsLeft.map(row => row.sid), ['check-users-b']);
  console.log(`重置密码：新密码 ${reset.password.length} 位，能登录，旧登录退出（操作人当前这次保留） ✔`);

  const created = await createUser(pool, { input: { username: 'check.wang', display_name: '核对用', role_key: 'sales', sectors: ['hotel_apartment'] }, credentialsFile: null, actor });
  assert.equal(await verifyPassword(created.password, (await userByName('check.wang')).password_hash), true);
  assert.deepEqual([...(await loadUser(pool, created.user.id)).sectors], ['hotel_apartment']);
  await assert.rejects(() => createUser(pool, { input: { username: 'check.wang', display_name: '重复', role_key: 'boss' }, actor }), error => error.code === 'USERNAME_TAKEN');
  console.log('新建账号能登录、只看酒店公寓；登录名重复时拦下 ✔');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows: left } = await real.query(`
    SELECT u.username, u.display_name, u.role_key,
           (SELECT count(*)::int FROM leadgen.user_sectors s WHERE s.user_id = u.id) AS sectors
    FROM leadgen.users u ORDER BY u.username`);
  console.log('回滚后账号：', left.map(row => `${row.username}=${row.display_name}/${row.role_key}/${row.sectors}个板块`).join('，'));
  await real.end();
}

async function userByName(username) {
  const { rows: [row] } = await client.query('SELECT id, password_hash FROM leadgen.users WHERE username = $1', [username]);
  assert.ok(row, `没有账号 ${username}`);
  return row;
}
