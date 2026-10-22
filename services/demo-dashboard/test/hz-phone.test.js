import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DM_SENDING_AVAILABLE, confirmReply, decorate, listInbox } from '../src/inbox/inboxService.js';
import { phoneDmEnabled, phonePanel, requestPhoneCheck, setPhoneSwitch } from '../src/phone/phoneService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const MESSAGE_ID = '11111111-2222-3333-4444-555555555555';
const user = { id: '99999999-2222-3333-4444-555555555555', displayName: '测试', sectors: ['office_retail'] };

/**
 * A stand-in for the database: answers the handful of queries the phone gating makes,
 * from a small state object, and records every statement.
 */
function fakeDb({ online = true, phone = { connected: true, ready: true, douyin: true, wechat: true, note: '手机已连接，可以使用' },
  checks = [], settings = { moments_enabled: false, dm_enabled: false }, message = null } = {}) {
  const statements = [];
  const query = async (sql, params = []) => {
    statements.push({ sql, params });
    if (/FROM leadgen\.publisher_heartbeat/.test(sql)) return { rows: [{ online, phone, phone_fresh: true }] };
    if (/WHERE finished_at IS NOT NULL ORDER BY app, finished_at DESC/.test(sql)) {
      return { rows: checks.filter(check => check.finished_at).map(check => ({ app: check.app, passed: check.status === 'succeeded', recent: check.recent !== false })) };
    }
    if (/SELECT DISTINCT ON \(app\)/.test(sql)) return { rows: checks };
    if (/FROM leadgen\.phone_settings s/.test(sql)) return { rows: [settings] };
    if (/FROM leadgen\.phone_check_requests WHERE status IN/.test(sql)) return { rows: checks.filter(check => ['queued', 'running'].includes(check.status)).slice(0, 1).map(() => ({ '?column?': 1 })) };
    if (/INSERT INTO leadgen\.phone_check_requests/.test(sql)) return { rows: [{ id: 'new-check' }] };
    if (/SELECT \* FROM leadgen\.interaction_messages/.test(sql)) return { rows: message ? [message] : [] };
    if (/FROM leadgen\.leasing_policy/.test(sql)) return { rows: [{ property_type: 'office', floor_price_per_sqm: 35 }] };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release() {} };
  return { statements, query, connect: async () => client };
}

const passedDouyin = [{ app: 'douyin', status: 'succeeded', finished_at: new Date().toISOString(), message: '抖音已登录，消息页能打开', screenshot: 'phone-checks/a.png' }];
const passedWechat = [{ app: 'wechat', status: 'succeeded', finished_at: new Date().toISOString(), message: '微信已登录', screenshot: null }];
const strangerDm = { id: MESSAGE_ID, platform: 'douyin', kind: 'direct_message', source: 'reader', account_id: 'acc', publish_task_id: null, reply_status: 'none', content: '1307 还租吗', company_id: null };

test('sending direct messages from the computer stays off; the stranger auto-reply stays off with it', () => {
  assert.equal(DM_SENDING_AVAILABLE, false);
  const service = readFileSync(path.join(appRoot, 'src', 'inbox', 'inboxService.js'), 'utf8');
  // The fixed auto-reply is gated only by DM_SENDING_AVAILABLE and never goes through the phone.
  const autoReply = service.slice(service.indexOf('async function queueAutoReply'), service.indexOf('* Classifies every message that has no intent yet'));
  assert.match(autoReply, /if \(!DM_SENDING_AVAILABLE\) return false;/);
  assert.doesNotMatch(autoReply, /reply_via|phoneDm|phoneCanSend/);
});

test('a direct message can only be sent from the phone once the switch is on, the Douyin test passed and the phone is connected', async () => {
  assert.equal(await phoneDmEnabled(fakeDb({ checks: passedDouyin })), false, 'switch off');
  assert.equal(await phoneDmEnabled(fakeDb({ settings: { dm_enabled: true } })), false, 'never tested');
  assert.equal(await phoneDmEnabled(fakeDb({ settings: { dm_enabled: true }, checks: [{ ...passedDouyin[0], status: 'failed' }] })), false, 'last test failed');
  assert.equal(await phoneDmEnabled(fakeDb({ settings: { dm_enabled: true }, checks: [{ ...passedDouyin[0], recent: false }] })), false, 'test too old');
  assert.equal(await phoneDmEnabled(fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin, phone: { connected: false } })), false, 'phone unplugged');
  assert.equal(await phoneDmEnabled(fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin, online: false })), false, 'publisher not running');
  assert.equal(await phoneDmEnabled(fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin })), true);
});

test('the inbox send button is live for Douyin direct messages only while phone sending works', () => {
  assert.deepEqual([decorate(strangerDm, false).can_send, decorate(strangerDm, false).send_via_phone], [false, false]);
  assert.deepEqual([decorate(strangerDm, true).can_send, decorate(strangerDm, true).send_via_phone], [true, true]);
  assert.equal(decorate({ ...strangerDm, source: 'manual' }, true).can_send, false, 'typed in by hand: no conversation to send into');
  assert.equal(decorate({ ...strangerDm, platform: 'xiaohongshu' }, true).can_send, false, 'the phone only answers in Douyin');
  const comment = decorate({ ...strangerDm, kind: 'comment' }, false);
  assert.deepEqual([comment.can_send, comment.send_via_phone], [true, false]);
});

test('listInbox tells the page whether phone sending is on', async () => {
  const db = fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin });
  const original = db.query;
  db.query = async (sql, params) => /FROM leadgen\.interaction_messages i\s+LEFT JOIN leadgen\.users/.test(sql) ? { rows: [strangerDm] }
    : /count\(\*\) FILTER/.test(sql) ? { rows: [{ chat: 0, spam: 0, pending: 0 }] } : /GROUP BY i\.status/.test(sql) ? { rows: [] } : original(sql, params);
  const result = await listInbox(db, { status: 'new', user });
  assert.equal(result.phone_dm, true);
  assert.equal(result.items[0].send_via_phone, true);
});

test('confirming a direct message reply queues it for the phone only when phone sending works; otherwise it is copied by hand', async () => {
  const on = fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin, message: strangerDm });
  assert.deepEqual(await confirmReply(on, { messageId: MESSAGE_ID, text: '您好，1307 还在租，方便留个电话吗', user }), { reply_status: 'queued', reply_via: 'phone' });
  const update = on.statements.find(statement => /UPDATE leadgen\.interaction_messages SET reply_text/.test(statement.sql));
  assert.deepEqual([update.params[2], update.params[3], update.params[5]], ['queued', user.id, 'phone']);

  const off = fakeDb({ checks: passedDouyin, message: strangerDm });
  assert.deepEqual(await confirmReply(off, { messageId: MESSAGE_ID, text: '您好', user }), { reply_status: 'failed', reply_via: null });

  const byHand = fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin, message: strangerDm });
  assert.deepEqual(await confirmReply(byHand, { messageId: MESSAGE_ID, text: '您好', manual: true, user }), { reply_status: 'manual', reply_via: null });

  const floor = fakeDb({ settings: { dm_enabled: true }, checks: passedDouyin, message: strangerDm });
  await assert.rejects(confirmReply(floor, { messageId: MESSAGE_ID, text: '底价 35 元', user }), { code: 'REPLY_FORBIDDEN_WORDING' });
});

test('a switch can only be turned on after that app passed its test, and records who turned it on', async () => {
  await assert.rejects(setPhoneSwitch(fakeDb(), { feature: 'dm', enabled: true, user }), { code: 'PHONE_TEST_REQUIRED' });
  await assert.rejects(setPhoneSwitch(fakeDb({ checks: passedDouyin }), { feature: 'moments', enabled: true, user }), { code: 'PHONE_TEST_REQUIRED' }, 'Douyin test does not open Moments');
  await assert.rejects(setPhoneSwitch(fakeDb({ checks: passedWechat }), { feature: 'dm', enabled: 'yes', user }), { code: 'PHONE_SWITCH_INVALID' });
  await assert.rejects(setPhoneSwitch(fakeDb(), { feature: 'auto_reply', enabled: true, user }), { code: 'PHONE_SWITCH_INVALID' });

  const db = fakeDb({ checks: passedWechat });
  await setPhoneSwitch(db, { feature: 'moments', enabled: true, user });
  const update = db.statements.find(statement => /UPDATE leadgen\.phone_settings/.test(statement.sql));
  assert.match(update.sql, /moments_enabled = \$1/);
  assert.deepEqual(update.params, [true, user.id]);

  // Turning off never needs a test.
  const off = fakeDb();
  await setPhoneSwitch(off, { feature: 'dm', enabled: false, user });
  assert.ok(off.statements.some(statement => /UPDATE leadgen\.phone_settings SET dm_enabled = \$1/.test(statement.sql)));
});

test('"test it" needs the publisher running and the phone plugged in, one test at a time', async () => {
  await assert.rejects(requestPhoneCheck(fakeDb({ online: false }), { app: 'wechat', user }), { code: 'PUBLISHER_OFFLINE' });
  await assert.rejects(requestPhoneCheck(fakeDb({ phone: { connected: false, note: '没有连接手机' } }), { app: 'wechat', user }), { code: 'PHONE_NOT_CONNECTED' });
  await assert.rejects(requestPhoneCheck(fakeDb({ checks: [{ app: 'douyin', status: 'running' }] }), { app: 'wechat', user }), { code: 'PHONE_CHECK_RUNNING' });
  await assert.rejects(requestPhoneCheck(fakeDb(), { app: 'qq', user }), { code: 'PHONE_APP_INVALID' });
  const db = fakeDb();
  assert.deepEqual(await requestPhoneCheck(db, { app: 'douyin', user }), { id: 'new-check', status: 'queued' });
  assert.deepEqual(db.statements.at(-1).params, ['douyin', user.id]);
});

test('the phone card shows each switch, whether it can be turned on and whether it works right now', async () => {
  const panel = await phonePanel(fakeDb({ settings: { dm_enabled: true, dm_enabled_by_name: 'Simon' }, checks: passedDouyin }));
  assert.equal(panel.checks.douyin.screenshot_url, '/media/phone-checks/a.png');
  assert.deepEqual([panel.switches.dm.enabled, panel.switches.dm.working, panel.switches.dm.enabled_by], [true, true, 'Simon']);
  assert.deepEqual([panel.switches.moments.enabled, panel.switches.moments.can_enable], [false, false]);
});

test('the publisher sends from the phone only replies a person confirmed for the phone, and only Moments with the switch on', () => {
  const publisher = readFileSync(path.join(repoRoot, 'publisher', 'hz_publisher.py'), 'utf8');
  const replies = publisher.slice(publisher.indexOf('def process_replies'), publisher.indexOf('def process_due'));
  assert.match(replies, /i\.reply_via = 'phone' OR \(%s AND a\.login_status = 'ok'\)/);
  assert.match(replies, /message\["reply_via"\] == "phone"[\s\S]+phone_switches\(conn\)\["dm_enabled"\][\s\S]+send_douyin_message/);
  const moments = publisher.slice(publisher.indexOf('def publish_moments'), publisher.indexOf('def publish('));
  assert.ok(moments.indexOf('phone_switches(conn)["moments_enabled"]') < moments.indexOf('post_moments('));
  const driver = readFileSync(path.join(repoRoot, 'publisher', 'phone_driver.py'), 'utf8');
  assert.doesNotMatch(driver, /MOMENTS_READY = True|DOUYIN_MESSAGE_READY = True/);
  const migration = readFileSync(path.join(repoRoot, 'database', 'migrations', '098_hz_phone_checks.sql'), 'utf8');
  assert.match(migration, /CHECK \(NOT moments_enabled OR moments_enabled_by IS NOT NULL\)/);
  assert.match(migration, /CHECK \(NOT dm_enabled OR dm_enabled_by IS NOT NULL\)/);
});
