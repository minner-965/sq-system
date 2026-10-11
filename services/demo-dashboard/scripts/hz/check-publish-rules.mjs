// 用真实数据库核对“确认发布”的两条规则：每日上限、同一账号两条之间至少隔 10 分钟。
// 全程在一个事务里，结束时回滚，不留下任何改动，也不会有内容进入发布队列。
// 用法（在 services/demo-dashboard 下）：npm run check:publish-rules
import assert from 'node:assert/strict';
import { createHostPool } from '../../src/db/pool.js';
import { confirmTask } from '../../src/publishing/publishingService.js';

const real = createHostPool();
const client = await real.connect();
// confirmTask 自己会开事务；这里把它的 BEGIN / COMMIT / ROLLBACK 换成保存点，外层事务最后统一回滚。
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
  const { rows: [admin] } = await client.query(`SELECT id, role_key FROM leadgen.users WHERE username = 'admin'`);
  const user = { id: admin.id, role: 'ADMIN', sectors: ['office_retail', 'hotel_apartment', 'dining'] };
  const { rows: drafts } = await client.query(`SELECT id, platform FROM leadgen.publish_tasks WHERE status = 'draft' AND body IS NOT NULL AND platform <> 'douyin' ORDER BY platform LIMIT 2`);
  assert.equal(drafts.length, 2, '需要两条还没确认的草稿');
  const [target, other] = drafts;
  const { rows: [account] } = await client.query(`
    INSERT INTO leadgen.publish_accounts (platform, account_name, daily_limit, login_status) VALUES ($1, '规则核对用', 1, 'ok') RETURNING id`, [target.platform]);
  // 这个账号今天已经发过一条（就在刚才）。
  await client.query(`UPDATE leadgen.publish_tasks SET account_id = $2, status = 'published', published_at = now() WHERE id = $1`, [other.id, account.id]);

  await assert.rejects(() => confirmTask(pool, { taskId: target.id, user }), error => error.code === 'DAILY_LIMIT_REACHED');
  console.log('每日上限 1 条、当天已发 1 条：再确认被拦下 ✔');

  await client.query('UPDATE leadgen.publish_accounts SET daily_limit = 2 WHERE id = $1', [account.id]);
  const result = await confirmTask(pool, { taskId: target.id, user });
  const minutes = (new Date(result.scheduled_at).getTime() - Date.now()) / 60000;
  assert.equal(result.moved, true);
  assert.ok(minutes > 9.5 && minutes < 10.5, `顺延了 ${minutes.toFixed(1)} 分钟`);
  console.log(`上限 2 条：可以确认，发布时间自动顺延到 ${minutes.toFixed(1)} 分钟后 ✔`);
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows } = await real.query(`SELECT status, count(*)::int AS n FROM leadgen.publish_tasks GROUP BY 1 ORDER BY 1`);
  const { rows: [left] } = await real.query(`SELECT count(*)::int AS n FROM leadgen.publish_accounts WHERE account_name = '规则核对用'`);
  console.log('回滚后任务状态：', rows.map(row => `${row.status} ${row.n}`).join('，'), '；核对用账号残留', left.n);
  await real.end();
}
