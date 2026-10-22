// 人员和权限：系统负责人在“系统设置”里查看账号、改姓名/角色/负责板块、重置密码、新建账号。
// 新密码随机生成，只在接口返回里出现一次；配置了本机账号文件时同时追加一行，和 scripts/hz/set-user.mjs 的做法一致。
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from '../auth/password.js';
import { ASSIGNABLE_ROLES } from '../auth/roles.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USERNAME_PATTERN = /^[a-z0-9_.-]{2,40}$/;
export const MAX_NAME_LENGTH = 20;

/** 16 位，大小写字母、数字、- 和 _，约 96 位随机量。 */
export function generatePassword() {
  return randomBytes(12).toString('base64url');
}

const USER_FIELDS = `
  u.id, u.username, u.display_name, u.role_key, r.name AS role_name, r.can_write, r.all_sectors, u.is_active,
  u.last_login_at, u.created_at, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
  u.password_hash IS NOT NULL AS has_password,
  COALESCE((SELECT array_agg(us.sector_key ORDER BY s.sort_order) FROM leadgen.user_sectors us
            JOIN leadgen.sectors s ON s.key = us.sector_key WHERE us.user_id = u.id), '{}') AS sectors`;

const ROLE_ORDER = `array_position(ARRAY['admin', 'boss', 'operations', 'sales', 'leasing']::text[], u.role_key)`;

export async function listUsers(pool, { actor } = {}) {
  const [{ rows: items }, { rows: roles }, { rows: sectors }] = await Promise.all([
    pool.query(`SELECT ${USER_FIELDS} FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key
                ORDER BY u.is_active DESC, ${ROLE_ORDER}, u.created_at`),
    pool.query('SELECT key, name, can_write, all_sectors FROM leadgen.roles'),
    pool.query('SELECT key, name FROM leadgen.sectors ORDER BY sort_order')
  ]);
  const assignable = roles.filter(role => ASSIGNABLE_ROLES.includes(role.key))
    .sort((a, b) => ASSIGNABLE_ROLES.indexOf(a.key) - ASSIGNABLE_ROLES.indexOf(b.key));
  return { items: items.map(item => ({ ...item, is_self: item.id === actor?.id })), roles: assignable, sectors };
}

async function getUser(client, userId) {
  if (!UUID.test(String(userId || ''))) throw fail(404, 'USER_NOT_FOUND', '没有找到这个账号');
  const { rows: [user] } = await client.query(`SELECT ${USER_FIELDS} FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key WHERE u.id = $1`, [userId]);
  if (!user) throw fail(404, 'USER_NOT_FOUND', '没有找到这个账号');
  return user;
}

export function parseDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw fail(400, 'USER_NAME_REQUIRED', '请填写姓名或称呼');
  if ([...name].length > MAX_NAME_LENGTH) throw fail(400, 'USER_NAME_TOO_LONG', `姓名不超过 ${MAX_NAME_LENGTH} 个字`);
  return name;
}

export function parseUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME_PATTERN.test(username)) throw fail(400, 'USERNAME_INVALID', '登录名用 2–40 位小写字母、数字、点、横线或下划线');
  return username;
}

/**
 * 角色和负责板块一起校验：按板块分配的角色至少选一个板块；全部板块的角色不记板块。
 * currentRole 是账号现有的角色，旧角色（招商人员）不改时仍然允许保存。
 */
export function parseRoleAndSectors({ role_key: roleKey, sectors }, { roles, sectorKeys, currentRole = null }) {
  const role = roles.find(item => item.key === roleKey);
  if (!role || (!ASSIGNABLE_ROLES.includes(roleKey) && roleKey !== currentRole)) throw fail(400, 'ROLE_INVALID', '请选择角色');
  if (role.all_sectors) return { roleKey, sectors: [] };
  if (!Array.isArray(sectors) || !sectors.length) throw fail(400, 'SECTORS_REQUIRED', '请至少选一个负责的板块');
  const unique = [...new Set(sectors)];
  if (unique.some(key => !sectorKeys.includes(key))) throw fail(400, 'SECTOR_INVALID', '板块不正确');
  return { roleKey, sectors: sectorKeys.filter(key => unique.includes(key)) };
}

async function referenceData(client) {
  // 同一个事务连接上，一条一条查。
  const { rows: roles } = await client.query('SELECT key, name, can_write, all_sectors FROM leadgen.roles');
  const { rows: sectors } = await client.query('SELECT key FROM leadgen.sectors ORDER BY sort_order');
  return { roles, sectorKeys: sectors.map(row => row.key) };
}

async function saveSectors(client, userId, sectors) {
  await client.query('DELETE FROM leadgen.user_sectors WHERE user_id = $1', [userId]);
  if (sectors.length) {
    await client.query('INSERT INTO leadgen.user_sectors (user_id, sector_key) SELECT $1, unnest($2::text[])', [userId, sectors]);
  }
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 改姓名、角色、负责板块。只传要改的字段。 */
export async function updateUser(pool, { userId, input, actor }) {
  return inTransaction(pool, async client => {
    const user = await getUser(client, userId);
    const changes = {};
    if (input.display_name !== undefined) changes.displayName = parseDisplayName(input.display_name);
    if (input.role_key !== undefined || input.sectors !== undefined) {
      const reference = await referenceData(client);
      const parsed = parseRoleAndSectors(
        { role_key: input.role_key ?? user.role_key, sectors: input.sectors ?? user.sectors },
        { ...reference, currentRole: user.role_key });
      if (user.id === actor.id && parsed.roleKey !== 'admin') {
        throw fail(400, 'CANNOT_DROP_OWN_ADMIN', '不能取消自己的系统负责人权限，请让另一位系统负责人来改');
      }
      Object.assign(changes, parsed);
    }
    if (!Object.keys(changes).length) throw fail(400, 'NOTHING_TO_CHANGE', '没有要保存的修改');
    await client.query(`
      UPDATE leadgen.users SET display_name = COALESCE($2, display_name), role_key = COALESCE($3, role_key), updated_at = now()
      WHERE id = $1`, [user.id, changes.displayName ?? null, changes.roleKey ?? null]);
    if (changes.sectors) await saveSectors(client, user.id, changes.sectors);
    return getUser(client, user.id);
  });
}

/** 新建账号。返回的 password 只出现这一次。 */
export async function createUser(pool, { input, credentialsFile, actor }) {
  const username = parseUsername(input.username);
  const displayName = parseDisplayName(input.display_name);
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const user = await inTransaction(pool, async client => {
    const parsed = parseRoleAndSectors(input, await referenceData(client));
    const { rows: [created] } = await client.query(`
      INSERT INTO leadgen.users (username, display_name, role_key, password_hash) VALUES ($1, $2, $3, $4)
      ON CONFLICT (username) DO NOTHING RETURNING id`, [username, displayName, parsed.roleKey, passwordHash]);
    if (!created) throw fail(409, 'USERNAME_TAKEN', `登录名“${username}”已经有人用了`);
    await saveSectors(client, created.id, parsed.sectors);
    return getUser(client, created.id);
  });
  const savedToFile = await recordPassword(credentialsFile, { username, password, actor, action: '新建账号' });
  return { user, password, saved_to_file: savedToFile };
}

/**
 * 重置密码：生成新密码，解除锁定，这个账号原有的登录全部失效（操作人正在用的这次登录除外）。
 * 返回的 password 只出现这一次。
 */
export async function resetPassword(pool, { userId, credentialsFile, actor, keepSessionId = null }) {
  const password = generatePassword();
  const passwordHash = await hashPassword(password);
  const user = await inTransaction(pool, async client => {
    const found = await getUser(client, userId);
    await client.query(`
      UPDATE leadgen.users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1`, [found.id, passwordHash]);
    await client.query(`DELETE FROM leadgen.user_sessions WHERE sess->>'userId' = $1 AND sid <> COALESCE($2, '')`, [found.id, keepSessionId]);
    return getUser(client, found.id);
  });
  const savedToFile = await recordPassword(credentialsFile, { username: user.username, password, actor, action: '重置密码' });
  return { user, password, saved_to_file: savedToFile };
}

/** 追加到本机账号文件（不进 Git）。没配置或写不进去时返回 false，不影响结果。 */
export async function recordPassword(file, { username, password, actor, action }) {
  if (!file) return false;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${new Date().toISOString()}  账号 ${username}  密码 ${password}  （网页${action}，操作人 ${actor?.identity ?? '-'}）\n`);
    return true;
  } catch (error) {
    console.warn(`账号文件写入失败：${error.code || error.message}`);
    return false;
  }
}
