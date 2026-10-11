// 候选企业评分。规则说明见 docs/hz/评分规则.md，两处要一起改。
// 满分 100：距离 40、企业类型 20、可联系 10、需求信号 30。

import { SIGNAL_TYPES } from './signals.js';

export const RULE_VERSION = 'hz-2026.10-2';
const SIGNAL_MAX = 30;

/** 需求信号：招聘 10、扩张 15、新设 15、迁址 20，合计封顶 30。出处是搜到的网页。 */
function signalItem(signals, checked) {
  if (!signals.length) {
    return { item: '需求信号', points: 0, max: SIGNAL_MAX, reason: checked ? '近一年没有查到招聘、扩张、迁址、新设方面的公开信息' : '还没有查过', source: null };
  }
  const strongest = [...signals].sort((a, b) => SIGNAL_TYPES[b.type].points - SIGNAL_TYPES[a.type].points)[0];
  return {
    item: '需求信号',
    points: Math.min(SIGNAL_MAX, signals.reduce((sum, signal) => sum + SIGNAL_TYPES[signal.type].points, 0)),
    max: SIGNAL_MAX,
    reason: signals.map(signal => `${SIGNAL_TYPES[signal.type].label}：${signal.evidence}`).join('；'),
    source: { label: strongest.sourceTitle?.slice(0, 20) || '网页', url: strongest.sourceUrl },
    sources: signals.map(signal => ({ label: SIGNAL_TYPES[signal.type].label, url: signal.sourceUrl }))
  };
}

// 每个板块的距离分档 [不超过多少米, 得分]，以及超出最后一档就不作为该板块的候选。
const DISTANCE_BANDS = {
  office_retail: [[1000, 40], [3000, 32], [5000, 24], [10000, 12]],
  hotel_apartment: [[3000, 40], [5000, 32], [10000, 24]],
  dining: [[500, 40], [1000, 32], [2000, 24], [3000, 12]]
};
const SMALL_BUSINESS = /(商行|经营部|工作室|个体|小卖部|档口|店)$/;
const LARGER_COMPANY = /集团|股份|科技|生物|医药|制造|电子|新能源|汽车|研究院/;
const SPECIAL_TRADE = /化工|危化|危险品|燃气|烟花|爆竹|加油/;

const km = metres => (metres >= 1000 ? `${(metres / 1000).toFixed(1)} 公里` : `${metres} 米`);

function companyType(company) {
  if (company.categoryCode?.startsWith('1701')) return { key: 'notable', label: '知名企业' };
  if (company.categoryCode?.startsWith('1703')) return { key: 'factory', label: '工厂' };
  if (SMALL_BUSINESS.test(company.name)) return { key: 'small', label: '个体或小微商户' };
  return { key: 'company', label: '公司' };
}

const TYPE_POINTS = {
  office_retail: { notable: 20, company: 14, factory: 10, small: 6 },
  hotel_apartment: { notable: 20, factory: 16, company: 10, small: 0 },
  dining: { notable: 20, factory: 20, company: 14, small: 4 }
};

/**
 * @param {{ name: string, categoryCode?: string, distanceM: number|null, phone?: string|null, sourceUrl: string }} company
 * @param {{ signals?: {type: string, evidence: string, sourceTitle?: string, sourceUrl: string}[], signalsChecked?: boolean }} [found]
 * @returns {{ sectorKey: string, score: number, items: object[], notices: string[] }[]} one entry per sector the company qualifies for
 */
export function scoreCompany(company, { signals = [], signalsChecked = false } = {}) {
  if (company.distanceM == null) return [];
  const source = { label: '高德地图', url: company.sourceUrl };
  const type = companyType(company);
  const notices = SPECIAL_TRADE.test(company.name) ? ['特殊业态，入驻前需确认消防和环评要求'] : [];

  return Object.entries(DISTANCE_BANDS).flatMap(([sectorKey, bands]) => {
    const band = bands.find(([limit]) => company.distanceM <= limit);
    if (!band) return [];
    // 差旅协议只看有一定规模的企业。
    if (sectorKey === 'hotel_apartment' && !(type.key === 'notable' || type.key === 'factory' || LARGER_COMPANY.test(company.name))) return [];
    const items = [
      { item: '距离', points: band[1], max: 40, reason: `距恒兆广场 ${km(company.distanceM)}`, source },
      { item: '企业类型', points: TYPE_POINTS[sectorKey][type.key], max: 20, reason: type.label, source },
      { item: '可联系', points: company.phone ? 10 : 0, max: 10, reason: company.phone ? '地图上登记了联系电话' : '地图上没有登记电话', source },
      signalItem(signals, signalsChecked)
    ];
    return [{ sectorKey, score: items.reduce((sum, item) => sum + item.points, 0), items, notices }];
  });
}
