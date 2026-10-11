// 文案生成：一份素材按平台各写一版。规格和风格见 docs/hz/自动发帖/功能需求.md 5.2。
// 任何文案里都不能出现底价；生成后和人工修改后都要过 findForbidden 这一关。

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
  if (body.length < spec.bodyMin) problems.push(`正文 ${body.length} 字，不到 ${spec.bodyMin} 字`);
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
风格：${CONTENT_TYPES[material.content_type].tone}。
格式：${spec.style}。${spec.topics[1] ? `话题 ${spec.topics[0]}–${spec.topics[1]} 个，不带 # 号。` : ''}
硬性要求：
1. 只用下面给出的事实，不编造面积、价格、配套、优惠、活动时间、电话。事实里没有的不写。
2. 租金只能写“欢迎咨询”或上面给出的公开报价，不写任何优惠价、最低价、底价。
3. 像人写的：不用“赋能”“打造”“一站式”“尽享”这类套话，不用排比口号，不写“小编”“家人们”。
4. 结尾引导留言或私信咨询，不留电话和微信号。
只输出 JSON：{"title":"...","body":"...","topics":["..."]}${spec.titleMax ? '' : '，title 留空字符串'}。`;
  return [{ role: 'system', content: system }, { role: 'user', content: facts(material, property, project) }];
}

/**
 * Writes one draft. The model gets one more try, with the problems spelled out,
 * if its first draft breaks the platform limits or mentions the floor price.
 */
export async function writeDraft({ llm, platform, material, property, project, floorPrices }) {
  const messages = buildPrompt({ platform, material, property, project });
  const usage = { inputTokens: 0, outputTokens: 0 };
  let draft;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await llm.chatJson({ messages, maxTokens: 1500, temperature: 0.7 });
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    draft = normalizeDraft(platform, reply.data, floorPrices);
    if (!draft.problems.length) break;
    messages.push({ role: 'assistant', content: JSON.stringify(reply.data) }, { role: 'user', content: `这一版有问题：${draft.problems.join('；')}。请改好后重新输出 JSON。` });
  }
  return { ...draft, usage };
}
