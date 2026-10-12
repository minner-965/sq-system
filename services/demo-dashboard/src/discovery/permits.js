// 政府公示的行政许可 → 企业发现里的依据。
// 发布程序把“信用广州”上黄埔区新公示的许可存进 permit_notices；这里把其中新办的那些在地图上找到位置，
// 落在检索范围内的就收进企业发现，并记一条“新设”依据，出处是公示页。

const CATEGORY_NAME = { food: '食品经营许可', device: '医疗器械经营许可', drug: '药品经营许可', other: '行政许可' };

/** “广州市黄埔区星记餐饮店(个体工商户)” → “星记餐饮店”：去掉括号说明和前面的行政区，留下地图上会用的名字。 */
export function searchName(holderName) {
  return String(holderName || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^广州市?/, '').replace(/^(黄埔区?|广州开发区)/, '')
    .replace(/^[\u4e00-\u9fa5]{2,4}街道?(?=.{3,})/, '')
    .trim();
}

/** The distinctive part of a name, used as the map search keyword: “广东乐佳乐餐饮服务有限公司” → “乐佳乐”. */
export function coreName(holderName) {
  const core = searchName(holderName)
    .replace(/^广东省?/, '')
    .replace(/(股份)?(有限责任公司|有限公司)(.{0,8}(分公司|分店|店))?$/, '')
    .replace(/(餐饮|食品|饮食|商贸|贸易|科技|医药|药业|实业|发展|投资|文化|传媒)?(服务|管理|连锁|经营)?$/, '')
    .trim();
  return core.length >= 2 ? core : searchName(holderName);
}

/** Whether a map listing is the business named on the permit: one name contains the other once district words are stripped. */
export function sameBusiness(holderName, poiName) {
  // 两边都只留字号：去掉行政区、括号说明、公司后缀、“店/档/馆”和行业词。
  const brand = value => coreName(String(value || '').replace(/(分公司|分店|店|部|档|馆)(?=$|[（(])/g, ''))
    .replace(/(分公司|分店|店|部|档|馆)$/g, '').replace(/(餐饮|食品|饮食|美食|小吃|饮品|奶茶|超市|便利|药房|大药房)$/g, '').replace(/\s+/g, '');
  const a = brand(holderName);
  const b = brand(poiName);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b) return true;
  // 不完全一样时：短的那个至少 3 个字，长的以它开头，并且不是只差一个字（“乐佳乐”和“乐佳”多半是两家）。
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short) && long.length - short.length !== 1;
}

/**
 * Places newly licensed businesses on the map and records the licence as evidence. A notice is looked at once.
 * @returns {Promise<{ checked: number, matched: number }>}
 */
export async function attachPermitSignals(pool, { provider, settings, saveCompany, rescore, isExcluded, limit = 15, runId = null, log = () => {} }) {
  if (!provider.configured || limit <= 0) return { checked: 0, matched: 0 };
  const { rows: notices } = await pool.query(`
    SELECT id, holder_name, category, decided_on, source_url FROM leadgen.permit_notices
    WHERE kind = 'new' AND match_checked_at IS NULL AND decided_on > now() - interval '60 days'
    ORDER BY decided_on DESC NULLS LAST, created_at LIMIT $1`, [limit]);
  let matched = 0;
  for (const notice of notices) {
    const keyword = coreName(notice.holder_name);
    const started = Date.now();
    let note = '地图上没有找到';
    let companyId = null;
    try {
      const result = keyword.length >= 2
        ? await provider.search({ longitude: settings.center_longitude, latitude: settings.center_latitude, radiusM: settings.radius_m, keyword, page: 1 })
        : { companies: [] };
      await pool.query(`
        INSERT INTO leadgen.api_usage_events (provider, endpoint, discovery_run_id, request_summary, status, result_count, duration_ms)
        VALUES ($1, 'place/around', $2, $3, 'ok', $4, $5)`, [provider.name, runId, `许可公示定位：${keyword}`, result.companies.length, Date.now() - started]);
      const hit = result.companies.find(company => sameBusiness(notice.holder_name, company.name));
      if (hit && isExcluded(hit)) note = '在项目内，不收';
      else if (hit) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await saveCompany(client, hit);
          ({ rows: [{ id: companyId }] } = await client.query(`SELECT id FROM leadgen.companies WHERE source = 'amap' AND source_ref = $1`, [hit.sourceRef]));
          const day = notice.decided_on ? new Date(notice.decided_on).toISOString().slice(0, 10) : null;
          await client.query(`
            INSERT INTO leadgen.company_signals (company_id, signal_type, evidence, source_title, source_url, source_date, origin)
            VALUES ($1, 'new_setup', $2, '信用广州 行政许可公示', $3, $4, 'permit') ON CONFLICT DO NOTHING`,
          [companyId, `${day ? `${day} ` : ''}新办${CATEGORY_NAME[notice.category]}，在本区新开门店或新开展经营`, notice.source_url, day]);
          await rescore(client, companyId);
          await client.query('COMMIT');
          matched += 1;
          note = `对上了：${hit.name}`;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    } catch (error) {
      log(`许可公示定位中止：${error.message}`);
      break;
    }
    await pool.query('UPDATE leadgen.permit_notices SET match_checked_at = now(), company_id = $2, match_note = $3 WHERE id = $1', [notice.id, companyId, note]);
    log(`${notice.holder_name}：${note}`);
  }
  return { checked: notices.length, matched };
}
