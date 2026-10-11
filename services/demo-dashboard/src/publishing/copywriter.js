// 文案生成：一份素材按平台各写一版。规格和风格见 docs/hz/自动发帖/功能需求.md 5.2。
// 任何文案里都不能出现底价；生成后和人工修改后都要过 findForbidden 这一关。

import { readFileSync } from 'node:fs';

// 每个平台一份风格文件（styles/<平台>.md），写文案和选话题都按它来。改风格只改那份文件。
const STYLE_GUIDES = Object.fromEntries(['douyin', 'channels', 'xiaohongshu', 'moments']
  .map(platform => [platform, readFileSync(new URL(`./styles/${platform}.md`, import.meta.url), 'utf8').trim()]));
export const styleGuide = platform => STYLE_GUIDES[platform];

export const PLATFORMS = Object.freeze({
  douyin: { label: '抖音', titleMax: 30, bodyMin: 0, bodyMax: 200, topics: [3, 5], style: '标题不超过 30 字，正文两三句话，简短有力' },
  channels: { label: '视频号', titleMax: 30, bodyMin: 0, bodyMax: 200, topics: [3, 5], style: '标题不超过 30 字，正文两三句话，简短有力' },
  xiaohongshu: { label: '小红书', titleMax: 20, bodyMin: 300, bodyMax: 800, topics: [3, 8], style: '标题不超过 20 字，正文 300–800 字，分段，像真人分享的笔记' },
  moments: { label: '朋友圈', titleMax: 0, bodyMin: 0, bodyMax: 100, topics: [0, 0], style: '不要标题，不带话题，100 字以内，像业务员自己发的朋友圈' }
});

export const CONTENT_TYPES = Object.freeze({
  property: { label: '房源', tone: '商务招商口吻：讲清位置、面积、配置、适合什么企业，不夸张，不用感叹号堆砌' },
  event: { label: '活动与品牌', tone: '生活化的种草口吻：讲现场有什么、什么时候、怎么来' },
  hotel: { label: '酒店', tone: '生活化的种草口吻：讲住得怎么样、离哪里近、适合谁' },
  dining: { label: '餐饮', tone: '生活化的种草口吻：讲菜、环境、适合什么场合' }
});

const CHINESE_NUMBER = { 30: '三十', 35: '三十五', 40: '四十' };

/**
 * Wording a post may not contain: the word for the floor price, and the floor
 * figure itself written as a price.
 * @returns {string|null} what was found
 */
export function findForbidden(text, floorPrices = []) {
  const content = String(text || '');
  if (/底价|最低价|最低可接受/.test(content)) return '“底价”一类的说法';
  for (const price of floorPrices.filter(value => value != null)) {
    const number = Number(price);
    const figure = new RegExp(`(^|[^\\d.])${String(number).replace('.', '\\.')}\\s*(元|块|/㎡|/平|每平)`);
    if (figure.test(content) || (CHINESE_NUMBER[number] && content.includes(`${CHINESE_NUMBER[number]}元`))) return `底价数字（${number} 元）`;
  }
  return null;
}

/** Cleans a model draft to the platform's limits; returns problems instead of silently accepting a bad draft. */
export function normalizeDraft(platform, raw, floorPrices = []) {
  const spec = PLATFORMS[platform];
  const title = spec.titleMax ? String(raw?.title || '').trim() : '';
  const body = String(raw?.body || '').trim();
  const topics = spec.topics[1]
    ? [...new Set((Array.isArray(raw?.topics) ? raw.topics : []).map(topic => String(topic).replace(/^#+|#+$/g, '').trim()).filter(Boolean))].slice(0, spec.topics[1])
    : [];
  const problems = [];
  if (!body) problems.push('没有正文');
  if (spec.titleMax && !title) problems.push('没有标题');
  if (title.length > spec.titleMax) problems.push(`标题 ${title.length} 字，超过 ${spec.titleMax} 字`);
  if (body.length > spec.bodyMax) problems.push(`正文 ${body.length} 字，超过 ${spec.bodyMax} 字`);
  if (body && body.length < spec.bodyMin) problems.push(`正文 ${body.length} 字，不到 ${spec.bodyMin} 字`);
  if (topics.length < spec.topics[0]) problems.push(`话题 ${topics.length} 个，不到 ${spec.topics[0]} 个`);
  const forbidden = findForbidden(`${title}\n${body}\n${topics.join(' ')}`, floorPrices);
  if (forbidden) problems.push(`出现了${forbidden}`);
  return { title: title || null, body, topics, problems };
}

function facts(material, property, project) {
  const lines = [`主题：${material.topic}`, `内容类型：${CONTENT_TYPES[material.content_type].label}`];
  if (material.note) lines.push(`补充说明：${material.note}`);
  if (property) {
    lines.push(`关联房源：${property.building} ${property.floor} 层 ${property.unit_no}，${property.property_type === 'office' ? '写字楼' : '商铺'}，${Number(property.area_sqm)} ㎡`);
    lines.push(`公开报价：租金 ${Number(property.list_rent_per_sqm)} 元/㎡·月，管理费 ${Number(property.management_fee_per_sqm)} 元/㎡·月`);
    if (property.fit_out) lines.push(`配置：${property.fit_out}`);
    if (property.delivery_standard) lines.push(`交付：${property.delivery_standard}`);
    if (property.allows_open_flame) lines.push('可明火');
  }
  if (project?.address) lines.push(`项目：恒兆广场，${project.address}`);
  if (project?.transport_notes?.length) lines.push(`交通：${project.transport_notes.join('；')}`);
  lines.push(`素材：图片 ${material.image_count} 张${material.video_count ? `，视频 ${material.video_count} 个` : ''}`);
  return lines.join('\n');
}

export function buildPrompt({ platform, material, property, project }) {
  const spec = PLATFORMS[platform];
  const system = `你是广州黄埔区恒兆广场的运营人员，要为${spec.label}写一条内容。
这条内容的类型是“${CONTENT_TYPES[material.content_type].label}”，口吻：${CONTENT_TYPES[material.content_type].tone}。
格式上限：${spec.style}。${spec.topics[1] ? `话题 ${spec.topics[0]}–${spec.topics[1]} 个，不带 # 号。` : ''}
正文连标点一共不能超过 ${spec.bodyMax} 字，写的时候按 ${Math.floor(spec.bodyMax * 0.85)} 字以内来控制；宁可少写一个卖点，也不要超字数。

下面是${spec.label}的风格文件，标题、正文结构和话题怎么选都按它来（只看和本条内容类型对应的部分）：
<风格文件>
${STYLE_GUIDES[platform]}
</风格文件>

硬性要求（优先于风格文件）：
1. 只用下面给出的事实，不编造面积、价格、配套、优惠、活动时间、电话。事实里没有的不写：没提停车、吃饭、周边配套就不要写它们“方便”“齐全”；交通照资料原文的说法，资料没写“地铁”的线路不要加“地铁”二字。风格文件里某一段没有对应资料时，整段省略。
2. 租金只能写“欢迎咨询”或上面给出的公开报价，不写任何优惠价、最低价、底价。
3. 像人写的：不用“赋能”“打造”“一站式”“尽享”这类套话，不用排比口号，不写“小编”“家人们”。
4. 结尾引导留言或私信咨询，不留电话和微信号。
只输出 JSON：{"title":"...","body":"...","topics":["..."]}${spec.titleMax ? '' : '，title 留空字符串'}。`;
  return [{ role: 'system', content: system }, { role: 'user', content: facts(material, property, project) }];
}

// 模型爱用、但资料里通常没有依据的评价。资料原文里出现过的不算。
const UNSUPPORTED_PRAISE = ['拎包入驻', '配套齐全', '配套完善', '都方便', '都很方便', '非常方便', '十分方便', '性价比', '黄金地段', '核心地段',
  '稀缺', '首选', '不二之选', '最好', '最优', '第一', '顶级', '高端', '豪华', '火爆', '抢手', '升值', '投资回报', '人气旺', '客流量大'];

/** Evaluative phrases in a draft that the supplied facts never state. */
export function unsupportedPraise(text, factsText) {
  return UNSUPPORTED_PRAISE.filter(phrase => text.includes(phrase) && !factsText.includes(phrase));
}

/** Figures in a draft that appear nowhere in the supplied facts: the commonest kind of invented detail. */
export function unsupportedNumbers(text, factsText) {
  const known = new Set(factsText.match(/\d+(?:\.\d+)?/g) || []);
  return [...new Set((text.match(/\d+(?:\.\d+)?/g) || []).filter(number => !known.has(number)))];
}

/** Everything a model-written draft is checked for beyond the platform limits. */
function factProblems(draft, factsText) {
  const text = `${draft.title ?? ''}\n${draft.body}`;
  const problems = [];
  const praise = unsupportedPraise(text, factsText);
  if (praise.length) problems.push(`用了资料里没有依据的评价：${praise.join('、')}，请删掉，只陈述事实`);
  const numbers = unsupportedNumbers(text, factsText);
  if (numbers.length) problems.push(`出现了资料里没有的数字：${numbers.join('、')}，请删掉或改成资料里的数字`);
  return problems;
}

const REVIEW_PROMPT = `你是校对。下面有一份“资料”和一条根据它写的“文案”。
逐句检查文案：凡是资料里没有依据的说法都要找出来，包括——
- 资料没给的数字、距离、时间、价格、优惠；
- 资料没提的配套和评价（如“停车方便”“吃饭方便”“配套齐全”“采光好”，除非资料里写了）；
- 把资料里的说法改了性质的（如资料只写“1号线水西站”，文案写成“地铁1号线”）。
常识性的连接语、称呼、引导留言私信的话不算。
然后给出改好的文案：只删掉或改回没有依据的部分，其余尽量不动，保持原来的格式和长度要求。
只输出 JSON：{"unsupported":["文案里没有依据的原句或短语"],"title":"...","body":"...","topics":["..."]}。没有问题时 unsupported 为空数组，title、body、topics 原样返回。`;

/**
 * Writes one draft. The model gets one more try, with the problems spelled out,
 * if its first draft breaks the platform limits or mentions the floor price.
 * A second, cold read then strips any claim the supplied facts do not support.
 */
export async function writeDraft({ llm, platform, material, property, project, floorPrices }) {
  const messages = buildPrompt({ platform, material, property, project });
  const usage = { inputTokens: 0, outputTokens: 0 };
  const count = reply => { usage.inputTokens += reply.usage.inputTokens; usage.outputTokens += reply.usage.outputTokens; };
  let draft;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await llm.chatJson({ messages, maxTokens: 1500, temperature: 0.7 });
    count(reply);
    draft = normalizeDraft(platform, reply.data, floorPrices);
    draft.problems.push(...factProblems(draft, messages[1].content));
    if (!draft.problems.length) break;
    // 资料太少、写不够字数时，不让模型为了凑字去编；把稿子原样交给人，由人补充资料后再生成。
    if (draft.problems.every(problem => /不到 \d+ 字$/.test(problem))) { draft.thinFacts = true; break; }
    messages.push({ role: 'assistant', content: JSON.stringify(reply.data) }, { role: 'user', content: `这一版有问题：${draft.problems.join('；')}。请改好后重新输出 JSON。` });
  }
  let removed = [];
  if (draft.body) {
    const review = await llm.chatJson({
      messages: [
        { role: 'system', content: REVIEW_PROMPT },
        { role: 'user', content: `资料：\n${messages[1].content}\n\n文案：\n${JSON.stringify({ title: draft.title ?? '', body: draft.body, topics: draft.topics })}` }
      ],
      maxTokens: 1500, temperature: 0
    });
    count(review);
    const unsupported = Array.isArray(review.data?.unsupported) ? review.data.unsupported.map(item => String(item).trim()).filter(Boolean) : [];
    if (unsupported.length) {
      const corrected = normalizeDraft(platform, review.data, floorPrices);
      corrected.problems.push(...factProblems(corrected, messages[1].content));
      // 校对稿只有在不比原稿多出问题时才采用，免得删过头变成不合格的稿子。
      if (corrected.body && corrected.problems.length <= draft.problems.length) { draft = corrected; removed = unsupported; }
    }
  }
  if (draft.thinFacts || (draft.problems.length && draft.problems.every(problem => /不到 \d+ 字$/.test(problem)))) {
    draft.problems = draft.problems.map(problem => `${problem}：给的资料不够写这么长，请在“补充说明”里多写些内容后重新生成，或直接手写补充`);
  }
  return { ...draft, removed, usage };
}
