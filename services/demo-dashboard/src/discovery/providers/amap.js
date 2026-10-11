// 高德地图周边搜索（Web 服务接口 v3）。官方接口，直接用 HTTPS 调用。
const BASE_URL = 'https://restapi.amap.com';
export const AMAP_PAGE_SIZE = 25;
// 一个查询条件最多能翻到约 200 条，再往后返回空页。
export const AMAP_MAX_PAGES = 8;

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** 高德返回的一条地点 → 统一的企业结构。 */
export function normalizePoi(poi) {
  const [longitude, latitude] = String(poi.location || '').split(',').map(Number);
  const categories = String(poi.type || '').split(';').filter(Boolean);
  return {
    source: 'amap',
    sourceRef: poi.id,
    sourceUrl: `https://www.amap.com/place/${poi.id}`,
    name: text(poi.name),
    address: [text(poi.adname), text(poi.address)].filter(Boolean).join(''),
    district: text(poi.adname),
    city: text(poi.cityname),
    longitude: Number.isFinite(longitude) ? longitude : null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    distanceM: /^\d+$/.test(String(poi.distance)) ? Number(poi.distance) : null,
    phone: text(poi.tel)?.split(';')[0] ?? null,
    categoryCode: text(poi.typecode),
    // “公司企业;公司;公司” → “公司”
    industry: categories.at(-1) ?? null
  };
}

export function createAmapProvider({ key, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  return {
    name: 'amap',
    configured: Boolean(key),
    /**
     * @param {{ longitude: number, latitude: number, radiusM: number, categoryCode?: string, keyword?: string, page: number }} query
     * @returns {Promise<{ companies: object[], total: number }>}
     */
    async search({ longitude, latitude, radiusM, categoryCode, keyword, page }) {
      if (!key) throw Object.assign(new Error('没有配置高德 Key'), { code: 'AMAP_KEY_MISSING' });
      const url = new URL('/v3/place/around', BASE_URL);
      const params = { key, location: `${longitude},${latitude}`, radius: radiusM, offset: AMAP_PAGE_SIZE, page, sortrule: 'distance', extensions: 'base' };
      if (categoryCode) params.types = categoryCode;
      if (keyword) params.keywords = keyword;
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw Object.assign(new Error(`高德接口返回 ${response.status}`), { code: `HTTP_${response.status}` });
      const body = await response.json();
      if (body.status !== '1') throw Object.assign(new Error(`高德接口：${body.info}`), { code: `AMAP_${body.infocode}` });
      return {
        total: Number(body.count) || 0,
        companies: (body.pois || []).map(normalizePoi).filter(company => company.name && company.sourceRef)
      };
    }
  };
}
