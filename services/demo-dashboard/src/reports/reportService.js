// 报表：招商漏斗、渠道效果、人员工作量。都是直接从业务记录里数出来的，没有估算。
// 需求见 docs/hz/执行计划_V1.2.md 的 WP09。
import ExcelJS from 'exceljs';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const STAGES = ['new', 'contacted', 'viewing', 'negotiating', 'signed'];
const STAGE_NAME = { new: '待联系', contacted: '已联系', viewing: '已看场', negotiating: '洽谈中', signed: '已签约', lost: '已放弃' };
const PLATFORMS = [['douyin', '抖音'], ['xiaohongshu', '小红书'], ['channels', '视频号'], ['moments', '朋友圈']];
const LEAD_INTENTS = ['inquiry', 'viewing', 'cooperation', 'booking'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_RANGE_DAYS = 366;

/** A reporting period as two calendar days in Guangzhou time, both included. Defaults to the last 30 days. */
export function parsePeriod(query, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const to = query?.to ?? today;
  const from = query?.from ?? shift(to, -29);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw fail(400, 'PERIOD_INVALID', '日期不正确');
  if (from > to) throw fail(400, 'PERIOD_INVALID', '开始日期不能晚于结束日期');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_RANGE_DAYS) throw fail(400, 'PERIOD_TOO_LONG', '一次最多看一年');
  return { from, to };
}

// 时间段的两头：从 from 当天 0 点到 to 第二天 0 点（广州时间）。
const RANGE = `>= ($1::date)::timestamp AT TIME ZONE 'Asia/Shanghai' AND {col} < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`;
const within = column => `${column} ${RANGE.replaceAll('{col}', column)}`;

/**
 * Customers first followed in the period, by how far each has got. "Reached" counts a customer at every stage it has
 * passed through, including ones later given up (their history shows which stages they reached).
 */
async function funnel(pool, period, sectors) {
  const { rows } = await pool.query(`
    SELECT t.sector_key, k.name AS sector_name, k.sort_order, t.stage,
           ARRAY(SELECT x FROM unnest($4::text[]) x WHERE EXISTS (
             SELECT 1 FROM leadgen.activities a WHERE a.track_id = t.id AND a.activity_type = 'stage' AND a.content LIKE '%' || x || '%')) AS seen
    FROM leadgen.company_sector_tracks t JOIN leadgen.sectors k ON k.key = t.sector_key
    WHERE t.sector_key = ANY($3) AND ${within('t.created_at')}`, [period.from, period.to, sectors, STAGES.map(stage => STAGE_NAME[stage])]);
  const build = tracks => {
    const reached = STAGES.map((stage, index) => tracks.filter(track =>
      index === 0 || (track.stage !== 'lost' && STAGES.indexOf(track.stage) >= index)
      // 已放弃的：看它的阶段变化记录里出现过哪些阶段，也算到过。
      || track.seen.some(name => STAGES.findIndex(key => STAGE_NAME[key] === name) >= index)).length);
    return {
      total: tracks.length,
      lost: tracks.filter(track => track.stage === 'lost').length,
      stages: STAGES.map((stage, index) => ({
        key: stage, name: STAGE_NAME[stage], reached: reached[index], now: tracks.filter(track => track.stage === stage).length,
        // 相对上一步的转化；上一步是 0 就不算。
        rate: index === 0 || !reached[index - 1] ? null : Math.round((reached[index] / reached[index - 1]) * 1000) / 10
      }))
    };
  };
  const bySector = new Map();
  for (const row of rows) {
    if (!bySector.has(row.sector_key)) bySector.set(row.sector_key, { key: row.sector_key, name: row.sector_name, order: row.sort_order, tracks: [] });
    bySector.get(row.sector_key).tracks.push(row);
  }
  return {
    all: build(rows),
    sectors: [...bySector.values()].sort((a, b) => a.order - b.order).map(({ key, name, tracks }) => ({ key, name, ...build(tracks) }))
  };
}

/** What each platform brought in during the period: posts, how many saw them, messages, and contacts left. */
async function channels(pool, period) {
  const params = [period.from, period.to];
  const [{ rows: posts }, { rows: messages }, { rows: forms }] = await Promise.all([
    pool.query(`
      SELECT platform, count(*) FILTER (WHERE status = 'published')::int AS posts, count(*) FILTER (WHERE status = 'removed')::int AS removed,
             COALESCE(sum(stat_views) FILTER (WHERE status = 'published'), 0)::int AS views,
             COALESCE(sum(stat_likes) FILTER (WHERE status = 'published'), 0)::int AS likes,
             count(*) FILTER (WHERE status = 'published' AND metrics_at IS NULL)::int AS without_numbers
      FROM leadgen.publish_tasks WHERE status IN ('published', 'removed') AND ${within('published_at')} GROUP BY platform`, params),
    pool.query(`
      SELECT platform, count(*)::int AS messages, count(*) FILTER (WHERE intent = ANY($3))::int AS enquiries,
             count(DISTINCT company_id) FILTER (WHERE status = 'converted')::int AS leads
      FROM leadgen.interaction_messages WHERE ${within('created_at')} GROUP BY platform`, [...params, LEAD_INTENTS]),
    pool.query(`
      SELECT COALESCE(source_platform, 'none') AS platform, count(*)::int AS submissions, count(DISTINCT phone)::int AS people
      FROM leadgen.lead_submissions WHERE ${within('created_at')} GROUP BY 1`, params)
  ]);
  const pick = (rows, platform) => rows.find(row => row.platform === platform) || {};
  const items = PLATFORMS.map(([key, name]) => {
    const post = pick(posts, key);
    const message = pick(messages, key);
    const form = pick(forms, key);
    return {
      key, name, posts: post.posts ?? 0, removed: post.removed ?? 0, views: post.views ?? 0, likes: post.likes ?? 0,
      // 有的平台读不到数字（比如视频号），不能当成 0 人看。
      numbers_missing: (post.posts ?? 0) > 0 && post.without_numbers === post.posts,
      messages: message.messages ?? 0, enquiries: message.enquiries ?? 0, message_leads: message.leads ?? 0,
      form_leads: form.people ?? 0, form_submissions: form.submissions ?? 0
    };
  });
  const general = pick(forms, 'none');
  if (general.submissions) {
    items.push({ key: 'none', name: '通用留资页', posts: 0, removed: 0, views: 0, likes: 0, numbers_missing: false, messages: 0, enquiries: 0, message_leads: 0,
      form_leads: general.people, form_submissions: general.submissions });
  }
  return items;
}

/** What each person did in the period. Leasing staff see only their own row. */
async function workload(pool, period, sectors, user) {
  const { rows } = await pool.query(`
    WITH people AS (
      SELECT u.id, u.display_name, r.name AS role_name FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key
      WHERE u.is_active AND r.can_write AND ($4::uuid IS NULL OR u.id = $4)
    ), acts AS (
      SELECT a.created_by AS user_id,
             count(*) FILTER (WHERE a.activity_type = 'call')::int AS calls, count(*) FILTER (WHERE a.activity_type = 'wechat')::int AS wechats,
             count(*) FILTER (WHERE a.activity_type = 'visit')::int AS visits, count(*) FILTER (WHERE a.activity_type = 'viewing')::int AS viewings,
             count(*) FILTER (WHERE a.activity_type = 'note')::int AS notes, count(*) FILTER (WHERE a.activity_type = 'stage')::int AS stage_changes
      FROM leadgen.activities a JOIN leadgen.company_sector_tracks t ON t.id = a.track_id
      WHERE t.sector_key = ANY($3) AND a.created_by IS NOT NULL AND ${within('a.occurred_at')} GROUP BY 1
    ), owned AS (
      SELECT t.owner_user_id AS user_id, count(*) FILTER (WHERE ${within('t.created_at')})::int AS new_customers,
             count(*) FILTER (WHERE t.stage = 'signed' AND ${within('t.stage_changed_at')})::int AS signed,
             count(*) FILTER (WHERE t.stage NOT IN ('signed', 'lost'))::int AS open_now
      FROM leadgen.company_sector_tracks t WHERE t.sector_key = ANY($3) AND t.owner_user_id IS NOT NULL GROUP BY 1
    ), replies AS (
      SELECT reply_confirmed_by AS user_id, count(*)::int AS replies FROM leadgen.interaction_messages
      WHERE reply_confirmed_by IS NOT NULL AND NOT reply_auto AND reply_status IN ('sent', 'manual') AND ${within('reply_confirmed_at')} GROUP BY 1
    ), posts AS (
      SELECT confirmed_by AS user_id, count(*)::int AS posts FROM leadgen.publish_tasks
      WHERE confirmed_by IS NOT NULL AND status IN ('published', 'removed') AND ${within('published_at')} GROUP BY 1
    )
    SELECT p.id, p.display_name, p.role_name,
           COALESCE(a.calls, 0) AS calls, COALESCE(a.wechats, 0) AS wechats, COALESCE(a.visits, 0) AS visits, COALESCE(a.viewings, 0) AS viewings,
           COALESCE(a.notes, 0) AS notes, COALESCE(a.stage_changes, 0) AS stage_changes,
           COALESCE(o.new_customers, 0) AS new_customers, COALESCE(o.signed, 0) AS signed, COALESCE(o.open_now, 0) AS open_now,
           COALESCE(r.replies, 0) AS replies, COALESCE(s.posts, 0) AS posts
    FROM people p LEFT JOIN acts a ON a.user_id = p.id LEFT JOIN owned o ON o.user_id = p.id
    LEFT JOIN replies r ON r.user_id = p.id LEFT JOIN posts s ON s.user_id = p.id
    ORDER BY (COALESCE(a.calls, 0) + COALESCE(a.wechats, 0) + COALESCE(a.visits, 0) + COALESCE(a.viewings, 0) + COALESCE(a.notes, 0)) DESC, p.display_name`,
  [period.from, period.to, sectors, user.role === 'LEASING' ? user.id : null]);
  return rows.map(row => ({ ...row, follow_ups: row.calls + row.wechats + row.visits + row.viewings + row.notes }));
}

export async function getReport(pool, { user, sectors, query }) {
  const period = parsePeriod(query);
  const [funnelData, channelData, people] = await Promise.all([
    funnel(pool, period, sectors), channels(pool, period), workload(pool, period, sectors, user)
  ]);
  return { period, funnel: funnelData, channels: channelData, workload: people, own_row_only: user.role === 'LEASING' };
}

/** The same three tables as one workbook, one sheet each. */
export async function buildReportWorkbook(report, { sectorName }) {
  const book = new ExcelJS.Workbook();
  book.created = new Date();
  const sheet = (name, columns, rows, note) => {
    const page = book.addWorksheet(name);
    page.addRow([`${name}　${report.period.from} 至 ${report.period.to}　${sectorName}`]).font = { bold: true, size: 12 };
    if (note) page.addRow([note]).font = { color: { argb: 'FF6B7280' }, size: 10 };
    page.addRow([]);
    const head = page.addRow(columns.map(column => column[0]));
    head.font = { bold: true };
    head.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F6' } }; cell.border = { bottom: { style: 'thin', color: { argb: 'FFD5DAE1' } } }; });
    for (const row of rows) page.addRow(columns.map(column => column[1](row)));
    columns.forEach((column, index) => { page.getColumn(index + 1).width = column[2] ?? 14; });
    page.views = [{ state: 'frozen', ySplit: head.number }];
  };
  const rate = value => (value == null ? '—' : `${value}%`);
  const funnelRows = [{ name: '合计', ...report.funnel.all }, ...report.funnel.sectors].flatMap(group =>
    group.stages.map(stage => ({ group: group.name, total: group.total, lost: group.lost, ...stage })));
  sheet('招商漏斗', [
    ['板块', row => row.group, 16], ['阶段', row => row.name, 12], ['到过这一步的客户数', row => row.reached, 20], ['相对上一步', row => rate(row.rate), 14],
    ['现在停在这一步', row => row.now, 18], ['这期间新增客户', row => row.total, 16], ['其中已放弃', row => row.lost, 12]
  ], funnelRows, '统计的是这段时间里新开始跟进的客户。“到过这一步”包括后来放弃的。');
  sheet('渠道效果', [
    ['渠道', row => row.name, 14], ['发布条数', row => row.posts, 10], ['后来删除', row => row.removed, 10],
    ['浏览', row => (row.numbers_missing ? '读不到' : row.views), 10], ['点赞', row => (row.numbers_missing ? '读不到' : row.likes), 10],
    ['评论和私信', row => row.messages, 12], ['其中有意向', row => row.enquiries, 12], ['转成线索（人）', row => row.message_leads, 14], ['扫码留资（人）', row => row.form_leads, 14]
  ], report.channels, '浏览和点赞是这段时间发布的帖子到现在的累计数。视频号和朋友圈读不到数字。');
  sheet('人员工作量', [
    ['姓名', row => row.display_name, 12], ['角色', row => row.role_name, 12], ['跟进记录', row => row.follow_ups, 10], ['电话', row => row.calls, 8], ['微信', row => row.wechats, 8],
    ['拜访', row => row.visits, 8], ['看场', row => row.viewings, 8], ['备注', row => row.notes, 8], ['推进阶段', row => row.stage_changes, 10],
    ['新增客户', row => row.new_customers, 10], ['签约', row => row.signed, 8], ['手上在跟', row => row.open_now, 10], ['回复（已发出）', row => row.replies, 14], ['确认发布', row => row.posts, 10]
  ], report.workload, '“手上在跟”是现在的数，其余是这段时间里发生的。');
  return Buffer.from(await book.xlsx.writeBuffer());
}
