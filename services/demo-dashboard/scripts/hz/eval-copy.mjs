// 文案自测：四种内容类型 × 四个平台各写一条，自动检查字数和话题数、有没有底价、
// 有没有资料里没有的数字和评价。不通过的列出来，改风格文件或提示词后重跑，直到全部通过。
// 用法（在 services/demo-dashboard 下）：npm run eval:copy
import { createLlmClient } from '../../src/llm/llmClient.js';
import { PLATFORMS, buildPrompt, findForbidden, unsupportedNumbers, unsupportedPraise, writeDraft } from '../../src/publishing/copywriter.js';

const project = { address: '广州市黄埔区长岭街福业一街恒兆广场', transport_notes: ['地铁21号线长平站1公里', '330A/345恒兆广场总站', '3分钟到萝岗敏捷广场、6分钟到萝岗万达广场'] };
const CASES = [
  { name: '写字楼房源', floors: [35],
    material: { topic: '1 栋 13 层 193 平精装写字楼招租', content_type: 'property', note: '南向采光，适合 15 人左右的团队', image_count: 6, video_count: 0 },
    property: { building: '1栋', floor: 13, unit_no: '1307', property_type: 'office', area_sqm: '193', list_rent_per_sqm: '30', management_fee_per_sqm: '10', fit_out: '精装修3隔＋15卡', delivery_standard: '铺地毯、顶喷黑、玻璃隔断、空调，可配家具' } },
  { name: '商铺房源（挂牌租金恰好是 35）', floors: [],
    material: { topic: '3 栋首层 868 平商铺招租', content_type: 'property', note: '可分割，适合做展厅、图文', image_count: 4, video_count: 0 },
    property: { building: '3栋', floor: 1, unit_no: '101', property_type: 'retail', area_sqm: '868', list_rent_per_sqm: '35', management_fee_per_sqm: '10', delivery_standard: '毛坯交付' } },
  { name: '活动', floors: [35],
    material: { topic: '恒兆广场周末市集', content_type: 'event', note: '10 月 18 日、19 日下午 3 点到晚上 9 点，B 栋首层广场，有手作、咖啡和亲子游戏摊位', image_count: 5, video_count: 1 }, property: null },
  { name: '酒店', floors: [35],
    material: { topic: '宜尚酒店：看演唱会住这里', content_type: 'hotel', note: '距宝能广州国际体育演艺中心约 4.3 公里，车程约 10 分钟；114 间客房；中西自助早餐，三楼恒温泳池，免费停车', image_count: 9, video_count: 0 }, property: null },
  { name: '餐饮', floors: [35],
    material: { topic: '恒兆鱼仔店：企业午市团餐', content_type: 'dining', note: '传统地道潮汕菜，在 B 栋，接受企业团餐和包间预订', image_count: 7, video_count: 0 }, property: null }
];

const llm = createLlmClient();
if (!llm.configured) { console.error('.env 里没有大模型的 Key，测不了'); process.exit(1); }

const failures = [];
let drafts = 0;
for (const item of CASES) {
  for (const platform of Object.keys(PLATFORMS)) {
    const factsText = buildPrompt({ platform, material: item.material, property: item.property, project })[1].content;
    const draft = await writeDraft({ llm, platform, material: item.material, property: item.property, project, floorPrices: item.floors });
    drafts += 1;
    const text = `${draft.title ?? ''}\n${draft.body}\n${draft.topics.join(' ')}`;
    const problems = [...draft.problems];
    const forbidden = findForbidden(text, item.floors);
    if (forbidden) problems.push(`出现了${forbidden}`);
    const numbers = unsupportedNumbers(`${draft.title ?? ''}\n${draft.body}`, factsText);
    if (numbers.length) problems.push(`资料里没有的数字：${numbers.join('、')}`);
    const praise = unsupportedPraise(text, factsText);
    if (praise.length) problems.push(`没有依据的评价：${praise.join('、')}`);
    if (/电话|微信号|\d{7,}/.test(draft.body) && !/电话|微信/.test(factsText) && /1[3-9]\d{9}|\d{3,4}-\d{7,8}/.test(draft.body)) problems.push('出现了电话号码');
    const line = `${item.name} / ${PLATFORMS[platform].label}`;
    // 资料太少写不满字数：系统如实提示“资料不够”，没有凑字编造，这是对的结果。
    if (problems.length && problems.every(problem => /资料不够写这么长/.test(problem))) { console.log(`资料不足（如实提示，未凑字）  ${line}（${draft.body.length} 字）`); continue; }
    if (problems.length) failures.push(`${line}：${[...new Set(problems)].join('；')}\n    ${draft.title ?? ''}｜${draft.body.replace(/\n+/g, ' ').slice(0, 160)}`);
    else console.log(`通过  ${line}（${draft.body.length} 字，话题 ${draft.topics.length} 个${draft.removed.length ? `，校对去掉 ${draft.removed.length} 处` : ''}）`);
  }
}
console.log(`\n共 ${drafts} 条，不通过 ${failures.length} 条。`);
for (const failure of failures) console.log(`不通过  ${failure}`);
process.exit(failures.length ? 1 : 0);
