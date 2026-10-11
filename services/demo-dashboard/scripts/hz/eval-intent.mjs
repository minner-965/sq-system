// 意图分类自测：用一组贴近真实的评论和私信跑一遍分类，列出判错的和被关键词初筛漏掉的。
// 发现漏判就补关键词（数据库里的 inbox_settings.intent_keywords），直到这组全部通过。
// 用法（在 services/demo-dashboard 下）：npm run eval:intent
import { createHostPool } from '../../src/db/pool.js';
import { createLlmClient } from '../../src/llm/llmClient.js';
import { INTENTS, classifyMessage, matchedKeywords } from '../../src/inbox/inboxService.js';

// [类型, 应该判成什么, 原话]。c = 评论，d = 私信。
const CASES = [
  ['c', 'inquiry', '这个多少钱一个月'], ['c', 'inquiry', '193平的还有吗'], ['c', 'inquiry', '租金怎么算，含物业吗'],
  ['c', 'inquiry', '有没有小一点的，五六十平'], ['c', 'inquiry', '一楼的铺面还在招吗'], ['c', 'inquiry', '能做餐饮吗，要明火'],
  ['c', 'inquiry', '求个报价'], ['c', 'inquiry', '押几付几啊'], ['c', 'inquiry', '可以注册公司不'], ['c', 'inquiry', '停车位够不够，月卡啥价'],
  ['c', 'inquiry', '我们十来个人，想搬过来，大概要多大面积'], ['c', 'inquiry', '最短签多久'], ['c', 'inquiry', '带家具不'],
  ['c', 'inquiry', '具体在哪条路上'], ['c', 'inquiry', '离地铁远不远，怎么过去'], ['c', 'inquiry', '发我一份资料'],
  ['c', 'viewing', '周六可以过去看看吗，想找个 80 平左右的办公室'], ['c', 'viewing', '明天下午方便带看不'], ['c', 'viewing', '想实地瞧瞧，找谁'],
  ['c', 'viewing', '这周能约个时间上门吗'], ['c', 'viewing', '我在附近，现在能过来不'],
  ['c', 'cooperation', '我们是做奶茶连锁的，想进驻你们商场'], ['c', 'cooperation', '有招商经理的联系方式吗，谈品牌入驻'],
  ['c', 'cooperation', '做保洁外包的，能对接一下物业吗'], ['c', 'cooperation', '中介可以带客吗，佣金多少'],
  ['c', 'booking', '下周演唱会那两天还有房吗'], ['c', 'booking', '大床房周末什么价'], ['c', 'booking', '公司年会想订个包间，三桌'],
  ['c', 'booking', '二十个人团建吃饭，能安排吗'], ['c', 'booking', '会议室怎么收费，能坐一百人不'], ['c', 'booking', '想给员工长住，有月租吗'],
  ['c', 'chat', '拍得不错'], ['c', 'chat', '环境看着挺好'], ['c', 'chat', '以前在这上过班，怀念'], ['c', 'chat', '@小李 你看这个'],
  ['c', 'chat', '黄埔发展真快'], ['c', 'chat', '哈哈哈哈'], ['c', 'chat', '楼下那家潮汕菜好吃'],
  ['c', 'spam', '加V看主页，低价代运营涨粉'], ['c', 'spam', '兼职日结，私我'],
  ['d', 'inquiry', '你好，请问 13 层那套还在吗，想了解一下价格'], ['d', 'viewing', '在吗，想约明天上午去现场'],
  ['d', 'booking', '你好，我们公司下周三要开会，想订 10 间房住两晚，有协议价吗'], ['d', 'cooperation', '您好，我们做办公家具的，想谈下合作'],
  ['d', 'chat', '你好'], ['d', 'spam', '专业代发短视频，包上热门，加微信详聊']
];

const pool = createHostPool();
const llm = createLlmClient();
if (!llm.configured) { console.error('.env 里没有大模型的 Key，测不了'); process.exit(1); }
const { rows: [settings] } = await pool.query('SELECT intent_keywords FROM leadgen.inbox_settings WHERE id = 1');
await pool.end();

const wrong = [];
const filtered = [];
for (const [kind, expected, content] of CASES) {
  const message = { platform: 'douyin', kind: kind === 'c' ? 'comment' : 'direct_message', post_title: '恒兆广场 1 栋 13 层 193 平精装写字楼招租', content };
  const result = await classifyMessage({ message, keywords: settings.intent_keywords, llm });
  const expectLead = INTENTS[expected].lead;
  const gotLead = INTENTS[result.intent].lead;
  // 提醒不提醒最要紧：有意向的漏掉、没意向的乱提醒，都算错。意向内部分错类（如询价判成看房）单独列出。
  if (expectLead && result.source === 'keyword' && !gotLead) filtered.push(content);
  else if (expectLead !== gotLead) wrong.push(`${content} → 判成“${INTENTS[result.intent].label}”，应为“${INTENTS[expected].label}”（${result.reason}）`);
  else if (result.intent !== expected && expectLead) wrong.push(`（分类偏差，不影响提醒）${content} → “${INTENTS[result.intent].label}”，预期“${INTENTS[expected].label}”`);
  else if (result.intent !== expected) wrong.push(`${content} → 判成“${INTENTS[result.intent].label}”，应为“${INTENTS[expected].label}”`);
}

// 模型不可用时只能靠关键词：这一路也要测，看兜底时会漏多少。
const fallbackMisses = CASES.filter(([, expected, content]) => INTENTS[expected].lead && !matchedKeywords(content, settings.intent_keywords).length).map(item => item[2]);
console.log(`共 ${CASES.length} 条，关键词 ${settings.intent_keywords.length} 个。`);
console.log(`模型不可用、只靠关键词兜底时会漏掉的意向消息：${fallbackMisses.length} 条${fallbackMisses.length ? `（${fallbackMisses.join('；')}）` : ''}`);
console.log(`被关键词初筛漏掉的意向评论：${filtered.length} 条`);
for (const content of filtered) console.log(`  ${content}（命中关键词：${matchedKeywords(content, settings.intent_keywords).join('、') || '无'}）`);
console.log(`模型判断和预期不一致：${wrong.length} 条`);
for (const line of wrong) console.log(`  ${line}`);
process.exit(filtered.length || fallbackMisses.length || wrong.some(line => !line.startsWith('（分类偏差')) ? 1 : 0);
