// Figures for the overview page. Every number comes from the database;
// modules that are not open yet report null so the page can say so.

export const TRACK_STAGES = Object.freeze(['new', 'contacted', 'viewing', 'negotiating', 'signed']);
const STAGE_NAME = { new: '待联系', contacted: '已联系', viewing: '已看场', negotiating: '洽谈中', signed: '已签约', lost: '已放弃' };
const FOLLOW_UP_LIMIT = 6;

/**
 * Sectors the request may see: the user's own, narrowed to one when asked.
 * @returns {string[]|null} null when the requested sector is not the user's.
 */
export function visibleSectors(user, requested) {
  if (!requested || requested === 'all') return [...user.sectors];
  return user.sectors.includes(requested) ? [requested] : null;
}

const PLATFORM_NAME = { douyin: '抖音', channels: '视频号', xiaohongshu: '小红书', moments: '朋友圈' };
const TASK_STATUS_NAME = { draft: '待确认', confirmed: '待发布', publishing: '发布中', published: '已发布', failed: '发布失败', withdrawn: '已撤回', removed: '已在平台删除' };

/** Recent publishing tasks that already have copy, plus which platforms have an account. */
async function publishingSummary(pool) {
  const [{ rows: items }, { rows: accounts }, { rows: [week] }, { rows: [reach] }] = await Promise.all([
    pool.query(`
      SELECT t.id, t.material_id, m.topic, t.platform, t.status, COALESCE(t.published_at, t.scheduled_at, t.updated_at) AS at, t.error_message
      FROM leadgen.publish_tasks t JOIN leadgen.materials m ON m.id = t.material_id
      WHERE t.body IS NOT NULL AND t.status NOT IN ('withdrawn', 'removed')
      ORDER BY (t.status IN ('failed', 'draft')) DESC, COALESCE(t.published_at, t.scheduled_at, t.updated_at) DESC LIMIT 4`),
    pool.query(`SELECT platform, bool_or(login_status = 'ok' AND NOT is_paused) AS ready, count(*)::int AS n FROM leadgen.publish_accounts WHERE purpose = 'publish' GROUP BY platform`),
    pool.query(`
      SELECT count(*) FILTER (WHERE status IN ('confirmed', 'publishing', 'published')
               AND COALESCE(published_at, scheduled_at) >= date_trunc('week', now())
               AND COALESCE(published_at, scheduled_at) < date_trunc('week', now()) + interval '7 days')::int AS planned,
             count(*) FILTER (WHERE status = 'draft' AND body IS NOT NULL)::int AS waiting
      FROM leadgen.publish_tasks`),
    // 近 30 天：发了多少、多少人看、带来多少意向消息和线索。
    pool.query(`
      SELECT (SELECT count(*)::int FROM leadgen.publish_tasks WHERE status = 'published' AND published_at > now() - interval '30 days') AS posts,
             (SELECT COALESCE(sum(stat_views), 0)::int FROM leadgen.publish_tasks WHERE status = 'published' AND published_at > now() - interval '30 days') AS views,
             (SELECT COALESCE(sum(stat_likes), 0)::int FROM leadgen.publish_tasks WHERE status = 'published' AND published_at > now() - interval '30 days') AS likes,
             (SELECT max(metrics_at) FROM leadgen.publish_tasks) AS metrics_at,
             (SELECT count(*)::int FROM leadgen.interaction_messages WHERE created_at > now() - interval '30 days'
                AND intent IN ('inquiry', 'viewing', 'cooperation', 'booking')) AS enquiries,
             (SELECT count(DISTINCT company_id)::int FROM leadgen.interaction_messages WHERE created_at > now() - interval '30 days' AND status = 'converted') AS leads`)
  ]);
  return {
    planned_this_week: week.planned,
    reach,
    waiting_confirmation: week.waiting,
    items: items.map(item => ({ ...item, platform_name: PLATFORM_NAME[item.platform], status_name: TASK_STATUS_NAME[item.status] })),
    platforms: Object.entries(PLATFORM_NAME).map(([key, name]) => {
      const account = accounts.find(row => row.platform === key);
      return { key, name, state: !account ? '未添加账号' : account.ready ? '已连接' : '待登录' };
    })
  };
}

export async function getOverview(pool, { user, sector }) {
  const sectors = visibleSectors(user, sector);
  if (!sectors) throw Object.assign(new Error('当前账号不负责这个板块'), { code: 'SECTOR_FORBIDDEN', status: 403 });
  const seesProperties = sectors.includes('office_retail');

  const [properties, companies, activity, stages, bySector, followUps] = await Promise.all([
    seesProperties ? pool.query(`
      SELECT property_type, count(*)::int AS units, COALESCE(sum(area_sqm), 0)::float AS area_sqm
      FROM leadgen.properties WHERE status = 'available' GROUP BY property_type`) : { rows: [] },
    pool.query(`
      SELECT count(*) FILTER (WHERE created_at >= date_trunc('week', now()))::int AS this_week,
             count(*) FILTER (WHERE created_at >= date_trunc('week', now()) - interval '7 days'
                                AND created_at < date_trunc('week', now()))::int AS last_week,
             count(*) FILTER (WHERE created_at >= date_trunc('week', now()) AND qualification_status = 'pending')::int AS pending_review
      FROM leadgen.companies WHERE lifecycle_status = 'ACTIVE'`),
    pool.query(`
      SELECT (SELECT count(*)::int FROM leadgen.activities a JOIN leadgen.company_sector_tracks t ON t.id = a.track_id
               WHERE a.activity_type = 'viewing' AND a.occurred_at >= date_trunc('month', now())
                 AND t.sector_key = ANY($1)) AS viewings_this_month,
             count(*) FILTER (WHERE next_follow_up_at < date_trunc('day', now()) + interval '1 day')::int AS due_today,
             count(*) FILTER (WHERE next_follow_up_at < date_trunc('day', now()))::int AS overdue,
             count(*) FILTER (WHERE viewing_at >= now())::int AS viewings_scheduled
      FROM leadgen.company_sector_tracks
      WHERE sector_key = ANY($1) AND stage NOT IN ('signed', 'lost')`, [sectors]),
    pool.query(`
      SELECT stage, count(*)::int AS n FROM leadgen.company_sector_tracks
      WHERE sector_key = ANY($1) GROUP BY stage`, [sectors]),
    pool.query(`
      SELECT s.key, s.name, count(t.id)::int AS companies
      FROM leadgen.sectors s
      LEFT JOIN leadgen.company_sector_tracks t ON t.sector_key = s.key AND t.stage NOT IN ('signed', 'lost')
      WHERE s.key = ANY($1) GROUP BY s.key, s.name, s.sort_order ORDER BY s.sort_order`, [sectors]),
    pool.query(`
      SELECT t.id, t.company_id, c.company_name, s.name AS sector_name, t.stage, t.next_follow_up_at, u.display_name AS owner_name,
             t.next_follow_up_at < date_trunc('day', now()) AS overdue
      FROM leadgen.company_sector_tracks t
      JOIN leadgen.companies c ON c.id = t.company_id
      JOIN leadgen.sectors s ON s.key = t.sector_key
      LEFT JOIN leadgen.users u ON u.id = t.owner_user_id
      WHERE t.sector_key = ANY($1) AND t.stage NOT IN ('signed', 'lost') AND t.next_follow_up_at IS NOT NULL
      ORDER BY t.next_follow_up_at LIMIT $2`, [sectors, FOLLOW_UP_LIMIT])
  ]);

  const stageCount = Object.fromEntries(stages.rows.map(row => [row.stage, row.n]));
  // Each step counts everyone who got at least that far; lost customers are shown separately.
  const funnel = TRACK_STAGES.map((stage, index) => ({
    stage,
    name: STAGE_NAME[stage],
    count: TRACK_STAGES.slice(index).reduce((sum, later) => sum + (stageCount[later] ?? 0), 0)
  }));
  const units = type => properties.rows.find(row => row.property_type === type)?.units ?? 0;

  return {
    generated_at: new Date().toISOString(),
    sectors,
    properties: seesProperties ? {
      available_units: units('retail') + units('office'),
      available_area_sqm: properties.rows.reduce((sum, row) => sum + row.area_sqm, 0),
      retail_units: units('retail'),
      office_units: units('office')
    } : null,
    companies: companies.rows[0],
    viewings_this_month: activity.rows[0].viewings_this_month,
    viewings_scheduled: activity.rows[0].viewings_scheduled ?? 0,
    follow_ups: {
      due_today: activity.rows[0].due_today,
      overdue: activity.rows[0].overdue,
      items: followUps.rows.map(row => ({ ...row, stage_name: STAGE_NAME[row.stage] }))
    },
    funnel: { steps: funnel, lost: stageCount.lost ?? 0 },
    sector_distribution: bySector.rows,
    publishing: await publishingSummary(pool)
  };
}
