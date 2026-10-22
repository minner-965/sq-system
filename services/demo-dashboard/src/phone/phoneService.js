// 专用安卓手机：状态、“测试一下”、两个开关（发朋友圈、在手机抖音里回私信）。
// 手机由跑在这台电脑上的发布程序操作（publisher/phone_driver.py）；页面只写请求、读结果。
// 规则：某个 App 测试通过（已登录、要用的页面能打开）以后，管理员才能打开对应的开关；开关关着时手机上什么都不发。

export const PHONE_APPS = Object.freeze({ wechat: '微信', douyin: '抖音' });
// 开关对应哪个 App 的测试。
export const SWITCH_APP = Object.freeze({ moments: 'wechat', dm: 'douyin' });
const SWITCH_NAME = { moments: '发朋友圈', dm: '在手机上回私信' };
// 测试结果多久内有效：打开开关时，要有这段时间内通过的测试。
export const TEST_VALID_DAYS = 7;
const PUBLISHER_ONLINE_SECONDS = 90;
const PHONE_FRESH_MINUTES = 5;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** 发布程序最近写下的手机状态；程序没在跑或很久没看过手机，就当不知道。 */
export async function phoneState(db) {
  const { rows: [beat] } = await db.query(`
    SELECT last_seen_at > now() - make_interval(secs => $1) AS online, phone,
           phone_checked_at > now() - make_interval(mins => $2) AS phone_fresh
    FROM leadgen.publisher_heartbeat WHERE id = 1`, [PUBLISHER_ONLINE_SECONDS, PHONE_FRESH_MINUTES]);
  const known = Boolean(beat?.online && beat.phone_fresh && beat.phone);
  const phone = known ? beat.phone : {};
  return {
    publisher_online: Boolean(beat?.online),
    known,
    connected: Boolean(phone.connected),
    ready: Boolean(phone.ready),
    model: phone.model || null,
    wechat_installed: Boolean(phone.wechat),
    douyin_installed: Boolean(phone.douyin),
    note: known ? String(phone.note || '') : beat?.online ? '还没有读到手机的状态，请稍等一分钟' : '发布程序没有在运行，不知道手机的状态'
  };
}

/** 两个 App 最近一次测试（已完成的那次）和正在进行的测试。 */
async function lastChecks(db) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (app) app, id, status, logged_in, page_ok, message, screenshot, created_at, finished_at
    FROM leadgen.phone_check_requests ORDER BY app, (status IN ('queued', 'running')) DESC, created_at DESC`);
  const { rows: finished } = await db.query(`
    SELECT DISTINCT ON (app) app, status = 'succeeded' AS passed, finished_at > now() - make_interval(days => $1) AS recent
    FROM leadgen.phone_check_requests WHERE finished_at IS NOT NULL ORDER BY app, finished_at DESC`, [TEST_VALID_DAYS]);
  return Object.fromEntries(Object.keys(PHONE_APPS).map(app => {
    const row = rows.find(item => item.app === app);
    const done = finished.find(item => item.app === app);
    return [app, {
      app, app_name: PHONE_APPS[app],
      status: row?.status ?? null,
      running: ['queued', 'running'].includes(row?.status),
      message: row?.message ?? null,
      screenshot_url: row?.screenshot ? `/media/${row.screenshot}` : null,
      requested_at: row?.created_at ?? null,
      finished_at: row?.finished_at ?? null,
      // 最近一次完成的测试通过了，并且在有效期内。
      passed: Boolean(done?.passed && done.recent)
    }];
  }));
}

async function settings(db) {
  const { rows: [row] } = await db.query(`
    SELECT s.moments_enabled, s.moments_enabled_at, m.display_name AS moments_enabled_by_name,
           s.dm_enabled, s.dm_enabled_at, d.display_name AS dm_enabled_by_name
    FROM leadgen.phone_settings s
    LEFT JOIN leadgen.users m ON m.id = s.moments_enabled_by
    LEFT JOIN leadgen.users d ON d.id = s.dm_enabled_by
    WHERE s.id = 1`);
  return row ?? { moments_enabled: false, dm_enabled: false };
}

/**
 * 能不能在收件箱里直接确认、由手机发出私信回复：开关开着、抖音最近一次测试通过、
 * 而且现在手机连着、装了抖音。少一样就退回“复制到手机上回”。
 */
export async function phoneDmEnabled(db) {
  // 一个接一个查：db 可能是事务里的同一个连接，不能并发。
  const state = await phoneState(db);
  const checks = await lastChecks(db);
  const switches = await settings(db);
  return Boolean(switches.dm_enabled && checks.douyin.passed && state.connected && state.douyin_installed);
}

/** “发布账号”页上“专用手机”这张卡片要的全部内容。 */
export async function phonePanel(pool) {
  const [state, checks, switches] = await Promise.all([phoneState(pool), lastChecks(pool), settings(pool)]);
  return {
    ...state,
    checks,
    switches: {
      moments: { enabled: Boolean(switches.moments_enabled), enabled_at: switches.moments_enabled_at ?? null, enabled_by: switches.moments_enabled_by_name ?? null,
        can_enable: checks.wechat.passed, working: Boolean(switches.moments_enabled && checks.wechat.passed && state.connected && state.wechat_installed) },
      dm: { enabled: Boolean(switches.dm_enabled), enabled_at: switches.dm_enabled_at ?? null, enabled_by: switches.dm_enabled_by_name ?? null,
        can_enable: checks.douyin.passed, working: Boolean(switches.dm_enabled && checks.douyin.passed && state.connected && state.douyin_installed) }
    },
    test_valid_days: TEST_VALID_DAYS
  };
}

/** “测试一下”：请发布程序在手机上打开这个 App 看一眼、截图。不发任何内容。 */
export async function requestPhoneCheck(pool, { app, user }) {
  if (!PHONE_APPS[app]) throw fail(400, 'PHONE_APP_INVALID', '请选择要测试的 App');
  const state = await phoneState(pool);
  if (!state.publisher_online) throw fail(409, 'PUBLISHER_OFFLINE', '发布程序没有在运行。请先在这台电脑上双击 publisher 文件夹里的 start-publisher.cmd');
  if (state.known && !state.connected) throw fail(409, 'PHONE_NOT_CONNECTED', `手机现在用不了：${state.note}`);
  const { rows: [open] } = await pool.query(`SELECT 1 FROM leadgen.phone_check_requests WHERE status IN ('queued', 'running') LIMIT 1`);
  if (open) throw fail(409, 'PHONE_CHECK_RUNNING', '手机正在测试，请等这一次做完');
  const { rows: [row] } = await pool.query('INSERT INTO leadgen.phone_check_requests (app, requested_by) VALUES ($1, $2) RETURNING id', [app, user.id]);
  return { id: row.id, status: 'queued' };
}

/** 打开或关闭开关。打开要有最近通过的测试，并记下是谁打开的；关闭随时可以。 */
export async function setPhoneSwitch(pool, { feature, enabled, user }) {
  if (!SWITCH_APP[feature]) throw fail(400, 'PHONE_SWITCH_INVALID', '开关不正确');
  if (typeof enabled !== 'boolean') throw fail(400, 'PHONE_SWITCH_INVALID', '请说明是打开还是关闭');
  if (enabled) {
    const checks = await lastChecks(pool);
    const app = SWITCH_APP[feature];
    if (!checks[app].passed) {
      throw fail(409, 'PHONE_TEST_REQUIRED', `打开“${SWITCH_NAME[feature]}”之前，先点“测试一下${PHONE_APPS[app]}”，并且要在 ${TEST_VALID_DAYS} 天内通过`);
    }
  }
  const column = feature === 'moments' ? 'moments' : 'dm';
  await pool.query(`
    UPDATE leadgen.phone_settings SET ${column}_enabled = $1,
      ${column}_enabled_by = CASE WHEN $1 THEN $2::uuid ELSE ${column}_enabled_by END,
      ${column}_enabled_at = CASE WHEN $1 THEN now() ELSE ${column}_enabled_at END, updated_at = now()
    WHERE id = 1`, [enabled, user.id]);
  return phonePanel(pool);
}
