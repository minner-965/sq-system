// 招商客户：企业在各板块的跟进、跟进记录、房源匹配、底价提示。
// 底价数字只在服务端比较，任何返回里都不带。

export const STAGES = Object.freeze(['new', 'contacted', 'viewing', 'negotiating', 'signed', 'lost']);
export const STAGE_NAME = Object.freeze({ new: '待联系', contacted: '已联系', viewing: '已看场', negotiating: '洽谈中', signed: '已签约', lost: '已放弃' });
export const LOST_REASON_NAME = Object.freeze({ price: '价格贵', location: '位置不合适', layout: '格局不合适', other: '其他' });
export const ACTIVITY_NAME = Object.freeze({ call: '电话', visit: '拜访', viewing: '看场', wechat: '微信', note: '备注', stage: '阶段变化' });
const MANUAL_ACTIVITY_TYPES = ['call', 'visit', 'viewing', 'wechat', 'note'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const requireUuid = (value, code = 'NOT_FOUND') => { if (!UUID.test(String(value))) throw fail(404, code, '没有找到这条记录'); };

const TRACK_COLUMNS = `t.id, t.company_id, t.sector_key, s.name AS sector_name, t.stage, t.stage_changed_at, t.owner_user_id,
  o.display_name AS owner_name, t.intended_property_id, t.intended_service, t.intended_area_sqm::float AS intended_area_sqm,
  t.intended_price::float AS intended_price, t.next_follow_up_at, t.viewing_at, t.lost_reason, t.lost_reason_category,
  t.need_area_min::float AS need_area_min, t.need_area_max::float AS need_area_max, t.need_property_type,
  t.need_budget_per_sqm::float AS need_budget_per_sqm, t.need_open_flame, t.contact_name, t.contact_phone,
  t.below_floor_price, t.created_at, t.updated_at,
  CASE WHEN p.id IS NOT NULL THEN p.building || ' ' || p.unit_no END AS intended_property_label`;
const TRACK_JOINS = `JOIN leadgen.sectors s ON s.key = t.sector_key
  LEFT JOIN leadgen.users o ON o.id = t.owner_user_id
  LEFT JOIN leadgen.properties p ON p.id = t.intended_property_id`;

const present = track => ({ ...track, stage_name: STAGE_NAME[track.stage], lost_reason_name: LOST_REASON_NAME[track.lost_reason_category] ?? null });

export async function listCustomers(pool, { user, sectors, stage, search, mine, limit = 50, offset = 0 }) {
  if (stage && !STAGES.includes(stage)) throw fail(400, 'STAGE_INVALID', '阶段不正确');
  const params = [sectors, search ? `%${search}%` : null, mine ? user.id : null];
  const scope = `t.sector_key = ANY($1) AND ($2::text IS NULL OR c.company_name ILIKE $2) AND ($3::uuid IS NULL OR t.owner_user_id = $3)`;
  const [{ rows }, { rows: counts }] = await Promise.all([
    pool.query(`
      SELECT ${TRACK_COLUMNS}, c.company_name, c.address, c.phone AS company_phone,
             t.next_follow_up_at < date_trunc('day', now()) AND t.stage NOT IN ('signed', 'lost') AS overdue,
             (SELECT max(a.occurred_at) FROM leadgen.activities a WHERE a.track_id = t.id AND a.activity_type <> 'stage') AS last_activity_at
      FROM leadgen.company_sector_tracks t JOIN leadgen.companies c ON c.id = t.company_id ${TRACK_JOINS}
      WHERE ${scope} AND ($4::text IS NULL OR t.stage = $4)
      ORDER BY (t.stage IN ('signed', 'lost')), t.next_follow_up_at NULLS LAST, t.updated_at DESC
      LIMIT $5 OFFSET $6`,
    [...params, stage || null, Math.min(Math.max(Number(limit) || 50, 1), 100), Math.max(Number(offset) || 0, 0)]),
    pool.query(`
      SELECT t.stage, count(*)::int AS n FROM leadgen.company_sector_tracks t JOIN leadgen.companies c ON c.id = t.company_id
      WHERE ${scope} GROUP BY t.stage`, params)
  ]);
  const byStage = Object.fromEntries(STAGES.map(key => [key, counts.find(row => row.stage === key)?.n ?? 0]));
  return {
    counts: { all: Object.values(byStage).reduce((sum, n) => sum + n, 0), ...byStage },
    total: stage ? byStage[stage] : Object.values(byStage).reduce((sum, n) => sum + n, 0),
    items: rows.map(present)
  };
}

/** Basic company facts are shared; follow-up detail is only shown for the user's own sectors. */
export async function getCompanyProfile(pool, { companyId, user }) {
  requireUuid(companyId, 'COMPANY_NOT_FOUND');
  const { rows: [company] } = await pool.query(`
    SELECT id, company_name, address, city, industry, phone, distance_m, website_url, unified_social_credit_code,
           employee_scale, established_on, source, source_ref, qualification_status, created_at, last_collected_at
    FROM leadgen.companies WHERE id = $1 AND lifecycle_status = 'ACTIVE'`, [companyId]);
  if (!company) throw fail(404, 'COMPANY_NOT_FOUND', '没有找到这家企业');
  const [{ rows: tracks }, { rows: candidates }, { rows: activities }] = await Promise.all([
    pool.query(`SELECT ${TRACK_COLUMNS} FROM leadgen.company_sector_tracks t ${TRACK_JOINS} WHERE t.company_id = $1 ORDER BY s.sort_order`, [companyId]),
    pool.query(`
      SELECT k.id, k.sector_key, s.name AS sector_name, k.score, k.score_items, k.notices, k.status
      FROM leadgen.company_sector_candidates k JOIN leadgen.sectors s ON s.key = k.sector_key
      WHERE k.company_id = $1 ORDER BY s.sort_order`, [companyId]),
    pool.query(`
      SELECT a.id, a.track_id, a.activity_type, a.content, a.occurred_at, a.created_at, a.snapshot, u.display_name AS created_by_name, t.sector_key, s.name AS sector_name
      FROM leadgen.activities a
      JOIN leadgen.company_sector_tracks t ON t.id = a.track_id
      JOIN leadgen.sectors s ON s.key = t.sector_key
      LEFT JOIN leadgen.users u ON u.id = a.created_by
      WHERE t.company_id = $1 AND t.sector_key = ANY($2)
      ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 200`, [companyId, [...user.sectors]])
  ]);
  return {
    company: { ...company, source_url: company.source === 'amap' ? `https://www.amap.com/place/${company.source_ref}` : null },
    candidates,
    tracks: tracks.map(track => (user.sectors.includes(track.sector_key)
      ? { ...present(track), restricted: false }
      : { id: track.id, sector_key: track.sector_key, sector_name: track.sector_name, stage: track.stage,
        stage_name: STAGE_NAME[track.stage], owner_name: track.owner_name, restricted: true })),
    activities: activities.map(item => ({ ...item, activity_name: ACTIVITY_NAME[item.activity_type],
      snapshot: item.snapshot ? { ...item.snapshot, stage_name: STAGE_NAME[item.snapshot.stage] } : null }))
  };
}

async function lockTrack(client, trackId, user) {
  requireUuid(trackId, 'TRACK_NOT_FOUND');
  const { rows: [track] } = await client.query(`
    SELECT t.*, c.company_name FROM leadgen.company_sector_tracks t JOIN leadgen.companies c ON c.id = t.company_id
    WHERE t.id = $1 FOR UPDATE OF t`, [trackId]);
  if (!track) throw fail(404, 'TRACK_NOT_FOUND', '没有找到这条跟进');
  if (!user.sectors.includes(track.sector_key)) throw fail(403, 'SECTOR_FORBIDDEN', '当前账号不负责这个板块');
  return track;
}

/** A unit follows its customers: signed once anyone signs it, in negotiation while anyone still intends to take it. */
async function syncPropertyStatus(client, propertyId) {
  if (!propertyId) return;
  await client.query(`
    UPDATE leadgen.properties p SET updated_at = now(), status = CASE
        WHEN EXISTS (SELECT 1 FROM leadgen.company_sector_tracks t WHERE t.intended_property_id = p.id AND t.stage = 'signed') THEN 'signed'
        WHEN EXISTS (SELECT 1 FROM leadgen.company_sector_tracks t WHERE t.intended_property_id = p.id AND t.stage <> 'lost') THEN 'negotiating'
        ELSE 'available' END
    WHERE p.id = $1`, [propertyId]);
}

const optionalNumber = (value, label) => {
  if (value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) throw fail(400, 'TRACK_FIELD_INVALID', `${label}应为正数`);
  return number;
};
const optionalText = (value, max = 200) => (value === null ? null : String(value).trim().slice(0, max) || null);
const optionalTime = (value, label) => {
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw fail(400, 'TRACK_FIELD_INVALID', `${label}不是有效的时间`);
  return date.toISOString();
};

const FIELD_PARSERS = {
  intended_service: value => optionalText(value),
  intended_area_sqm: value => optionalNumber(value, '意向面积'),
  intended_price: value => optionalNumber(value, '意向价'),
  next_follow_up_at: value => optionalTime(value, '下次跟进时间'),
  viewing_at: value => optionalTime(value, '看场时间'),
  need_area_min: value => optionalNumber(value, '面积下限'),
  need_area_max: value => optionalNumber(value, '面积上限'),
  need_property_type: value => { if (value !== null && !['office', 'retail'].includes(value)) throw fail(400, 'TRACK_FIELD_INVALID', '业态不正确'); return value; },
  need_budget_per_sqm: value => optionalNumber(value, '预算'),
  need_open_flame: value => Boolean(value),
  contact_name: value => optionalText(value, 40),
  contact_phone: value => optionalText(value, 40),
  lost_reason: value => optionalText(value, 300),
  lost_reason_category: value => { if (value !== null && !LOST_REASON_NAME[value]) throw fail(400, 'TRACK_FIELD_INVALID', '放弃原因不正确'); return value; }
};

/**
 * Changes a follow-up. Returns the updated track plus price_warning when the
 * intended price is under the floor; the floor itself is never returned.
 */
export async function updateTrack(pool, { trackId, user, changes }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const track = await lockTrack(client, trackId, user);
    const next = {};
    for (const [field, parse] of Object.entries(FIELD_PARSERS)) {
      if (changes[field] !== undefined) next[field] = parse(changes[field]);
    }
    if (changes.stage !== undefined) {
      if (!STAGES.includes(changes.stage)) throw fail(400, 'STAGE_INVALID', '阶段不正确');
      next.stage = changes.stage;
    }
    if (changes.owner_user_id !== undefined) {
      if (changes.owner_user_id !== null) {
        requireUuid(changes.owner_user_id, 'OWNER_INVALID');
        const { rowCount } = await client.query(`
          SELECT 1 FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key
          WHERE u.id = $1 AND u.is_active AND r.can_write
            AND (r.all_sectors OR EXISTS (SELECT 1 FROM leadgen.user_sectors us WHERE us.user_id = u.id AND us.sector_key = $2))`,
        [changes.owner_user_id, track.sector_key]);
        if (!rowCount) throw fail(400, 'OWNER_INVALID', '这位同事不负责这个板块');
      }
      next.owner_user_id = changes.owner_user_id;
    }
    let property = null;
    if (changes.intended_property_id !== undefined) {
      if (changes.intended_property_id !== null) {
        if (track.sector_key !== 'office_retail') throw fail(400, 'PROPERTY_SECTOR_MISMATCH', '只有商铺写字楼板块可以选房源');
        requireUuid(changes.intended_property_id, 'PROPERTY_NOT_FOUND');
      }
      next.intended_property_id = changes.intended_property_id;
    }
    const merged = { ...track, ...next };
    if (merged.need_area_min != null && merged.need_area_max != null && Number(merged.need_area_min) > Number(merged.need_area_max)) {
      throw fail(400, 'TRACK_FIELD_INVALID', '面积下限不能大于上限');
    }
    if (merged.intended_property_id) {
      ({ rows: [property] } = await client.query('SELECT id, property_type, status, building, unit_no FROM leadgen.properties WHERE id = $1', [merged.intended_property_id]));
      if (!property) throw fail(404, 'PROPERTY_NOT_FOUND', '没有找到这套房源');
      if (next.intended_property_id && property.status === 'signed') throw fail(409, 'PROPERTY_ALREADY_SIGNED', '这套房源已经签约');
    }
    if (merged.stage === 'lost' && !merged.lost_reason_category) throw fail(400, 'LOST_REASON_REQUIRED', '放弃时必须选择原因');
    if (merged.stage === 'signed' && track.sector_key === 'office_retail' && !merged.intended_property_id) {
      throw fail(400, 'SIGNED_NEEDS_PROPERTY', '签约前要先选定房源');
    }

    // 底价只适用于商铺写字楼；按意向房源的类型取，没选房源时按需求里的业态，默认写字楼。
    let belowFloor = false;
    if (track.sector_key === 'office_retail' && merged.intended_price != null) {
      const { rows: [policy] } = await client.query(
        'SELECT floor_price_per_sqm FROM leadgen.leasing_policy WHERE property_type = $1', [property?.property_type ?? merged.need_property_type ?? 'office']);
      belowFloor = policy?.floor_price_per_sqm != null && Number(merged.intended_price) < Number(policy.floor_price_per_sqm);
    }
    next.below_floor_price = belowFloor;
    // 低于底价的单子，只有管理员能改成已签约——这一步就是批准。
    if (belowFloor && merged.stage === 'signed' && track.stage !== 'signed' && user.role !== 'ADMIN') {
      throw fail(403, 'BELOW_FLOOR_NEEDS_ADMIN', '意向价低于公司可接受的最低条件，需要管理员批准后才能签约');
    }

    const stageChanged = next.stage !== undefined && next.stage !== track.stage;
    if (stageChanged) next.stage_changed_at = new Date().toISOString();
    const fields = Object.keys(next);
    await client.query(
      `UPDATE leadgen.company_sector_tracks SET ${fields.map((field, index) => `${field} = $${index + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [trackId, ...fields.map(field => next[field])]);

    if (stageChanged) {
      const reason = next.stage === 'lost' ? `，原因：${LOST_REASON_NAME[merged.lost_reason_category]}${merged.lost_reason ? `（${merged.lost_reason}）` : ''}` : '';
      await client.query(`INSERT INTO leadgen.activities (track_id, activity_type, content, created_by) VALUES ($1, 'stage', $2, $3)`,
        [trackId, `${STAGE_NAME[track.stage]} → ${STAGE_NAME[next.stage]}${reason}`, user.id]);
    }
    const priceChanged = next.intended_price !== undefined && Number(next.intended_price) !== Number(track.intended_price);
    if (belowFloor && (priceChanged || !track.below_floor_price)) {
      await client.query(`
        INSERT INTO leadgen.notifications (recipient_role, kind, title, body, link, created_by)
        VALUES ('admin', 'below_floor_price', '意向价低于底价', $1, $2, $3)`,
      [`${track.company_name}，意向价 ${Number(merged.intended_price)} 元/㎡·月${property ? `，房源 ${property.building} ${property.unit_no}` : ''}，${user.displayName} 提交`,
        `/company.html?id=${track.company_id}`, user.id]);
    }
    await syncPropertyStatus(client, track.intended_property_id);
    await syncPropertyStatus(client, merged.intended_property_id);
    const { rows: [updated] } = await client.query(`SELECT ${TRACK_COLUMNS} FROM leadgen.company_sector_tracks t ${TRACK_JOINS} WHERE t.id = $1`, [trackId]);
    await client.query('COMMIT');
    return { track: present(updated), price_warning: belowFloor };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function addActivity(pool, { trackId, user, type, content, occurredAt }) {
  if (!MANUAL_ACTIVITY_TYPES.includes(type)) throw fail(400, 'ACTIVITY_TYPE_INVALID', '请选择跟进方式');
  const text = String(content || '').trim();
  if (!text) throw fail(400, 'ACTIVITY_CONTENT_REQUIRED', '请填写跟进内容');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockTrack(client, trackId, user);
    const { rows: [activity] } = await client.query(`
      INSERT INTO leadgen.activities (track_id, activity_type, content, occurred_at, created_by)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5) RETURNING id, occurred_at`,
    [trackId, type, text.slice(0, 2000), occurredAt ? optionalTime(occurredAt, '跟进时间') : null, user.id]);
    await client.query('UPDATE leadgen.company_sector_tracks SET updated_at = now() WHERE id = $1', [trackId]);
    await client.query('COMMIT');
    return activity;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** How far a unit is from what the customer asked for; 0 means it fits. */
export function matchPenalty(need, unit) {
  const reasons = [];
  let penalty = 0;
  const total = unit.list_rent_per_sqm + unit.management_fee_per_sqm;
  const { need_area_min: min, need_area_max: max, need_budget_per_sqm: budget } = need;
  if (min != null || max != null) {
    const low = min ?? 0;
    const high = max ?? Infinity;
    const range = min != null && max != null ? `${min}–${max} ㎡` : min != null ? `${min} ㎡ 以上` : `${max} ㎡ 以内`;
    if (unit.area_sqm >= low && unit.area_sqm <= high) reasons.push(`面积 ${unit.area_sqm} ㎡，在 ${range} 的需求内`);
    else {
      const gap = unit.area_sqm < low ? (low - unit.area_sqm) / low : (unit.area_sqm - high) / high;
      penalty += gap;
      reasons.push(`面积 ${unit.area_sqm} ㎡，比 ${range} 的需求${unit.area_sqm < low ? '小' : '大'}`);
    }
  } else reasons.push(`面积 ${unit.area_sqm} ㎡`);
  if (budget != null) {
    if (total <= budget) reasons.push(`挂牌 ${total} 元/㎡·月（含管理费），在预算内`);
    else {
      penalty += (total - budget) / budget;
      reasons.push(`挂牌 ${total} 元/㎡·月（含管理费），比预算高 ${Math.round((total - budget) * 100) / 100} 元`);
    }
  } else reasons.push(`挂牌 ${total} 元/㎡·月（含管理费）`);
  if (need.need_open_flame) reasons.push('可明火');
  return { penalty, reasons };
}

export async function matchProperties(pool, { trackId, user }) {
  const client = await pool.connect();
  let track;
  try { track = await lockTrackReadOnly(client, trackId, user); } finally { client.release(); }
  if (track.sector_key !== 'office_retail') throw fail(400, 'PROPERTY_SECTOR_MISMATCH', '只有商铺写字楼板块可以匹配房源');
  const need = {
    need_area_min: track.need_area_min == null ? null : Number(track.need_area_min),
    need_area_max: track.need_area_max == null ? null : Number(track.need_area_max),
    need_budget_per_sqm: track.need_budget_per_sqm == null ? null : Number(track.need_budget_per_sqm),
    need_open_flame: track.need_open_flame
  };
  const type = track.need_property_type ?? 'office';
  const { rows } = await pool.query(`
    SELECT id, building, floor, unit_no, property_type, area_sqm::float AS area_sqm, list_rent_per_sqm::float AS list_rent_per_sqm,
           management_fee_per_sqm::float AS management_fee_per_sqm, fit_out, allows_open_flame, status,
           CASE WHEN floor_plan_file IS NOT NULL THEN '/media/' || floor_plan_file END AS floor_plan_url
    FROM leadgen.properties
    WHERE property_type = $1 AND (status = 'available' OR id = $2) AND ($3 = false OR allows_open_flame IS TRUE)`,
  [type, track.intended_property_id, need.need_open_flame]);
  const ranked = rows.map(unit => ({ unit, ...matchPenalty(need, unit) }))
    .sort((a, b) => a.penalty - b.penalty || a.unit.area_sqm - b.unit.area_sqm || a.unit.unit_no.localeCompare(b.unit.unit_no))
    .slice(0, 5);
  return {
    property_type: type,
    items: ranked.map(({ unit, penalty, reasons }) => ({ ...unit, fits: penalty === 0, reasons, selected: unit.id === track.intended_property_id }))
  };
}

async function lockTrackReadOnly(client, trackId, user) {
  requireUuid(trackId, 'TRACK_NOT_FOUND');
  const { rows: [track] } = await client.query('SELECT * FROM leadgen.company_sector_tracks WHERE id = $1', [trackId]);
  if (!track) throw fail(404, 'TRACK_NOT_FOUND', '没有找到这条跟进');
  if (!user.sectors.includes(track.sector_key)) throw fail(403, 'SECTOR_FORBIDDEN', '当前账号不负责这个板块');
  return track;
}

const VISIBLE_NOTIFICATION = `(n.recipient_user_id = $1 OR n.recipient_role = $2)`;

export async function listNotifications(pool, user) {
  const { rows } = await pool.query(`
    SELECT n.id, n.kind, n.title, n.body, n.link, n.created_at, r.read_at IS NOT NULL AS read
    FROM leadgen.notifications n LEFT JOIN leadgen.notification_reads r ON r.notification_id = n.id AND r.user_id = $1
    WHERE ${VISIBLE_NOTIFICATION} ORDER BY n.created_at DESC LIMIT 30`, [user.id, user.role.toLowerCase()]);
  return { unread: rows.filter(row => !row.read).length, items: rows };
}

export async function markNotificationsRead(pool, user) {
  await pool.query(`
    INSERT INTO leadgen.notification_reads (notification_id, user_id)
    SELECT n.id, $1 FROM leadgen.notifications n WHERE ${VISIBLE_NOTIFICATION} ON CONFLICT DO NOTHING`, [user.id, user.role.toLowerCase()]);
}

/** Colleagues who can own a follow-up in the given sector. */
export async function listOwners(pool, sectorKey) {
  const { rows } = await pool.query(`
    SELECT u.id, u.display_name FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key
    WHERE u.is_active AND r.can_write
      AND (r.all_sectors OR EXISTS (SELECT 1 FROM leadgen.user_sectors us WHERE us.user_id = u.id AND us.sector_key = $1))
    ORDER BY u.display_name`, [sectorKey]);
  return rows;
}
