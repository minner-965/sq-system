// 在真实数据库上把专用手机的迁移和查询走一遍，全部在一个事务里做完后回滚，不留下任何改动。
// 用法（services/demo-dashboard 下）：node --env-file=../../.env scripts/hz/check-phone-db.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { confirmReply, listInbox } from '../../src/inbox/inboxService.js';
import { phoneDmEnabled, phonePanel, requestPhoneCheck, setPhoneSwitch } from '../../src/phone/phoneService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const client = new pg.Client({
  host: process.env.HZ_DB_HOST || '127.0.0.1', port: Number(process.env.HZ_DB_PORT || process.env.POSTGRES_HOST_PORT || 5433),
  database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD
});
// 服务里的 inTransaction 会自己 BEGIN/COMMIT：在外层事务里换成保存点，最后整体回滚。
const db = {
  query: (sql, params) => client.query(sql, params),
  connect: async () => ({
    query: (sql, params) => sql === 'BEGIN' ? client.query('SAVEPOINT svc') : sql === 'COMMIT' ? client.query('RELEASE SAVEPOINT svc')
      : sql === 'ROLLBACK' ? client.query('ROLLBACK TO SAVEPOINT svc') : client.query(sql, params),
    release() {}
  })
};
const ok = (label, value) => console.log(`${value ? '通过' : '没通过'}  ${label}`);

await client.connect();
await client.query('BEGIN');
try {
  const applied = await client.query(`SELECT to_regclass('leadgen.phone_settings') IS NOT NULL AS has`);
  if (!applied.rows[0].has) await client.query(readFileSync(path.join(root, 'database', 'migrations', '098_hz_phone_checks.sql'), 'utf8'));
  const { rows: [admin] } = await client.query(`SELECT id, display_name FROM leadgen.users WHERE role_key = 'admin' ORDER BY created_at LIMIT 1`);
  const user = { id: admin.id, displayName: admin.display_name, sectors: ['office_retail', 'hotel_apartment', 'dining'] };
  // 发布程序在线、手机连着（只在这个事务里假装）。
  await client.query(`UPDATE leadgen.publisher_heartbeat SET last_seen_at = now(), phone_checked_at = now(),
    phone = '{"connected":true,"ready":true,"wechat":true,"douyin":true,"note":"手机已连接，可以使用","model":"测试机"}' WHERE id = 1`);

  let panel = await phonePanel(db);
  ok('一开始两个开关都关着、不能打开', !panel.switches.moments.enabled && !panel.switches.dm.can_enable);
  try { await setPhoneSwitch(db, { feature: 'dm', enabled: true, user }); ok('没测试不能打开', false); } catch (error) { ok(`没测试不能打开（${error.message}）`, error.code === 'PHONE_TEST_REQUIRED'); }
  const check = await requestPhoneCheck(db, { app: 'douyin', user });
  try { await requestPhoneCheck(db, { app: 'wechat', user }); ok('一次只测一个', false); } catch (error) { ok('一次只测一个', error.code === 'PHONE_CHECK_RUNNING'); }
  // 发布程序做完测试后写回的结果（和 hz_publisher.process_phone_checks 写的一样）。
  await client.query(`UPDATE leadgen.phone_check_requests SET status = 'succeeded', logged_in = true, page_ok = true, message = '抖音已登录，消息页能打开',
    screenshot = 'phone-checks/x.png', finished_at = now() WHERE id = $1`, [check.id]);
  panel = await setPhoneSwitch(db, { feature: 'dm', enabled: true, user });
  ok('测试通过后能打开，并记下是谁打开的', panel.switches.dm.enabled && panel.switches.dm.working && panel.switches.dm.enabled_by === admin.display_name);
  ok('收件箱认得手机能发私信', await phoneDmEnabled(db));

  // 发布程序读开关的那条查询（hz_publisher.phone_switches）。
  const { rows: [switches] } = await client.query(`SELECT s.moments_enabled, s.dm_enabled,
      (SELECT r.status = 'succeeded' FROM leadgen.phone_check_requests r WHERE r.app = 'wechat' AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC LIMIT 1) AS wechat_ok,
      (SELECT r.status = 'succeeded' FROM leadgen.phone_check_requests r WHERE r.app = 'douyin' AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC LIMIT 1) AS douyin_ok
    FROM leadgen.phone_settings s WHERE s.id = 1`);
  ok('发布程序读到的开关一致', switches.dm_enabled && switches.douyin_ok && !switches.moments_enabled && switches.wechat_ok === null);

  const { rows: [account] } = await client.query(`SELECT id FROM leadgen.publish_accounts WHERE platform = 'douyin' ORDER BY created_at LIMIT 1`);
  const { rows: [message] } = await client.query(`
    INSERT INTO leadgen.interaction_messages (platform, kind, platform_message_id, account_id, sender_name, sender_platform_id, content, sent_at, source, intent, status)
    VALUES ('douyin', 'direct_message', 'dm:phone-check', $1, '测试王先生', 'name:测试王先生', '1307 还租吗', now(), 'reader', 'inquiry', 'new') RETURNING id`, [account.id]);
  const inbox = await listInbox(db, { status: 'new', user });
  ok('收件箱里这条私信的发送按钮可以点', inbox.phone_dm && inbox.items.find(item => item.id === message.id)?.send_via_phone === true);
  const result = await confirmReply(db, { messageId: message.id, text: '您好，1307 还在租，方便留个电话吗', user });
  ok('确认后排给专用手机', result.reply_status === 'queued' && result.reply_via === 'phone');
  // 发布程序取待发回复的查询（hz_publisher.process_replies），这条要能被取到。
  const { rows: picked } = await client.query(`
    SELECT i.id, i.reply_via FROM leadgen.interaction_messages i JOIN leadgen.publish_accounts a ON a.id = i.account_id
    LEFT JOIN leadgen.publish_tasks t ON t.id = i.publish_task_id
    WHERE i.reply_status = 'queued' AND i.platform = 'douyin' AND NOT a.is_paused
      AND ((i.kind = 'comment' AND t.id IS NOT NULL AND a.login_status = 'ok')
           OR (i.kind = 'direct_message' AND i.source = 'reader' AND (i.reply_via = 'phone' OR (false AND a.login_status = 'ok'))
               AND NOT EXISTS (SELECT 1 FROM leadgen.interaction_messages recent WHERE recent.kind = 'direct_message' AND recent.account_id = i.account_id AND recent.replied_at > now() - make_interval(mins => 3))))
    ORDER BY i.reply_confirmed_at LIMIT 1`);
  ok('发布程序能取到这条，交给手机发', picked[0]?.id === message.id && picked[0].reply_via === 'phone');

  await setPhoneSwitch(db, { feature: 'dm', enabled: false, user });
  ok('关掉开关后收件箱退回“复制到手机上回”', !(await phoneDmEnabled(db)));
} finally {
  await client.query('ROLLBACK');
  await client.end();
  console.log('已回滚，数据库没有改动。');
}
