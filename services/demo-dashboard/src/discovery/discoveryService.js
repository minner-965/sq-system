import { AMAP_MAX_PAGES, AMAP_PAGE_SIZE } from './providers/amap.js';
import { RULE_VERSION, scoreCompany } from './scoring.js';
import { runSignalChecks } from './signals.js';

const STALE_RUN_MINUTES = 30;
const OWN_PROJECT_NAME = /恒兆/;

export async function getSettings(pool) {
  const { rows: [row] } = await pool.query(`
    SELECT center_longitude::float AS center_longitude, center_latitude::float AS center_latitude, radius_m,
           category_codes, keywords, exclude_address_keywords, exclude_within_m, max_calls_per_run, signal_checks_per_run,
           daily_run_enabled, updated_at
    FROM leadgen.discovery_settings WHERE id = 1`);
  return row;
}

const cleanList = (value, { max, pattern }) => {
  if (!Array.isArray(value)) throw Object.assign(new Error('设置格式不正确'), { code: 'DISCOVERY_SETTINGS_INVALID', status: 400 });
  const items = [...new Set(value.map(item => String(item).trim()).filter(Boolean))];
  if (items.length > max || items.some(item => item.length > 30 || (pattern && !pattern.test(item)))) {
    throw Object.assign(new Error('设置内容不符合要求'), { code: 'DISCOVERY_SETTINGS_INVALID', status: 400 });
  }
  return items;
};

export async function updateSettings(pool, input, userId) {
  const radius = Number(input.radius_m);
  const maxCalls = Number(input.max_calls_per_run);
  if (!Number.isInteger(radius) || radius < 1000 || radius > 10000 || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) {
    throw Object.assign(new Error('检索半径应在 1–10 公里，每次调用上限应在 1–100 次'), { code: 'DISCOVERY_SETTINGS_INVALID', status: 400 });
  }
  const categoryCodes = cleanList(input.category_codes, { max: 10, pattern: /^\d{6}$/ });
  const keywords = cleanList(input.keywords ?? [], { max: 10 });
  if (!categoryCodes.length && !keywords.length) {
    throw Object.assign(new Error('企业类别和关键词至少填一项'), { code: 'DISCOVERY_SETTINGS_INVALID', status: 400 });
  }
  await pool.query(`
    UPDATE leadgen.discovery_settings SET radius_m = $1, category_codes = $2, keywords = $3,
      exclude_address_keywords = $4, max_calls_per_run = $5, daily_run_enabled = $6, updated_at = now(), updated_by = $7
    WHERE id = 1`,
  [radius, categoryCodes, keywords, cleanList(input.exclude_address_keywords ?? [], { max: 20 }), maxCalls,
    input.daily_run_enabled !== false, userId]);
  return getSettings(pool);
}

/** Records a run as queued; only one run may be queued or running at a time. */
export async function createRun(pool, { trigger, userId = null, provider = 'amap' }) {
  await pool.query(`
    UPDATE leadgen.discovery_runs SET status = 'failed', error_message = '超过 ${STALE_RUN_MINUTES} 分钟没有完成', finished_at = now()
    WHERE status IN ('queued', 'running') AND created_at < now() - make_interval(mins => $1)`, [STALE_RUN_MINUTES]);
  try {
    const { rows: [run] } = await pool.query(
      'INSERT INTO leadgen.discovery_runs (trigger, requested_by, provider) VALUES ($1, $2, $3) RETURNING id', [trigger, userId, provider]);
    return run.id;
  } catch (error) {
    if (error.code === '23505') throw Object.assign(new Error('上一次检索还没有结束'), { code: 'DISCOVERY_ALREADY_RUNNING', status: 409 });
    throw error;
  }
}

/** Existing tenants of the project are never recorded: matched by name, address wording or closeness to the centre. */
export function isInsideProject(company, settings) {
  return OWN_PROJECT_NAME.test(company.name)
    || (company.distanceM != null && company.distanceM <= settings.exclude_within_m)
    || settings.exclude_address_keywords.some(keyword => company.address.includes(keyword));
}

/** Applies the current exclusion rules to companies stored under older, looser rules. */
async function archiveProjectTenants(pool, settings) {
  await pool.query(`
    UPDATE leadgen.companies SET lifecycle_status = 'ARCHIVED', explicit_exclusion_reason = '项目内现有商户', updated_at = now()
    WHERE source = 'amap' AND lifecycle_status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM leadgen.company_sector_tracks t WHERE t.company_id = companies.id)
      AND (company_name ~ '恒兆' OR distance_m <= $1 OR address LIKE ANY (SELECT '%' || k || '%' FROM unnest($2::text[]) k))`,
  [settings.exclude_within_m, settings.exclude_address_keywords]);
  await pool.query(`
    DELETE FROM leadgen.company_sector_candidates k USING leadgen.companies c
    WHERE c.id = k.company_id AND c.lifecycle_status = 'ARCHIVED' AND k.status = 'pending'`);
}

/** Every query's first page before any second page, so a small call budget still covers all categories. */
export function planQueries(settings) {
  const queries = [
    ...settings.category_codes.map(categoryCode => ({ categoryCode })),
    ...settings.keywords.map(keyword => ({ keyword }))
  ];
  return Array.from({ length: AMAP_MAX_PAGES }, (_unused, index) => queries.map(query => ({ ...query, page: index + 1 }))).flat();
}

async function saveCompany(client, company) {
  const { rows: [row] } = await client.query(`
    INSERT INTO leadgen.companies
      (company_name, city, address, longitude, latitude, industry, company_type, phone, distance_m,
       source, source_ref, data_origin, last_collected_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'map_poi', now())
    ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
      company_name = EXCLUDED.company_name, city = EXCLUDED.city, address = EXCLUDED.address,
      longitude = EXCLUDED.longitude, latitude = EXCLUDED.latitude, industry = EXCLUDED.industry,
      company_type = EXCLUDED.company_type, phone = EXCLUDED.phone, distance_m = EXCLUDED.distance_m,
      last_collected_at = now(), updated_at = now()
    RETURNING id, (xmax = 0) AS inserted`,
  [company.name, company.city, company.address, company.longitude, company.latitude, company.industry,
    company.categoryCode, company.phone, company.distanceM, company.source, company.sourceRef]);
  await rescoreCompany(client, row.id);
  return row.inserted;
}

/** Recomputes a stored company's candidates from its current facts and signals. */
export async function rescoreCompany(client, companyId) {
  const { rows: [stored] } = await client.query(`
    SELECT company_name, company_type, distance_m, phone, source_ref, signals_checked_at FROM leadgen.companies WHERE id = $1`, [companyId]);
  const { rows: signals } = await client.query(`
    SELECT signal_type AS type, evidence, source_title AS "sourceTitle", source_url AS "sourceUrl"
    FROM leadgen.company_signals WHERE company_id = $1 ORDER BY signal_type`, [companyId]);
  const company = {
    name: stored.company_name, categoryCode: stored.company_type, distanceM: stored.distance_m, phone: stored.phone,
    sourceUrl: `https://www.amap.com/place/${stored.source_ref}`
  };
  for (const result of scoreCompany(company, { signals, signalsChecked: stored.signals_checked_at != null })) {
    // 复核结论（status）不因重新评分而改变。
    await client.query(`
      INSERT INTO leadgen.company_sector_candidates (company_id, sector_key, score, score_items, notices, rule_version)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (company_id, sector_key) DO UPDATE SET
        score = EXCLUDED.score, score_items = EXCLUDED.score_items, notices = EXCLUDED.notices,
        rule_version = EXCLUDED.rule_version, scored_at = now()`,
    [companyId, result.sectorKey, result.score, JSON.stringify(result.items), result.notices, RULE_VERSION]);
  }
}

/**
 * Searches around the project, stores companies without duplicates and scores them per sector.
 * Every provider call is written to api_usage_events.
 */
export async function runDiscovery(pool, { runId, provider, search = null, llm = null, log = () => {} }) {
  const settings = await getSettings(pool);
  const totals = { api_calls: 0, results_seen: 0, companies_new: 0, companies_updated: 0, companies_excluded: 0, signals_checked: 0, signals_found: 0 };
  await pool.query(`UPDATE leadgen.discovery_runs SET status = 'running', started_at = now() WHERE id = $1`, [runId]);
  const finish = (status, errorMessage = null) => pool.query(`
    UPDATE leadgen.discovery_runs SET status = $2, error_message = $3, finished_at = now(), api_calls = $4,
      results_seen = $5, companies_new = $6, companies_updated = $7, companies_excluded = $8,
      signals_checked = $9, signals_found = $10 WHERE id = $1`,
  [runId, status, errorMessage, totals.api_calls, totals.results_seen, totals.companies_new, totals.companies_updated,
    totals.companies_excluded, totals.signals_checked, totals.signals_found]);
  const excluded = company => isInsideProject(company, settings);
  const exhausted = new Set();
  const seen = new Set();

  try {
    for (const query of planQueries(settings)) {
      if (totals.api_calls >= settings.max_calls_per_run) break;
      const queryKey = query.categoryCode ?? `kw:${query.keyword}`;
      if (exhausted.has(queryKey)) continue;
      const summary = `${query.categoryCode ? `类别 ${query.categoryCode}` : `关键词 ${query.keyword}`}，${settings.radius_m} 米，第 ${query.page} 页`;
      const started = Date.now();
      let result;
      totals.api_calls += 1;
      try {
        result = await provider.search({
          longitude: settings.center_longitude, latitude: settings.center_latitude, radiusM: settings.radius_m, ...query
        });
      } catch (error) {
        await pool.query(`
          INSERT INTO leadgen.api_usage_events (provider, endpoint, discovery_run_id, request_summary, status, error_code, duration_ms)
          VALUES ($1, 'place/around', $2, $3, 'error', $4, $5)`, [provider.name, runId, summary, error.code || error.name, Date.now() - started]);
        throw error;
      }
      await pool.query(`
        INSERT INTO leadgen.api_usage_events (provider, endpoint, discovery_run_id, request_summary, status, result_count, duration_ms)
        VALUES ($1, 'place/around', $2, $3, 'ok', $4, $5)`, [provider.name, runId, summary, result.companies.length, Date.now() - started]);
      if (result.companies.length < AMAP_PAGE_SIZE) exhausted.add(queryKey);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const company of result.companies) {
          if (seen.has(company.sourceRef)) continue;
          seen.add(company.sourceRef);
          totals.results_seen += 1;
          if (excluded(company)) { totals.companies_excluded += 1; continue; }
          if (await saveCompany(client, company)) totals.companies_new += 1; else totals.companies_updated += 1;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      log(`${summary}：${result.companies.length} 条`);
    }
    await archiveProjectTenants(pool, settings);
    if (search && llm) {
      const signals = await runSignalChecks(pool, { search, llm, limit: settings.signal_checks_per_run, runId, rescore: rescoreCompany, log });
      totals.signals_checked = signals.checked;
      totals.signals_found = signals.found;
    }
    await finish('completed');
  } catch (error) {
    await finish('failed', String(error.message).slice(0, 300));
    throw error;
  }
  return totals;
}

const CANDIDATE_STATUSES = new Set(['pending', 'approved', 'rejected']);

export async function listCandidates(pool, { sectors, status = 'pending', search, limit = 50, offset = 0 }) {
  if (!CANDIDATE_STATUSES.has(status)) throw Object.assign(new Error('状态不正确'), { code: 'CANDIDATE_STATUS_INVALID', status: 400 });
  const params = [sectors, status, search ? `%${search}%` : null];
  const where = `c.lifecycle_status = 'ACTIVE' AND k.sector_key = ANY($1) AND k.status = $2 AND ($3::text IS NULL OR c.company_name ILIKE $3 OR c.address ILIKE $3)`;
  const [{ rows }, { rows: [count] }, { rows: tabs }] = await Promise.all([
    pool.query(`
      SELECT k.id, k.sector_key, s.name AS sector_name, k.score, k.score_items, k.notices, k.status, k.reviewed_at,
             k.reject_reason, c.id AS company_id, c.company_name, c.address, c.industry, c.phone, c.distance_m,
             c.source, c.source_ref, c.created_at AS discovered_at
      FROM leadgen.company_sector_candidates k
      JOIN leadgen.companies c ON c.id = k.company_id
      JOIN leadgen.sectors s ON s.key = k.sector_key
      WHERE ${where}
      ORDER BY k.score DESC, c.distance_m, c.company_name, k.sector_key
      LIMIT $4 OFFSET $5`, [...params, Math.min(Math.max(Number(limit) || 50, 1), 100), Math.max(Number(offset) || 0, 0)]),
    pool.query(`SELECT count(*)::int AS total FROM leadgen.company_sector_candidates k JOIN leadgen.companies c ON c.id = k.company_id WHERE ${where}`, params),
    pool.query(`
      SELECT k.status, count(*)::int AS n FROM leadgen.company_sector_candidates k JOIN leadgen.companies c ON c.id = k.company_id
      WHERE c.lifecycle_status = 'ACTIVE' AND k.sector_key = ANY($1) GROUP BY k.status`, [sectors])
  ]);
  return {
    total: count.total,
    counts: Object.fromEntries(['pending', 'approved', 'rejected'].map(key => [key, tabs.find(row => row.status === key)?.n ?? 0])),
    items: rows.map(row => ({ ...row, source_url: row.source === 'amap' ? `https://www.amap.com/place/${row.source_ref}` : null }))
  };
}

/** Approving puts the company into that sector's follow-up as a new lead. */
export async function reviewCandidate(pool, { candidateId, decision, reason, user }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(candidateId))) throw Object.assign(new Error('没有找到这条候选'), { code: 'CANDIDATE_NOT_FOUND', status: 404 });
  if (!['approve', 'reject'].includes(decision)) throw Object.assign(new Error('请选择通过或不合适'), { code: 'REVIEW_DECISION_INVALID', status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [candidate] } = await client.query(
      'SELECT id, company_id, sector_key, status FROM leadgen.company_sector_candidates WHERE id = $1 FOR UPDATE', [candidateId]);
    if (!candidate) throw Object.assign(new Error('没有找到这条候选'), { code: 'CANDIDATE_NOT_FOUND', status: 404 });
    if (!user.sectors.includes(candidate.sector_key)) throw Object.assign(new Error('当前账号不负责这个板块'), { code: 'SECTOR_FORBIDDEN', status: 403 });
    if (candidate.status !== 'pending') throw Object.assign(new Error('这条候选已经复核过'), { code: 'CANDIDATE_ALREADY_REVIEWED', status: 409 });
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await client.query(`
      UPDATE leadgen.company_sector_candidates SET status = $2, reviewed_by = $3, reviewed_at = now(), reject_reason = $4 WHERE id = $1`,
    [candidateId, status, user.id, decision === 'reject' ? String(reason || '').trim().slice(0, 200) || null : null]);
    if (decision === 'approve') {
      await client.query(`
        INSERT INTO leadgen.company_sector_tracks (company_id, sector_key, stage, owner_user_id)
        VALUES ($1, $2, 'new', $3) ON CONFLICT (company_id, sector_key) DO NOTHING`, [candidate.company_id, candidate.sector_key, user.id]);
    }
    // 企业档案的复核状态：有任一板块通过即为通过；全部板块都不合适才算不合适。
    await client.query(`
      UPDATE leadgen.companies c SET qualification_status = CASE
          WHEN EXISTS (SELECT 1 FROM leadgen.company_sector_candidates k WHERE k.company_id = c.id AND k.status = 'approved') THEN 'qualified'
          WHEN EXISTS (SELECT 1 FROM leadgen.company_sector_candidates k WHERE k.company_id = c.id AND k.status = 'pending') THEN 'pending'
          ELSE 'rejected' END, updated_at = now()
      WHERE c.id = $1`, [candidate.company_id]);
    await client.query('COMMIT');
    return { id: candidateId, status };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recentRuns(pool, limit = 5) {
  const { rows } = await pool.query(`
    SELECT r.id, r.trigger, r.status, r.provider, r.api_calls, r.results_seen, r.companies_new, r.companies_updated,
           r.companies_excluded, r.signals_checked, r.signals_found, r.error_message, r.created_at, r.finished_at, u.display_name AS requested_by_name
    FROM leadgen.discovery_runs r LEFT JOIN leadgen.users u ON u.id = r.requested_by
    ORDER BY r.created_at DESC LIMIT $1`, [limit]);
  return rows;
}

export async function usageSummary(pool) {
  const { rows } = await pool.query(`
    SELECT provider,
           count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS calls_today,
           count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS calls_this_month,
           count(*) FILTER (WHERE status = 'error' AND created_at >= date_trunc('month', now()))::int AS errors_this_month,
           COALESCE(sum(cost_cny) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float AS cost_this_month
    FROM leadgen.api_usage_events GROUP BY provider ORDER BY provider`);
  return rows;
}
