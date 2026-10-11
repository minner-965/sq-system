import { createAmapProvider } from './amap.js';

// 统一接口：search(query) → { companies[], total }。只有高德已接入；其余按计划预留，拿到 Key 后再实现。
export const PLANNED_PROVIDERS = Object.freeze([
  { name: 'baidu_search', label: '百度搜索', purpose: '企业官网、新闻、招聘信号' },
  { name: 'bocha', label: '博查网页搜索', purpose: '同上，备用' },
  { name: 'company_registry', label: '工商数据', purpose: '新设、迁址、规模' },
  { name: 'llm', label: '大模型', purpose: '从网页摘要提取需求信号、写推荐理由' }
]);

export function createProviders(env = process.env) {
  return { amap: createAmapProvider({ key: env.AMAP_KEY }) };
}
