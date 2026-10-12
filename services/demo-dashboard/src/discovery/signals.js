// 需求信号：用公开网页搜索查企业近一年的招聘、扩张、迁址、新设信息，由大模型判断是否确实在说这家企业。
// 每条信号必须对应一条搜索结果，出处用搜索结果里的链接，不用大模型写的链接。

export const SIGNAL_TYPES = Object.freeze({
  seeking_space: { label: '在找场地', points: 25, strength: 'strong' },
  relocation: { label: '迁址', points: 20, strength: 'strong' },
  new_setup: { label: '新设', points: 15, strength: 'medium' },
  expansion: { label: '扩张', points: 15, strength: 'medium' },
  project_site: { label: '本地项目进场', points: 15, strength: 'medium' },
  hiring: { label: '招聘', points: 10, strength: 'weak' }
});
// 依据的强弱。强：对方自己在找地方或要搬；中：规模在变大，可能需要地方；弱：只是在招人。
export const STRENGTH = Object.freeze({
  strong: { label: '强', rank: 3, meaning: '对方在找场地或要搬迁' },
  medium: { label: '中', rank: 2, meaning: '规模在扩大或有项目进场，可能需要场地、住宿或用餐' },
  weak: { label: '弱', rank: 1, meaning: '只看到在招人，不能说明要场地' }
});
// 一次招这么多岗位以上，算规模在扩大。
export const BULK_HIRING = 10;

/** How strongly one piece of evidence suggests a need for space. Bulk hiring counts as growth, a couple of openings does not. */
export function strengthOf(signal) {
  if (signal.type === 'hiring') return Number(signal.openings) >= BULK_HIRING ? 'medium' : 'weak';
  return SIGNAL_TYPES[signal.type]?.strength ?? 'weak';
}

/** The company's overall level: its strongest evidence; "none" once checked with nothing found; "unchecked" before that. */
export function demandLevel(signals, checked) {
  if (!signals.length) return checked ? 'none' : 'unchecked';
  return signals.map(strengthOf).sort((x, y) => STRENGTH[y].rank - STRENGTH[x].rank)[0];
}

const RECHECK_DAYS = 30;
// 单独点“查一下”时，一天内查过的不再重复查。
export const MANUAL_RECHECK_HOURS = 24;
// 估算费用用的单价（元 / 百万 token）。以服务商账单为准，可在 .env 里改。
const priceIn = env => Number(env.LLM_PRICE_INPUT_PER_M || 2);
const priceOut = env => Number(env.LLM_PRICE_OUTPUT_PER_M || 8);

const SYSTEM_PROMPT = `你在帮广州黄埔区的一个商业地产项目（写字楼、商铺、酒店公寓、餐饮）判断：周边某家企业近期有没有需要场地、住宿或用餐的迹象。
给你一家企业的名称、地址，和若干条网页搜索结果（带编号）。
只在搜索结果明确是在说这家企业（名称一致，不是同名的其他地方的企业、不是它的客户或供应商）时，才提取依据。
依据类型只有六种，按说服力从高到低：
- seeking_space：这家企业在找办公或经营场地、在选址、在求租、在看场地
- relocation：计划搬迁、已搬迁、租约到期要换地方
- new_setup：近一年内新成立，或在本地新设分公司、办事处、门店
- expansion：扩产、扩建、新增产线、新开分支、融资后扩大规模
- project_site：中标或进驻了广州黄埔一带的工程、项目，需要在本地驻场
- hiring：这家企业正在或近期在招聘
要的是“现在或接下来需要地方”的迹象，不是历史：
- relocation 只算还没搬、正在找、租约快到期、已公布要搬的；已经搬完、新地址已经定下来的不算（那说明它不需要地方了）。
- new_setup 的成立或设立时间必须在今天往前 12 个月以内。
- expansion、project_site 说的事必须是今天往前 12 个月以内开始的，或者还在进行。
每条依据在 event_month 里填这件事发生的年月（如 2026-03）；从结果里看不出时间就不填，new_setup 看不出时间就不要提取。
每种类型最多一条，取最有说服力的那条结果。拿不准就不要提取；宁可少，不要把别的企业或泛泛的行业新闻算进来。
hiring 类型如果结果里写明了在招多少个岗位或多少人，在 openings 里填这个数字，没写明就不填。
只输出 JSON：{"signals":[{"type":"hiring","result":1,"evidence":"不超过40字，说明依据","openings":18,"event_month":"2026-09"}]}。没有依据时输出 {"signals":[]}。`;

/** Keeps only signals that point at a real search result and a known type, one per type. */
export function validateSignals(raw, results, now = new Date()) {
  // 事情发生在一年多以前的不算（给一个月的余量）。
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)).toISOString().slice(0, 7);
  const seen = new Set();
  const signals = [];
  for (const item of Array.isArray(raw?.signals) ? raw.signals : []) {
    const result = results[Number(item?.result) - 1];
    const evidence = String(item?.evidence || '').trim();
    if (!SIGNAL_TYPES[item?.type] || !result || !evidence || seen.has(item.type)) continue;
    const month = /^\d{4}-\d{2}$/.test(String(item.event_month || '')) ? item.event_month : null;
    if (month && month < oldest) continue;
    // 新设必须说得出时间，否则无法确认是近一年的事。
    if (item.type === 'new_setup' && !month) continue;
    seen.add(item.type);
    const openings = item.type === 'hiring' && Number.isInteger(item.openings) && item.openings > 0 && item.openings < 100000 ? item.openings : null;
    signals.push({
      type: item.type, evidence: evidence.slice(0, 80), openings, sourceTitle: result.title, sourceUrl: result.url,
      sourceDate: /^\d{4}-\d{2}-\d{2}/.test(result.date || '') ? result.date.slice(0, 10) : null
    });
  }
  return signals;
}

// 名称本身就说明是在本地驻场的工程项目部：不用搜，地图上的名称就是依据。
const PROJECT_SITE_NAME = /项目部|项目群|项目经理部|指挥部|工程处/;

/** Evidence that needs no search: what the map listing itself says. */
export function nameSignals(company) {
  if (!PROJECT_SITE_NAME.test(company.name) || !company.sourceRef) return [];
  return [{
    type: 'project_site', evidence: '名称显示是在本地驻场的工程项目部', openings: null, sourceTitle: '高德地图上的名称',
    sourceUrl: `https://www.amap.com/place/${company.sourceRef}`, sourceDate: null
  }];
}

export async function findSignals({ company, search, llm }) {
  const results = await search.searchWeb({ query: `${company.name} 选址 搬迁 扩产 中标 招聘`, recency: 'year', limit: 8 });
  if (!results.length) return { signals: nameSignals(company), results: 0, usage: null };
  const listing = results.map((item, index) => `${index + 1}. ${item.title}｜${item.site || ''}｜${item.date || '无日期'}\n${item.snippet}`).join('\n\n');
  const { data, usage } = await llm.chatJson({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `今天：${new Date().toISOString().slice(0, 10)}\n企业：${company.name}\n地址：${company.address || '未知'}\n\n搜索结果：\n${listing}` }
    ],
    maxTokens: 400, temperature: 0
  });
  const found = validateSignals(data, results);
  // 网页上没有查到“本地项目进场”时，用名称上的依据补上。
  return { signals: [...found, ...nameSignals(company).filter(extra => !found.some(signal => signal.type === extra.type))], results: results.length, usage };
}

/** Replaces a company's stored evidence with what was just found and rescores it. */
async function storeSignals(pool, companyId, signals, rescore) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 政府公示来的依据不是这次搜索得到的，留着。
    await client.query(`DELETE FROM leadgen.company_signals WHERE company_id = $1 AND origin <> 'permit'`, [companyId]);
    for (const signal of signals) {
      await client.query(`
        INSERT INTO leadgen.company_signals (company_id, signal_type, evidence, source_title, source_url, source_date, openings, origin)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [companyId, signal.type, signal.evidence, signal.sourceTitle, signal.sourceUrl, signal.sourceDate, signal.openings ?? null,
        signal.sourceTitle === '高德地图上的名称' ? 'name' : 'web']);
    }
    await client.query('UPDATE leadgen.companies SET signals_checked_at = now() WHERE id = $1', [companyId]);
    await rescore(client, companyId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Looks one company up right now, for someone about to call it. Not repeated within a day. */
export async function checkCompanySignals(pool, { companyId, search, llm, rescore, env = process.env }) {
  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
  if (!/^[0-9a-f-]{36}$/i.test(String(companyId))) throw fail(404, 'COMPANY_NOT_FOUND', '没有找到这家企业');
  if (!search.configured || !llm.configured) throw fail(409, 'SIGNAL_CHECK_UNAVAILABLE', '还没有配置搜索或大模型，暂时查不了');
  const { rows: [company] } = await pool.query(`
    SELECT id, company_name AS name, address, CASE WHEN source = 'amap' THEN source_ref END AS "sourceRef", signals_checked_at > now() - make_interval(hours => $2) AS recent
    FROM leadgen.companies WHERE id = $1 AND lifecycle_status = 'ACTIVE'`, [companyId, MANUAL_RECHECK_HOURS]);
  if (!company) throw fail(404, 'COMPANY_NOT_FOUND', '没有找到这家企业');
  if (company.recent) throw fail(409, 'SIGNAL_CHECKED_RECENTLY', '这家企业今天已经查过了');
  const started = Date.now();
  let outcome;
  try {
    outcome = await findSignals({ company, search, llm });
  } catch (error) {
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, error_code, duration_ms) VALUES ($1, 'web_search', $2, 'error', $3, $4)`,
      [String(error.code).startsWith('LLM') ? llm.provider : search.name, company.name, error.code || error.name, Date.now() - started]);
    throw fail(502, 'SIGNAL_CHECK_FAILED', `这次没查成：${error.message}`);
  }
  await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, result_count, cost_cny, duration_ms) VALUES ($1, 'web_search', $2, 'ok', $3, 0, $4)`,
    [search.name, company.name, outcome.results, Date.now() - started]);
  if (outcome.usage) {
    const cost = (outcome.usage.inputTokens * priceIn(env) + outcome.usage.outputTokens * priceOut(env)) / 1_000_000;
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, result_count, cost_cny, duration_ms) VALUES ($1, 'chat/completions', $2, 'ok', $3, $4, $5)`,
      [llm.provider, company.name, outcome.signals.length, cost, Date.now() - started]);
  }
  await storeSignals(pool, company.id, outcome.signals, rescore);
  return { found: outcome.signals.length, level: demandLevel(outcome.signals, true) };
}

/**
 * Checks the highest-scoring companies that have not been looked up recently.
 * Stops at the first search or model failure so a spent quota is not hammered.
 */
export async function runSignalChecks(pool, { search, llm, limit, runId = null, rescore, env = process.env, log = () => {} }) {
  if (!search.configured || !llm.configured || limit <= 0) return { checked: 0, found: 0 };
  const { rows: companies } = await pool.query(`
    SELECT c.id, c.company_name AS name, c.address, CASE WHEN c.source = 'amap' THEN c.source_ref END AS "sourceRef"
    FROM leadgen.companies c
    JOIN leadgen.company_sector_candidates k ON k.company_id = c.id
    WHERE c.lifecycle_status = 'ACTIVE'
      AND (c.signals_checked_at IS NULL OR c.signals_checked_at < now() - make_interval(days => $2))
    GROUP BY c.id ORDER BY (c.signals_checked_at IS NOT NULL), max(k.score) DESC, c.distance_m LIMIT $1`, [limit, RECHECK_DAYS]);
  const usage = (provider, endpoint, summary, status, count, cost, startedAt, errorCode = null) => pool.query(`
    INSERT INTO leadgen.api_usage_events (provider, endpoint, discovery_run_id, request_summary, status, result_count, cost_cny, duration_ms, error_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [provider, endpoint, runId, summary, status, count, cost, Date.now() - startedAt, errorCode]);

  let checked = 0;
  let found = 0;
  for (const company of companies) {
    const started = Date.now();
    let outcome;
    try {
      outcome = await findSignals({ company, search, llm });
    } catch (error) {
      const provider = String(error.code).startsWith('LLM') ? llm.provider : search.name;
      await usage(provider, provider === search.name ? 'web_search' : 'chat/completions', company.name, 'error', null, 0, started, error.code || error.name);
      log(`需求信号查询中止：${error.message}`);
      break;
    }
    await usage(search.name, 'web_search', company.name, 'ok', outcome.results, 0, started);
    if (outcome.usage) {
      const cost = (outcome.usage.inputTokens * priceIn(env) + outcome.usage.outputTokens * priceOut(env)) / 1_000_000;
      await usage(llm.provider, 'chat/completions', `${company.name}（输入 ${outcome.usage.inputTokens}，输出 ${outcome.usage.outputTokens} token）`, 'ok', outcome.signals.length, cost, started);
    }
    await storeSignals(pool, company.id, outcome.signals, rescore);
    checked += 1;
    found += outcome.signals.length;
    log(`${company.name}：${outcome.signals.length ? outcome.signals.map(signal => SIGNAL_TYPES[signal.type].label).join('、') : '没有信号'}`);
  }
  return { checked, found };
}
