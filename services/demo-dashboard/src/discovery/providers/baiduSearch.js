// 百度搜索（千帆平台 Web 服务接口）。官方接口，直接用 HTTPS 调用。
// 用来查企业近期的公开网页：招聘、新设、迁址、扩张等信息。
const ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
// 接口对查询词的上限是 72 个字符，一个汉字算 2 个。
const MAX_QUERY_UNITS = 72;

export function clipQuery(query) {
  let units = 0;
  let clipped = '';
  for (const char of String(query).trim()) {
    units += char.charCodeAt(0) > 0x7f ? 2 : 1;
    if (units > MAX_QUERY_UNITS) break;
    clipped += char;
  }
  return clipped;
}

export function createBaiduSearchProvider({ key, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  return {
    name: 'baidu_search',
    configured: Boolean(key),
    /**
     * @param {{ query: string, recency?: 'week'|'month'|'semiyear'|'year', limit?: number }} options
     * @returns {Promise<{ title: string, url: string, snippet: string, date: string|null, site: string|null }[]>}
     */
    async searchWeb({ query, recency = 'year', limit = 8 }) {
      if (!key) throw Object.assign(new Error('没有配置百度搜索 Key'), { code: 'BAIDU_SEARCH_KEY_MISSING' });
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: clipQuery(query) }],
          search_source: 'baidu_search_v2',
          edition: 'standard',
          resource_type_filter: [{ type: 'web', top_k: Math.min(Math.max(limit, 1), 20) }],
          search_recency_filter: recency
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.code) {
        throw Object.assign(new Error(`百度搜索接口：${body.message || response.status}`), { code: `BAIDU_${body.code || response.status}` });
      }
      return (body.references || []).filter(item => item.url && item.title).map(item => ({
        title: String(item.title).trim(),
        url: item.url,
        snippet: String(item.snippet || item.content || '').trim().slice(0, 500),
        date: item.date || null,
        site: item.website || item.web_anchor || null
      }));
    }
  };
}
