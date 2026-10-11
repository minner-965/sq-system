// 互动收件箱：评论和私信的意图分类、提醒、回复、转线索。需求见 docs/hz/自动发帖/功能需求.md 第 6 节。
import { randomUUID } from 'node:crypto';
import { findForbidden } from '../publishing/copywriter.js';

export const INTENTS = Object.freeze({
  inquiry: { label: '询价或租铺', lead: true },
  viewing: { label: '看房预约', lead: true },
  cooperation: { label: '合作或入驻', lead: true },
  booking: { label: '酒店或餐饮预订', lead: true },
  chat: { label: '普通互动', lead: false },
  spam: { label: '广告或垃圾', lead: false }
});
export const LEAD_INTENTS = Object.freeze(Object.keys(INTENTS).filter(key => INTENTS[key].lead));
export const PLATFORM_NAME = Object.freeze({ douyin: '抖音', channels: '视频号', xiaohongshu: '小红书', moments: '朋友圈' });
const KIND_NAME = { comment: '评论', direct_message: '私信' };
const STATUSES = ['new', 'in_progress', 'converted', 'ignored'];
export const OVERDUE_HOURS = 2;
// 内容类型 → 线索进入哪个板块。
const SECTOR_OF = { property: 'office_retail', event: 'office_retail', hotel: 'hotel_apartment', dining: 'dining' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const requireUuid = value => { if (!UUID.test(String(value))) throw fail(404, 'MESSAGE_NOT_FOUND', '没有找到这条消息'); };
const llmCost = (usage, env) => (usage.inputTokens * Number(env.LLM_PRICE_INPUT_PER_M || 2) + usage.outputTokens * Number(env.LLM_PRICE_OUTPUT_PER_M || 8)) / 1_000_000;

export const matchedKeywords = (content, keywords) => keywords.filter(keyword => content.includes(keyword));

const CLASSIFY_PROMPT = `你在帮广州恒兆广场（商铺写字楼招租、宜尚酒店、自营餐饮）处理社交平台上的评论和私信。
判断这条消息的意图，只能是下面六种之一：
- inquiry：问价格、面积、位置、怎么租，或表示想租铺位、写字楼
- viewing：想约时间看房、看铺、看场地
- cooperation：谈合作、品牌入驻、供应商或渠道合作
- booking：想订酒店房间、订餐、订包间、问团餐或协议价
- chat：普通互动，夸奖、吐槽、闲聊、@朋友，没有明确需求
- spam：广告、引流、无意义刷屏。别人来推销自己的服务或招人（代运营、涨粉、兼职、刷单、“私我”“加V”）都算这一类
注意：问会议室、包间、订餐、住宿、长住、团建吃饭的属于 booking；问车位、家具、签约年限、能否注册公司、能否做餐饮这类租赁条件的属于 inquiry。
只输出 JSON：{"intent":"inquiry","reason":"不超过30字，说明依据"}`;

/** Verdict from keywords alone: used when the model is not configured or is down. */
export function classifyByKeywords(message, keywords, note) {
  const hits = matchedKeywords(message.content, keywords);
  return hits.length
    ? { intent: 'inquiry', reason: `出现关键词：${hits.slice(0, 3).join('、')}（${note}，只按关键词判断）`, source: 'keyword', usage: null }
    : { intent: 'chat', reason: `没有出现询价、预订一类的关键词（${note}）`, source: 'keyword', usage: null };
}

/**
 * Every message goes to the model when one is configured. Self-testing showed a keyword
 * pre-filter alone missed about half of real enquiries ("带家具不", "最短签多久"), and a
 * classification costs a fraction of a cent, so keywords are only the fallback.
 */
export async function classifyMessage({ message, keywords, llm }) {
  if (!llm.configured) return classifyByKeywords(message, keywords, '还没有配置大模型');
  const { data, usage } = await llm.chatJson({
    messages: [
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: `来源：${PLATFORM_NAME[message.platform]}${KIND_NAME[message.kind]}\n所在帖子：${message.post_title || '（私信，没有帖子）'}\n消息：${message.content}` }
    ],
    maxTokens: 120, temperature: 0
  });
  const intent = INTENTS[data?.intent] ? data.intent : 'chat';
  return { intent, reason: String(data?.reason || '').trim().slice(0, 60) || '模型没有给出依据', source: 'model', usage };
}

async function assigneeFor(db, publishTaskId) {
  const { rows: [row] } = await db.query(`
    SELECT m.content_type, s.assignee_property, s.assignee_event, s.assignee_hotel, s.assignee_dining
    FROM leadgen.inbox_settings s
    LEFT JOIN leadgen.publish_tasks t ON t.id = $1
    LEFT JOIN leadgen.materials m ON m.id = t.material_id
    WHERE s.id = 1`, [publishTaskId]);
  return row?.[`assignee_${row.content_type || 'property'}`] ?? null;
}

/**
 * Classifies every message that has no intent yet, assigns an owner and raises
 * a notification for the ones that show intent. Run by the worker every minute.
 */
export async function classifyPending(pool, { llm, env = process.env, limit = 30 }) {
  const { rows: [settings] } = await pool.query('SELECT intent_keywords FROM leadgen.inbox_settings WHERE id = 1');
  const { rows: pending } = await pool.query(`
    SELECT id, platform, kind, publish_task_id, post_title, sender_name, content FROM leadgen.interaction_messages
    WHERE intent IS NULL ORDER BY created_at LIMIT $1`, [limit]);
  let leads = 0;
  for (const message of pending) {
    const started = Date.now();
    let result;
    try {
      result = await classifyMessage({ message, keywords: settings.intent_keywords, llm });
    } catch (error) {
      await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, error_code, duration_ms) VALUES ($1, 'chat/completions', '意图分类', 'error', $2, $3)`,
        [llm.provider, error.code || error.name, Date.now() - started]);
      // 模型不可用时不卡住提醒：有关键词的先按意向消息处理，人来改。
      // 没命中关键词的会在模型恢复后由 auditKeywordMisses 再看一遍。
      result = classifyByKeywords(message, settings.intent_keywords, '大模型暂时不可用');
    }
    if (result.usage) {
      await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, cost_cny, duration_ms) VALUES ($1, 'chat/completions', '意图分类', 'ok', $2, $3)`,
        [llm.provider, llmCost(result.usage, env), Date.now() - started]);
    }
    const isLead = INTENTS[result.intent].lead;
    const assignee = isLead ? await assigneeFor(pool, message.publish_task_id) : null;
    const { rowCount } = await pool.query(`
      UPDATE leadgen.interaction_messages SET intent = $2, intent_reason = $3, intent_source = $4, classified_at = now(),
        assignee_user_id = $5, status = CASE WHEN $2 = 'spam' THEN 'ignored' ELSE status END, updated_at = now()
      WHERE id = $1 AND intent IS NULL`, [message.id, result.intent, result.reason, result.source, assignee]);
    if (!rowCount || !isLead) continue;
    leads += 1;
    await pool.query(`
      INSERT INTO leadgen.notifications (recipient_user_id, recipient_role, kind, title, body, link)
      VALUES ($1, $2, 'interaction', $3, $4, '/inbox.html')`,
    [assignee, assignee ? null : 'admin', `${PLATFORM_NAME[message.platform]}有新的${INTENTS[result.intent].label}`,
      `${message.post_title ? `《${message.post_title.slice(0, 20)}》` : KIND_NAME[message.kind]}，${message.sender_name}：${message.content.slice(0, 30)}`]);
  }
  const audit = await auditKeywordMisses(pool, { llm, env });
  return { classified: pending.length, leads: leads + audit.recovered, audited: audit.audited, keywords_added: audit.keywordsAdded };
}

const AUDIT_PROMPT = `下面是广州恒兆广场（商铺写字楼招租、宜尚酒店、自营餐饮）帖子下的一批评论，它们没有命中询价关键词，被当成了普通互动。
请逐条复查：有没有其实在表达需求的（问价格面积位置、想租、想看房看铺、谈合作入驻、想订房订餐）。
只列出确实有需求的评论，其余不要列。对每条给出：
- n：评论编号
- intent：inquiry（询价或想租）、viewing（约看）、cooperation（合作入驻）、booking（订房订餐）之一
- reason：不超过 30 字的依据
- keyword：这条评论里最能代表需求、以后可以用来初筛的一个词，2–6 个字，必须是评论原文里连续出现的字，不要用“的”“了”“吗”这类虚词，也不要用人名地名
只输出 JSON：{"items":[{"n":1,"intent":"viewing","reason":"...","keyword":"..."}]}。都没有需求就输出 {"items":[]}。`;

/** A keyword the audit proposes is only accepted when it really occurs in the comment and is a plausible search word. */
export function acceptKeyword(keyword, content, existing) {
  const word = String(keyword || '').trim();
  if (word.length < 2 || word.length > 6 || !content.includes(word) || existing.includes(word)) return null;
  if (/^[\d\s\p{P}]+$/u.test(word) || /^(什么|怎么|可以|这个|那个|你们|我们|有的|一下|还是)$/.test(word)) return null;
  return word;
}

/**
 * Second look at comments the keyword filter waved through as ordinary interaction.
 * Recovers the ones that do show intent and teaches the filter the word it missed.
 */
export async function auditKeywordMisses(pool, { llm, env = process.env, limit = 20 }) {
  if (!llm.configured) return { audited: 0, recovered: 0, keywordsAdded: [] };
  const { rows: batch } = await pool.query(`
    SELECT id, platform, kind, publish_task_id, post_title, sender_name, content FROM leadgen.interaction_messages
    WHERE intent = 'chat' AND intent_source = 'keyword' AND audited_at IS NULL ORDER BY created_at LIMIT $1`, [limit]);
  if (!batch.length) return { audited: 0, recovered: 0, keywordsAdded: [] };
  const started = Date.now();
  let items;
  try {
    const { data, usage } = await llm.chatJson({
      messages: [{ role: 'system', content: AUDIT_PROMPT }, { role: 'user', content: batch.map((message, index) => `${index + 1}. ${message.content}`).join('\n') }],
      maxTokens: 800, temperature: 0
    });
    items = Array.isArray(data?.items) ? data.items : [];
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, result_count, cost_cny, duration_ms) VALUES ($1, 'chat/completions', $2, 'ok', $3, $4, $5)`,
      [llm.provider, `复查普通互动 ${batch.length} 条`, items.length, llmCost(usage, env), Date.now() - started]);
  } catch (error) {
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, error_code, duration_ms) VALUES ($1, 'chat/completions', '复查普通互动', 'error', $2, $3)`,
      [llm.provider, error.code || error.name, Date.now() - started]);
    return { audited: 0, recovered: 0, keywordsAdded: [] };
  }
  const { rows: [settings] } = await pool.query('SELECT intent_keywords FROM leadgen.inbox_settings WHERE id = 1');
  const keywords = [...settings.intent_keywords];
  const keywordsAdded = [];
  let recovered = 0;
  for (const item of items) {
    const message = batch[Number(item?.n) - 1];
    if (!message || !LEAD_INTENTS.includes(item.intent)) continue;
    const reason = `复查时发现：${String(item.reason || '').trim().slice(0, 40) || '有需求'}`;
    const assignee = await assigneeFor(pool, message.publish_task_id);
    const { rowCount } = await pool.query(`
      UPDATE leadgen.interaction_messages SET intent = $2, intent_reason = $3, intent_source = 'model', assignee_user_id = $4, classified_at = now(), updated_at = now()
      WHERE id = $1 AND intent = 'chat' AND intent_source = 'keyword'`, [message.id, item.intent, reason, assignee]);
    if (!rowCount) continue;
    recovered += 1;
    await pool.query(`
      INSERT INTO leadgen.notifications (recipient_user_id, recipient_role, kind, title, body, link) VALUES ($1, $2, 'interaction', $3, $4, '/inbox.html')`,
    [assignee, assignee ? null : 'admin', `${PLATFORM_NAME[message.platform]}有新的${INTENTS[item.intent].label}`, `${message.sender_name}：${message.content.slice(0, 30)}`]);
    const word = acceptKeyword(item.keyword, message.content, keywords);
    if (word) {
      keywords.push(word);
      keywordsAdded.push(word);
      await pool.query('INSERT INTO leadgen.inbox_keyword_additions (keyword, from_message_id, example) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [word, message.id, message.content.slice(0, 200)]);
    }
  }
  if (keywordsAdded.length) await pool.query('UPDATE leadgen.inbox_settings SET intent_keywords = $1, updated_at = now() WHERE id = 1', [keywords]);
  await pool.query('UPDATE leadgen.interaction_messages SET audited_at = now() WHERE id = ANY($1)', [batch.map(message => message.id)]);
  return { audited: batch.length, recovered, keywordsAdded };
}

const MESSAGE_COLUMNS = `i.id, i.platform, i.kind, i.post_title, i.post_url, i.publish_task_id, i.sender_name, i.sender_profile_url, i.content,
  i.sent_at, i.source, i.intent, i.intent_reason, i.intent_source, i.status, i.assignee_user_id, a.display_name AS assignee_name,
  i.company_id, i.reply_text, i.reply_status, i.reply_error, i.replied_at, t.material_id,
  i.intent = ANY($1) AND i.status = 'new' AND i.sent_at < now() - make_interval(hours => $2) AS overdue`;

const decorate = row => ({
  ...row, platform_name: PLATFORM_NAME[row.platform], kind_name: KIND_NAME[row.kind], intent_name: row.intent ? INTENTS[row.intent].label : '正在判断'
});

/** Inbox columns hold messages that show intent; ordinary interaction is only counted, spam stays hidden. */
export async function listInbox(pool, { status = 'new', user, mine = false, limit = 50, offset = 0 }) {
  if (!STATUSES.includes(status)) throw fail(400, 'INBOX_STATUS_INVALID', '分栏不正确');
  const scope = `(i.intent = ANY($1) OR i.status IN ('converted', 'in_progress')) AND ($3::uuid IS NULL OR i.assignee_user_id = $3)`;
  const [{ rows }, { rows: counts }, { rows: [other] }] = await Promise.all([
    pool.query(`
      SELECT ${MESSAGE_COLUMNS} FROM leadgen.interaction_messages i
      LEFT JOIN leadgen.users a ON a.id = i.assignee_user_id
      LEFT JOIN leadgen.publish_tasks t ON t.id = i.publish_task_id
      WHERE ${scope} AND i.status = $4
      ORDER BY (i.intent = ANY($1) AND i.status = 'new' AND i.sent_at < now() - make_interval(hours => $2)) DESC, i.sent_at DESC
      LIMIT $5 OFFSET $6`,
    [LEAD_INTENTS, OVERDUE_HOURS, mine ? user.id : null, status, Math.min(Math.max(Number(limit) || 50, 1), 100), Math.max(Number(offset) || 0, 0)]),
    pool.query(`SELECT i.status, count(*)::int AS n FROM leadgen.interaction_messages i WHERE ${scope.replaceAll('$3', '$2')} GROUP BY i.status`, [LEAD_INTENTS, mine ? user.id : null]),
    pool.query(`
      SELECT count(*) FILTER (WHERE intent = 'chat')::int AS chat, count(*) FILTER (WHERE intent = 'spam')::int AS spam,
             count(*) FILTER (WHERE intent IS NULL)::int AS pending FROM leadgen.interaction_messages`)
  ]);
  return {
    counts: Object.fromEntries(STATUSES.map(key => [key, counts.find(row => row.status === key)?.n ?? 0])),
    ordinary: other.chat, hidden_spam: other.spam, classifying: other.pending,
    items: rows.map(decorate)
  };
}

/** Sidebar badge and desktop notifications: unhandled messages that show intent. */
export async function inboxSummary(pool, { since = null } = {}) {
  const { rows: [count] } = await pool.query(`SELECT count(*)::int AS unhandled FROM leadgen.interaction_messages WHERE status = 'new' AND intent = ANY($1)`, [LEAD_INTENTS]);
  const { rows: fresh } = since ? await pool.query(`
    SELECT id, platform, post_title, sender_name, content, classified_at FROM leadgen.interaction_messages
    WHERE status = 'new' AND intent = ANY($1) AND classified_at > $2 ORDER BY classified_at LIMIT 5`, [LEAD_INTENTS, since]) : { rows: [] };
  return { unhandled: count.unhandled, fresh: fresh.map(row => ({ ...row, platform_name: PLATFORM_NAME[row.platform] })), server_time: new Date().toISOString() };
}

async function loadMessage(db, messageId, { lock = false } = {}) {
  requireUuid(messageId);
  const { rows: [message] } = await db.query(`SELECT * FROM leadgen.interaction_messages WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [messageId]);
  if (!message) throw fail(404, 'MESSAGE_NOT_FOUND', '没有找到这条消息');
  return message;
}

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/** Manual entry: for messages only visible on a phone (e.g. Xiaohongshu direct messages). Goes through the same classification. */
export async function addManualMessage(pool, { input, user }) {
  const content = String(input.content || '').trim();
  const sender = String(input.sender_name || '').trim();
  if (!PLATFORM_NAME[input.platform]) throw fail(400, 'MESSAGE_PLATFORM_INVALID', '请选择平台');
  if (!KIND_NAME[input.kind]) throw fail(400, 'MESSAGE_KIND_INVALID', '请选择是评论还是私信');
  if (!content || !sender) throw fail(400, 'MESSAGE_CONTENT_REQUIRED', '请填写对方昵称和原话');
  const { rows: [row] } = await pool.query(`
    INSERT INTO leadgen.interaction_messages (platform, kind, platform_message_id, post_title, sender_name, sender_platform_id, content, sent_at, source, handled_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'manual', $8) RETURNING id`,
  [input.platform, input.kind, `manual-${randomUUID()}`, String(input.post_title || '').trim().slice(0, 200) || null, sender.slice(0, 60),
    `name:${sender.slice(0, 60)}`, content.slice(0, 2000), user.id]);
  return row;
}

export function changeIntent(pool, { messageId, intent, user }) {
  if (!INTENTS[intent]) throw fail(400, 'INTENT_INVALID', '意图分类不正确');
  return inTransaction(pool, async client => {
    const message = await loadMessage(client, messageId, { lock: true });
    if (message.intent === intent) return { intent };
    await client.query(`
      UPDATE leadgen.interaction_messages SET intent = $2, intent_source = 'manual', intent_reason = $3, updated_at = now() WHERE id = $1`,
    [messageId, intent, `${user.displayName}改为“${INTENTS[intent].label}”`]);
    await client.query('INSERT INTO leadgen.interaction_intent_changes (message_id, from_intent, to_intent, changed_by) VALUES ($1, $2, $3, $4)',
      [messageId, message.intent, intent, user.id]);
    return { intent };
  });
}

export function setStatus(pool, { messageId, status, user }) {
  if (!['new', 'in_progress', 'ignored'].includes(status)) throw fail(400, 'INBOX_STATUS_INVALID', '状态不正确');
  return inTransaction(pool, async client => {
    const message = await loadMessage(client, messageId, { lock: true });
    if (message.status === 'converted') throw fail(409, 'MESSAGE_ALREADY_CONVERTED', '这条消息已经转成线索');
    await client.query('UPDATE leadgen.interaction_messages SET status = $2, handled_by = $3, handled_at = now(), updated_at = now() WHERE id = $1', [messageId, status, user.id]);
    return { status };
  });
}

async function postFacts(db, message) {
  if (!message.publish_task_id) return { lines: [], floors: await floors(db, null) };
  const { rows: [post] } = await db.query(`
    SELECT m.topic, m.note, m.content_type, t.body, p.building, p.floor, p.unit_no, p.property_type, p.area_sqm,
           p.list_rent_per_sqm, p.management_fee_per_sqm, p.fit_out
    FROM leadgen.publish_tasks t JOIN leadgen.materials m ON m.id = t.material_id
    LEFT JOIN leadgen.properties p ON p.id = m.property_id WHERE t.id = $1`, [message.publish_task_id]);
  if (!post) return { lines: [], floors: await floors(db, null) };
  const lines = [`帖子主题：${post.topic}`, `帖子正文：${post.body || ''}`];
  if (post.unit_no) {
    lines.push(`房源：${post.building} ${post.floor} 层 ${post.unit_no}，${Number(post.area_sqm)} ㎡${post.fit_out ? `，${post.fit_out}` : ''}`);
    lines.push(`公开报价：租金 ${Number(post.list_rent_per_sqm)} 元/㎡·月，管理费 ${Number(post.management_fee_per_sqm)} 元/㎡·月`);
  }
  return { lines, floors: await floors(db, post.property_type) };
}

async function floors(db, propertyType) {
  const { rows } = await db.query('SELECT property_type, floor_price_per_sqm FROM leadgen.leasing_policy WHERE floor_price_per_sqm IS NOT NULL');
  return rows.filter(row => !propertyType || row.property_type === propertyType).map(row => Number(row.floor_price_per_sqm));
}

const REPLY_PROMPT = `你是广州恒兆广场的招商或客服人员，要回复社交平台上的一条评论或私信。
要求：
1. 先正面回答对方问的事，只用给出的事实；事实里没有的不要编，可以说“具体的我私信您”。
2. 引导对方留电话，或私信我们加工作微信，方便详细介绍、约时间看场。
3. 租金只说公开报价或“欢迎咨询”，不提任何优惠价、最低价、底价。
4. 口语化，像真人回复，不超过 80 字，不用感叹号堆砌，不写“亲”“家人们”。
只输出 JSON：{"reply":"..."}`;

/** Drafts a reply with the model; it is never sent until someone confirms it. */
export async function draftReply(pool, { messageId, llm, env = process.env }) {
  if (!llm.configured) throw fail(409, 'LLM_KEY_MISSING', '还没有配置大模型，请直接手写回复');
  const message = await loadMessage(pool, messageId);
  const { lines, floors: floorPrices } = await postFacts(pool, message);
  const messages = [
    { role: 'system', content: REPLY_PROMPT },
    { role: 'user', content: `${lines.join('\n') || '（没有关联的帖子资料）'}\n\n对方（${message.sender_name}）在${PLATFORM_NAME[message.platform]}${KIND_NAME[message.kind]}里说：${message.content}` }
  ];
  const started = Date.now();
  let reply = '';
  let problem = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result;
    try { result = await llm.chatJson({ messages, maxTokens: 300, temperature: 0.6 }); }
    catch (error) { throw fail(502, 'LLM_FAILED', `大模型服务不可用：${error.message}。可以先手写回复`); }
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, cost_cny, duration_ms) VALUES ($1, 'chat/completions', '起草回复', 'ok', $2, $3)`,
      [llm.provider, llmCost(result.usage, env), Date.now() - started]);
    reply = String(result.data?.reply || '').trim();
    problem = !reply ? '没有内容' : findForbidden(reply, floorPrices);
    if (!problem) break;
    messages.push({ role: 'assistant', content: JSON.stringify(result.data) }, { role: 'user', content: `这一版有问题：${problem === '没有内容' ? problem : `出现了${problem}`}。请重写。` });
  }
  if (problem) throw fail(502, 'REPLY_DRAFT_REJECTED', '起草的回复不合要求，请手写');
  await pool.query(`UPDATE leadgen.interaction_messages SET reply_text = $2, reply_status = 'drafted', updated_at = now() WHERE id = $1 AND reply_status IN ('none', 'drafted', 'failed')`, [messageId, reply]);
  return { reply };
}

/**
 * A person confirms the reply text. `manual` records that it was sent by hand on a phone;
 * otherwise it is queued for the publisher to send from the account that received the message.
 */
export function confirmReply(pool, { messageId, text, manual = false, user }) {
  return inTransaction(pool, async client => {
    const message = await loadMessage(client, messageId, { lock: true });
    const reply = String(text ?? message.reply_text ?? '').trim();
    if (!reply) throw fail(400, 'REPLY_TEXT_REQUIRED', '请先写好回复内容');
    if (reply.length > 300) throw fail(400, 'REPLY_TOO_LONG', '回复不超过 300 字');
    if (['queued', 'sent'].includes(message.reply_status)) throw fail(409, 'REPLY_ALREADY_CONFIRMED', '这条回复已经确认过');
    const forbidden = findForbidden(reply, (await postFacts(client, message)).floors);
    if (forbidden) throw fail(400, 'REPLY_FORBIDDEN_WORDING', `回复里不能出现${forbidden}`);
    // 手工录入的消息在系统里没有对应的平台会话，只能手动回复。
    const status = manual ? 'manual' : message.source === 'manual' || !message.account_id ? 'failed' : 'queued';
    await client.query(`
      UPDATE leadgen.interaction_messages SET reply_text = $2, reply_status = $3, reply_confirmed_by = $4, reply_confirmed_at = now(),
        replied_at = CASE WHEN $3 = 'manual' THEN now() ELSE replied_at END,
        reply_error = CASE WHEN $3 = 'failed' THEN '这条消息是手工录入的，系统发不了，请复制到手机上回复' ELSE NULL END,
        status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END, handled_by = $4, handled_at = now(), updated_at = now()
      WHERE id = $1`, [messageId, reply, status, user.id]);
    if (message.company_id) {
      await client.query(`
        INSERT INTO leadgen.activities (track_id, activity_type, content, created_by)
        SELECT t.id, 'note', $2, $3 FROM leadgen.company_sector_tracks t WHERE t.company_id = $1 ORDER BY t.created_at LIMIT 1`,
      [message.company_id, `${manual ? '已手动回复' : '确认回复'}（${PLATFORM_NAME[message.platform]}）：${reply}`, user.id]);
    }
    return { reply_status: status };
  });
}

/**
 * Turns a message into a lead: one company record per platform account, followed up in the sector
 * that matches the post. A returning sender is merged into their existing record.
 */
export function convertToLead(pool, { messageId, user }) {
  return inTransaction(pool, async client => {
    const message = await loadMessage(client, messageId, { lock: true });
    if (message.status === 'converted') return { company_id: message.company_id, merged: true };
    const { rows: [post] } = message.publish_task_id ? await client.query(`
      SELECT m.content_type, m.property_id, m.topic FROM leadgen.publish_tasks t JOIN leadgen.materials m ON m.id = t.material_id WHERE t.id = $1`, [message.publish_task_id]) : { rows: [] };
    const sectorKey = message.intent === 'booking' && !post ? 'hotel_apartment' : SECTOR_OF[post?.content_type || 'property'];
    if (!user.sectors.includes(sectorKey)) throw fail(403, 'SECTOR_FORBIDDEN', '这条线索属于别的板块，请让负责该板块的同事来转');
    const senderKey = message.sender_platform_id || `name:${message.sender_name}`;
    const { rows: [existing] } = await client.query('SELECT id FROM leadgen.companies WHERE source = $1 AND source_ref = $2', [message.platform, senderKey]);
    const companyId = existing?.id ?? (await client.query(`
      INSERT INTO leadgen.companies (company_name, source, source_ref, website_url, data_origin, qualification_status, company_description)
      VALUES ($1, $2, $3, $4, 'social_lead', 'qualified', $5) RETURNING id`,
    [`${PLATFORM_NAME[message.platform]}用户 ${message.sender_name}`, message.platform, senderKey, message.sender_profile_url, '来自社交平台的评论或私信'])).rows[0].id;
    const { rows: [track] } = await client.query(`
      INSERT INTO leadgen.company_sector_tracks (company_id, sector_key, stage, owner_user_id, intended_property_id, contact_name)
      VALUES ($1, $2, 'new', $3, $4, $5)
      ON CONFLICT (company_id, sector_key) DO UPDATE SET updated_at = now()
      RETURNING id, (xmax = 0) AS inserted`,
    [companyId, sectorKey, message.assignee_user_id || user.id, sectorKey === 'office_retail' ? post?.property_id ?? null : null, message.sender_name]);
    const source = [
      `来源：${PLATFORM_NAME[message.platform]}${KIND_NAME[message.kind]}`,
      message.post_title ? `帖子：《${message.post_title}》${message.post_url ? ` ${message.post_url}` : ''}` : null,
      `对方：${message.sender_name}${message.sender_profile_url ? ` ${message.sender_profile_url}` : ''}`,
      `原话：${message.content}`,
      `判断：${INTENTS[message.intent]?.label || '未分类'}`
    ].filter(Boolean).join('\n');
    await client.query(`INSERT INTO leadgen.activities (track_id, activity_type, content, occurred_at, created_by) VALUES ($1, 'note', $2, $3, $4)`,
      [track.id, source, message.sent_at, user.id]);
    await client.query(`
      UPDATE leadgen.interaction_messages SET status = 'converted', company_id = $2, handled_by = $3, handled_at = now(), updated_at = now() WHERE id = $1`,
    [messageId, companyId, user.id]);
    return { company_id: companyId, merged: Boolean(existing) || !track.inserted };
  });
}

const MIN_CHECK_GAP_MINUTES = 10;

/** When each logged-in publishing account was last read for comments, and whether a check is waiting. */
export async function checkStatus(pool) {
  const { rows } = await pool.query(`
    SELECT a.id, a.platform, a.account_name, a.last_inbox_check_at, a.last_inbox_check_note, a.next_inbox_check_at,
           EXISTS (SELECT 1 FROM leadgen.inbox_check_requests r WHERE r.account_id = a.id AND r.status IN ('queued', 'running')) AS checking,
           (SELECT r.error_message FROM leadgen.inbox_check_requests r WHERE r.account_id = a.id ORDER BY r.created_at DESC LIMIT 1) AS last_request_error
    FROM leadgen.publish_accounts a WHERE a.purpose = 'publish' AND a.login_status = 'ok' ORDER BY a.created_at`);
  const { rows: [beat] } = await pool.query(`SELECT last_seen_at > now() - interval '90 seconds' AS online FROM leadgen.publisher_heartbeat WHERE id = 1`);
  return { publisher_online: Boolean(beat?.online), accounts: rows.map(row => ({ ...row, platform_name: PLATFORM_NAME[row.platform] })) };
}

/** "Check now": asks the publisher to read every logged-in account, at most once per ten minutes each. */
export async function requestCheck(pool, { user }) {
  const status = await checkStatus(pool);
  if (!status.publisher_online) throw fail(409, 'PUBLISHER_OFFLINE', '发布程序没有在运行，暂时读不了。请在这台电脑上双击 publisher 文件夹里的 start-publisher.cmd');
  if (!status.accounts.length) throw fail(409, 'NO_ACCOUNT_LOGGED_IN', '还没有登录好的发布账号');
  const { rowCount } = await pool.query(`
    INSERT INTO leadgen.inbox_check_requests (account_id, trigger, requested_by)
    SELECT a.id, 'manual', $1 FROM leadgen.publish_accounts a
    WHERE a.purpose = 'publish' AND a.login_status = 'ok'
      AND (a.last_inbox_check_at IS NULL OR a.last_inbox_check_at < now() - make_interval(mins => $2))
      AND NOT EXISTS (SELECT 1 FROM leadgen.inbox_check_requests r WHERE r.account_id = a.id AND r.status IN ('queued', 'running'))`,
  [user.id, MIN_CHECK_GAP_MINUTES]);
  if (!rowCount && !status.accounts.some(account => account.checking)) {
    throw fail(409, 'CHECKED_RECENTLY', `刚检查过，同一个账号两次检查至少隔 ${MIN_CHECK_GAP_MINUTES} 分钟`);
  }
  return { queued: rowCount };
}

export async function getInboxSettings(pool) {
  const { rows: [row] } = await pool.query('SELECT intent_keywords, assignee_property, assignee_event, assignee_hotel, assignee_dining FROM leadgen.inbox_settings WHERE id = 1');
  const { rows: users } = await pool.query(`SELECT u.id, u.display_name FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key WHERE u.is_active AND r.can_write ORDER BY u.display_name`);
  return { ...row, users };
}

export async function updateInboxSettings(pool, input) {
  const keywords = [...new Set((Array.isArray(input.intent_keywords) ? input.intent_keywords : []).map(item => String(item).trim()).filter(Boolean))];
  if (!keywords.length || keywords.length > 80 || keywords.some(keyword => keyword.length > 20)) throw fail(400, 'INBOX_SETTINGS_INVALID', '关键词要 1–80 个，每个不超过 20 字');
  const owner = value => { if (value == null || value === '') return null; if (!UUID.test(String(value))) throw fail(400, 'INBOX_SETTINGS_INVALID', '负责人不正确'); return value; };
  await pool.query(`
    UPDATE leadgen.inbox_settings SET intent_keywords = $1, assignee_property = $2, assignee_event = $3, assignee_hotel = $4, assignee_dining = $5, updated_at = now() WHERE id = 1`,
  [keywords, owner(input.assignee_property), owner(input.assignee_event), owner(input.assignee_hotel), owner(input.assignee_dining)]);
  return getInboxSettings(pool);
}
