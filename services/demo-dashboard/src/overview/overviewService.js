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
    // 内容发布在 WP06 开通。
    publishing: null
  };
}
