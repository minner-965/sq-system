// 黄埔区工程建设的中标结果：谁刚中标了本区的工程。施工单位要进场设项目部，需要住宿、用餐、临时办公。
// 数据由发布程序从广东省公共资源交易平台的公开公告里读来，存在 tender_awards；这里负责列出来、转入跟进、标为不合适。

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_NAME = { construction: '施工', supervision: '监理', other: '其他' };
// 中标单位进场以后会用到的两个板块。
const FOLLOW_SECTORS = ['hotel_apartment', 'dining'];

export async function listTenders(pool, { status = 'open', kind = 'construction', limit = 50 }) {
  if (!['open', 'followed', 'dismissed'].includes(status)) throw fail(400, 'TENDER_STATUS_INVALID', '状态不正确');
  if (!['construction', 'all'].includes(kind)) throw fail(400, 'TENDER_KIND_INVALID', '类型不正确');
  const where = { open: 'a.company_id IS NULL AND NOT a.dismissed', followed: 'a.company_id IS NOT NULL', dismissed: 'a.dismissed' }[status];
  const [{ rows }, { rows: [counts] }, { rows: [beat] }] = await Promise.all([
    pool.query(`
      SELECT a.id, a.title, a.section_name, a.project_type, a.owner_name, a.winner_name, a.amount::float AS amount, a.work_kind,
             a.published_at, a.source_url, a.company_id
      FROM leadgen.tender_awards a
      WHERE ${where} AND ($1 = 'all' OR a.work_kind = 'construction') AND a.winner_name IS NOT NULL
      ORDER BY a.published_at DESC NULLS LAST LIMIT $2`, [kind, Math.min(Math.max(Number(limit) || 50, 1), 100)]),
    pool.query(`
      SELECT count(*) FILTER (WHERE company_id IS NULL AND NOT dismissed AND work_kind = 'construction' AND winner_name IS NOT NULL)::int AS open_construction,
             count(*) FILTER (WHERE company_id IS NULL AND NOT dismissed AND winner_name IS NOT NULL)::int AS open_all,
             count(*) FILTER (WHERE company_id IS NOT NULL)::int AS followed
      FROM leadgen.tender_awards`),
    pool.query('SELECT tenders_checked_at, tenders_note FROM leadgen.publisher_heartbeat WHERE id = 1')
  ]);
  return {
    counts, checked_at: beat?.tenders_checked_at ?? null, note: beat?.tenders_note ?? null,
    items: rows.map(row => ({ ...row, work_kind_name: KIND_NAME[row.work_kind], project: row.section_name || row.title.split('中标信息')[0] }))
  };
}

/**
 * Puts the winning contractor into follow-up for hotel/apartment and dining (the sectors the user looks after),
 * with the award as evidence. One company record per contractor; a second award adds evidence to the same record.
 */
export async function followTender(pool, { tenderId, user }) {
  if (!UUID.test(String(tenderId))) throw fail(404, 'TENDER_NOT_FOUND', '没有找到这条中标结果');
  const sectors = FOLLOW_SECTORS.filter(key => user.sectors.includes(key));
  if (!sectors.length) throw fail(403, 'SECTOR_FORBIDDEN', '这类线索由负责酒店公寓或餐饮的同事跟进');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [award] } = await client.query('SELECT * FROM leadgen.tender_awards WHERE id = $1 FOR UPDATE', [tenderId]);
    if (!award) throw fail(404, 'TENDER_NOT_FOUND', '没有找到这条中标结果');
    if (award.company_id) throw fail(409, 'TENDER_ALREADY_FOLLOWED', '这条已经转入跟进了');
    if (!award.winner_name) throw fail(409, 'TENDER_NO_WINNER', '公告里没有写中标单位');
    const { rows: [existing] } = await client.query(`SELECT id FROM leadgen.companies WHERE source = 'tender' AND source_ref = $1`, [award.winner_name]);
    const companyId = existing?.id ?? (await client.query(`
      INSERT INTO leadgen.companies (company_name, source, source_ref, data_origin, qualification_status, company_description, signals_checked_at)
      VALUES ($1, 'tender', $1, 'tender_award', 'qualified', '在黄埔区中标了工程的单位，来自公共资源交易平台的公开公告', now()) RETURNING id`, [award.winner_name])).rows[0].id;
    const project = award.section_name || award.title.split('中标信息')[0];
    const day = award.published_at ? new Date(award.published_at).toISOString().slice(0, 10) : null;
    const money = award.amount ? `，中标金额 ${(Number(award.amount) / 10000).toFixed(0)} 万元` : '';
    await client.query(`
      INSERT INTO leadgen.company_signals (company_id, signal_type, evidence, source_title, source_url, source_date, origin)
      VALUES ($1, 'project_site', $2, '广东省公共资源交易平台 中标结果', $3, $4, 'tender') ON CONFLICT DO NOTHING`,
    [companyId, `中标“${project.slice(0, 50)}”${money}`.slice(0, 160), award.source_url, day]);
    for (const sector of sectors) {
      const { rows: [track] } = await client.query(`
        INSERT INTO leadgen.company_sector_tracks (company_id, sector_key, stage, owner_user_id)
        VALUES ($1, $2, 'new', $3) ON CONFLICT (company_id, sector_key) DO UPDATE SET updated_at = now() RETURNING id`, [companyId, sector, user.id]);
      await client.query(`INSERT INTO leadgen.activities (track_id, activity_type, content, created_by) VALUES ($1, 'note', $2, $3)`,
        [track.id, [`来源：黄埔区工程中标结果`, `工程：${project}`, `中标单位：${award.winner_name}${money}`, award.owner_name ? `业主：${award.owner_name}` : null,
          day ? `公告日期：${day}` : null, `出处：${award.source_url}`].filter(Boolean).join('\n'), user.id]);
    }
    await client.query('UPDATE leadgen.tender_awards SET company_id = $2, handled_by = $3, handled_at = now() WHERE id = $1', [tenderId, companyId, user.id]);
    await client.query('COMMIT');
    return { company_id: companyId, sectors };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function dismissTender(pool, { tenderId, user }) {
  if (!UUID.test(String(tenderId))) throw fail(404, 'TENDER_NOT_FOUND', '没有找到这条中标结果');
  const { rowCount } = await pool.query(
    'UPDATE leadgen.tender_awards SET dismissed = true, handled_by = $2, handled_at = now() WHERE id = $1 AND company_id IS NULL AND NOT dismissed', [tenderId, user.id]);
  if (!rowCount) throw fail(409, 'TENDER_ALREADY_HANDLED', '这条已经处理过了');
  return { dismissed: true };
}
