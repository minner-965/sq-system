// 新建账号或重置密码。密码随机生成，只写到本机的 data/accounts.local.txt（不进 Git），不在屏幕上显示。
// 用法（在 services/demo-dashboard 下）：
//   npm run user:set -- --username boss --name 老板 --role boss
//   npm run user:set -- --username lin --name 销售 --role sales --sectors office_retail,dining
//   npm run user:set -- --username admin                （只重置密码）
// 角色：admin 系统负责人、boss 老板（只读）、operations 运营（全部板块）、sales 销售（按板块）；leasing 招商人员是旧角色。
// 系统负责人也可以在网页“系统设置 → 人员和权限”里做这些事。
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hashPassword } from '../../src/auth/password.js';
import { createHostPool } from '../../src/db/pool.js';

const { values } = parseArgs({ options: {
  username: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, sectors: { type: 'string' }
} });
const username = String(values.username || '').trim().toLowerCase();
if (!username) { console.error('缺少 --username'); process.exit(1); }

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const credentialsFile = path.join(projectRoot, 'data', 'accounts.local.txt');
const password = randomBytes(12).toString('base64url');
const pool = createHostPool();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [existing] } = await client.query('SELECT id FROM leadgen.users WHERE username = $1', [username]);
  if (!existing && !(values.name && values.role)) throw new Error('新账号需要 --name 和 --role');
  const { rows: [user] } = await client.query(`
    INSERT INTO leadgen.users (username, display_name, role_key, password_hash)
    VALUES ($1, COALESCE($2, $1), COALESCE($3, 'sales'), $4)
    ON CONFLICT (username) DO UPDATE SET
      display_name = COALESCE($2, users.display_name), role_key = COALESCE($3, users.role_key),
      password_hash = $4, failed_login_count = 0, locked_until = NULL, is_active = true, updated_at = now()
    RETURNING id, display_name, role_key`,
  [username, values.name ?? null, values.role ?? null, await hashPassword(password)]);
  if (values.sectors !== undefined) {
    await client.query('DELETE FROM leadgen.user_sectors WHERE user_id = $1', [user.id]);
    for (const sector of values.sectors.split(',').map(item => item.trim()).filter(Boolean)) {
      await client.query('INSERT INTO leadgen.user_sectors (user_id, sector_key) VALUES ($1, $2)', [user.id, sector]);
    }
  }
  // 改密码后原有登录全部失效。
  await client.query(`DELETE FROM leadgen.user_sessions WHERE sess->>'userId' = $1`, [user.id]);
  await client.query('COMMIT');
  mkdirSync(path.dirname(credentialsFile), { recursive: true });
  appendFileSync(credentialsFile, `${new Date().toISOString()}  账号 ${username}  密码 ${password}\n`);
  console.log(`${existing ? '已重置密码' : '已新建账号'}：${username}（${user.display_name}，${user.role_key}）`);
  console.log(`密码写在 ${path.relative(projectRoot, credentialsFile)}，以最后一行为准`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
