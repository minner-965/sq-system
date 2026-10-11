import { createAmapProvider } from './amap.js';
import { createBaiduSearchProvider } from './baiduSearch.js';

// 已接入：高德（周边企业）、百度搜索（需求信号）。其余按计划预留，拿到 Key 后再实现。
export const PLANNED_PROVIDERS = Object.freeze([
  { name: 'bocha', label: '博查网页搜索', purpose: '网页搜索备用' },
  { name: 'company_registry', label: '工商数据', purpose: '新设、迁址、规模' }
]);

export function createProviders(env = process.env) {
  return {
    amap: createAmapProvider({ key: env.AMAP_KEY }),
    baiduSearch: createBaiduSearchProvider({ key: env.BAIDU_SEARCH_KEY })
  };
}
