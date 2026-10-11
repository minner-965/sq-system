// 需求信号：用公开网页搜索查企业近一年的招聘、扩张、迁址、新设信息，由大模型判断是否确实在说这家企业。
// 每条信号必须对应一条搜索结果，出处用搜索结果里的链接，不用大模型写的链接。

export const SIGNAL_TYPES = Object.freeze({
  hiring: { label: '招聘', points: 10 },
  expansion: { label: '扩张', points: 15 },
  new_setup: { label: '新设', points: 15 },
  relocation: { label: '迁址', points: 20 }
});
const RECHECK_DAYS = 30;
// 估算费用用的单价（元 / 百万 token）。以服务商账单为准，可在 .env 里改。
const priceIn = env => Number(env.LLM_PRICE_INPUT_PER_M || 2);
const priceOut = env => Number(env.LLM_PRICE_OUTPUT_PER_M || 8);

const SYSTEM_PROMPT = `你在帮一家商业地产项目判断周边企业近期有没有用房需求的迹象。
给你一家企业的名称、地址，和若干条网页搜索结果（带编号）。
只在搜索结果明确是在说这家企业（名称一致，不是同名的其他地方的企业、不是它的客户或供应商）时，才提取信号。
信号类型只有四种：
- hiring：这家企业正在或近期在招聘
- expansion：扩产、扩建、新增产线、新开分支、融资后扩大规模
- relocation：计划搬迁、已搬迁、在找新的办公或经营场地
- new_setup：近一年内新成立
每种类型最多一条，取最有说服力的那条结果。拿不准就不要提取。
只输出 JSON：{"signals":[{"type":"hiring","result":1,"evidence":"不超过40字，说明依据"}]}。没有信号时输出 {"signals":[]}。`;

/** Keeps only signals that point at a real search result and a known type, one per type. */
export function validateSignals(raw, results) {
  const seen = new Set();
  const signals = [];
  for (const item of Array.isArray(raw?.signals) ? raw.signals : []) {
    const result = results[Number(item?.result) - 1];
    const evidence = String(item?.evidence || '').trim();
    if (!SIGNAL_TYPES[item?.type] || !result || !evidence || seen.has(item.type)) continue;
    seen.add(item.type);
    signals.push({
      type: item.type, evidence: evidence.slice(0, 80), sourceTitle: result.title, sourceUrl: result.url,
      sourceDate: /^\d{4}-\d{2}-\d{2}/.test(result.date || '') ? result.date.slice(0, 10) : null
    });
  }
  return signals;
}

export async function findSignals({ company, search, llm }) {
  const results = await search.searchWeb({ query: `${company.name} 招聘 扩产 搬迁 新成立`, recency: 'year', limit: 8 });
  if (!results.length) return { signals: [], results: 0, usage: null };
  const listing = results.map((item, index) => `${index + 1}. ${item.title}｜${item.site || ''}｜${item.date || '无日期'}\n${item.snippet}`).join('\n\n');
  const { data, usage } = await llm.chatJson({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `企业：${company.name}\n地址：${company.address || '未知'}\n\n搜索结果：\n${listing}` }
    ],
    maxTokens: 400, temperature: 0
  });
  return { signals: validateSignals(data, results), results: results.length, usage };
}

/**
 * Checks the highest-scoring companies that have not been looked up recently.
 * Stops at the first search or model failure so a spent quota is not hammered.
 */
export async function runSignalChecks(pool, { search, llm, limit, runId = null, rescore, env = process.env, log = () => {} }) {
  if (!search.configured || !llm.configured || limit <= 0) return { checked: 0, found: 0 };
  const { rows: companies } = await pool.query(`
    SELECT c.id, c.company_name AS name, c.address
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM leadgen.company_signals WHERE company_id = $1', [company.id]);
      for (const signal of outcome.signals) {
        await client.query(`
          INSERT INTO leadgen.company_signals (company_id, signal_type, evidence, source_title, source_url, source_date)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [company.id, signal.type, signal.evidence, signal.sourceTitle, signal.sourceUrl, signal.sourceDate]);
      }
      await client.query('UPDATE leadgen.companies SET signals_checked_at = now() WHERE id = $1', [company.id]);
      await rescore(client, company.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    checked += 1;
    found += outcome.signals.length;
    log(`${company.name}：${outcome.signals.length ? outcome.signals.map(signal => SIGNAL_TYPES[signal.type].label).join('、') : '没有信号'}`);
  }
  return { checked, found };
}
