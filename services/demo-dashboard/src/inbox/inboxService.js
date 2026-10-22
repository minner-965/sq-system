// 互动收件箱：评论和私信的意图分类、提醒、回复、转线索。需求见 docs/hz/自动发帖/功能需求.md 第 6 节。
import { randomUUID } from 'node:crypto';
import { findForbidden } from '../publishing/copywriter.js';
import { phoneDmEnabled } from '../phone/phoneService.js';

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
// 2026-10-12 实测：从创作者后台发出的私信，发出方看得到、对方收不到；手机上手动发的对方能收到。
// 所以私信一律由人在手机上回，系统只读、提醒、起草。升级企业号后接平台官方的自动回复时再打开。
// 专用手机测试通过、管理员打开“在手机上回私信”以后，人确认过的私信回复由手机的抖音 App 发出（见 phoneDmEnabled），
// 陌生人自动回复仍由这个常量关着。
export const DM_SENDING_AVAILABLE = false;
export const DEFAULT_AUTO_REPLY = '您好，这里是恒兆广场招商部，消息已收到。方便留个电话或微信吗？招商同事会尽快联系您，发详细资料、约时间看场。';
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
/** 对方主动留下的手机号和微信号。手机号允许中间有空格或横线（“138 1234 5678”）。 */
export function extractContact(text) {
  const compact = String(text || '').replace(/(?<=\d)[\s-](?=\d)/g, '');
  const phone = compact.match(/(?<!\d)1[3-9]\d{9}(?!\d)/)?.[0] ?? null;
  const wechat = String(text || '').match(/(?:微信|vx|wx|v信|薇信|威信)\s*(?:号|同号)?\s*[:：是]?\s*([a-zA-Z][-_a-zA-Z0-9]{5,19})/i)?.[1] ?? null;
  const qq = String(text || '').match(/(?:qq|扣扣|企鹅)\s*(?:号)?\s*[:：是]?\s*([1-9]\d{4,10})(?!\d)/i)?.[1] ?? null;
  const email = String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
  return { phone, wechat, qq, email };
}

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
 * Stranger direct messages get one fixed reply asking for contact details (the exception Simon confirmed on
 * 2026-10-11, CLAUDE.md section 3). Never for spam, never twice for the same person, never when the person
 * has already left contact details, and never past the daily limit. The publisher sends it.
 */
async function queueAutoReply(pool, message, contact) {
  if (!DM_SENDING_AVAILABLE) return false;
  if (message.kind !== 'direct_message' || message.source !== 'reader' || !message.account_id || message.intent === 'spam') return false;
  if (contact.phone || contact.wechat || contact.qq || contact.email) return false;
  const { rowCount } = await pool.query(`
    UPDATE leadgen.interaction_messages i SET reply_text = s.dm_auto_reply_text, reply_status = 'queued', reply_auto = true,
      reply_confirmed_by = s.dm_auto_reply_enabled_by, reply_confirmed_at = now(), updated_at = now()
    FROM leadgen.inbox_settings s
    WHERE i.id = $1 AND s.id = 1 AND s.dm_auto_reply_enabled AND i.reply_status = 'none'
      AND NOT EXISTS (SELECT 1 FROM leadgen.interaction_messages earlier
                      WHERE earlier.platform = i.platform AND earlier.kind = 'direct_message' AND earlier.id <> i.id
                        AND earlier.sender_platform_id = i.sender_platform_id AND earlier.reply_status IN ('queued', 'sent', 'manual'))
      AND (SELECT count(*) FROM leadgen.interaction_messages today
           WHERE today.reply_auto AND today.reply_confirmed_at >= date_trunc('day', now())) < s.dm_auto_reply_daily_limit`, [message.id]);
  return rowCount > 0;
}

/**
 * Classifies every message that has no intent yet, assigns an owner and raises
 * a notification for the ones that show intent. Run by the worker every minute.
 */
export async function classifyPending(pool, { llm, env = process.env, limit = 30 }) {
  const { rows: [settings] } = await pool.query('SELECT intent_keywords FROM leadgen.inbox_settings WHERE id = 1');
  const { rows: pending } = await pool.query(`
    SELECT id, platform, kind, source, account_id, publish_task_id, post_title, sender_name, sender_platform_id, content FROM leadgen.interaction_messages
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
    if (result.intent === 'chat' && message.sender_platform_id) {
      // 询过价的人后面再说的话（“好的”“已私信”），单看是普通互动，其实是同一桩生意的后续，照样提醒。
      const { rows: [earlier] } = await pool.query(`
        SELECT intent FROM leadgen.interaction_messages
        WHERE platform = $1 AND sender_platform_id = $2 AND id <> $3 AND intent IN ('inquiry', 'viewing', 'cooperation', 'booking')
        ORDER BY sent_at DESC LIMIT 1`, [message.platform, message.sender_platform_id, message.id]);
      if (earlier) result = { ...result, intent: earlier.intent, reason: `这个人之前${INTENTS[earlier.intent].label}，这是后续` };
    }
    const contact = extractContact(message.content);
    if ((contact.phone || contact.wechat || contact.qq || contact.email) && ['chat'].includes(result.intent)) {
      // 主动留了电话或微信的，不管话怎么说，都按意向处理。
      result = { ...result, intent: 'inquiry', reason: `对方留了${contact.phone ? '电话' : contact.wechat ? '微信' : contact.qq ? 'QQ' : '邮箱'}` };
    }
    const isLead = INTENTS[result.intent].lead;
    const assignee = isLead ? await assigneeFor(pool, message.publish_task_id) : null;
    const { rowCount } = await pool.query(`
      UPDATE leadgen.interaction_messages SET intent = $2, intent_reason = $3, intent_source = $4, classified_at = now(),
        assignee_user_id = $5, status = CASE WHEN $2 = 'spam' THEN 'ignored' ELSE status END, updated_at = now()
      WHERE id = $1 AND intent IS NULL`, [message.id, result.intent, result.reason, result.source, assignee]);
    if (rowCount) await queueAutoReply(pool, { ...message, intent: result.intent }, contact);
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
  i.sent_at, i.source, i.account_id, i.intent, i.intent_reason, i.intent_source, i.status, i.assignee_user_id, a.display_name AS assignee_name,
  i.company_id, i.reply_text, i.reply_status, i.reply_error, i.replied_at, i.reply_auto, i.reply_via, t.material_id,
  i.intent = ANY($1) AND i.status = 'new' AND i.sent_at < now() - make_interval(hours => $2) AS overdue`;

/** 这条私信的回复能不能由专用手机发出：从抖音读进来的私信，并且手机回私信已经打开。 */
export const phoneCanSend = (row, phoneDm) => Boolean(phoneDm) && row.kind === 'direct_message' && row.source === 'reader'
  && row.platform === 'douyin' && Boolean(row.account_id);

export const decorate = (row, phoneDm = false) => ({
  ...row, platform_name: PLATFORM_NAME[row.platform], kind_name: KIND_NAME[row.kind], intent_name: row.intent ? INTENTS[row.intent].label : '正在判断',
  // 系统能不能替人把回复发出去：手工录入的不能；私信从电脑后台发对方收不到，只有专用手机打开以后才能发，否则复制到手机上发。
  can_send: row.source !== 'manual' && Boolean(row.account_id) && (row.kind !== 'direct_message' || DM_SENDING_AVAILABLE || phoneCanSend(row, phoneDm)),
  send_via_phone: !DM_SENDING_AVAILABLE && phoneCanSend(row, phoneDm)
});

/** Inbox columns hold messages that show intent; ordinary interaction is only counted, spam stays hidden. */
export async function listInbox(pool, { status = 'new', user, mine = false, limit = 50, offset = 0 }) {
  if (!STATUSES.includes(status)) throw fail(400, 'INBOX_STATUS_INVALID', '分栏不正确');
  const scope = `(i.intent = ANY($1) OR i.status IN ('converted', 'in_progress')) AND ($3::uuid IS NULL OR i.assignee_user_id = $3)`;
  const [{ rows }, { rows: counts }, { rows: [other] }, phoneDm] = await Promise.all([
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
             count(*) FILTER (WHERE intent IS NULL)::int AS pending FROM leadgen.interaction_messages`),
    phoneDmEnabled(pool)
  ]);
  return {
    counts: Object.fromEntries(STATUSES.map(key => [key, counts.find(row => row.status === key)?.n ?? 0])),
    ordinary: other.chat, hidden_spam: other.spam, classifying: other.pending, phone_dm: phoneDm,
    items: rows.map(row => decorate(row, phoneDm))
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
  if (!message.publish_task_id) return { lines: await mentionedUnits(db, message.content), floors: await floors(db, null) };
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

/** 私信没有关联的帖子：对方提到了在租的房号（“1307 还租吗”）时，把这套房的公开资料给模型，其他一概不给。 */
async function mentionedUnits(db, content) {
  const numbers = [...new Set(String(content || '').match(/(?<!\d)\d{3,4}(?!\d)/g) || [])].slice(0, 5);
  if (!numbers.length) return [];
  const { rows } = await db.query(`
    SELECT building, floor, unit_no, area_sqm, list_rent_per_sqm, management_fee_per_sqm, fit_out
    FROM leadgen.properties WHERE unit_no = ANY($1) AND status <> 'signed' ORDER BY building, unit_no LIMIT 3`, [numbers]);
  return rows.flatMap(row => [
    `在租房源：${row.building} ${row.floor} 层 ${row.unit_no}，${Number(row.area_sqm)} ㎡${row.fit_out ? `，${row.fit_out}` : ''}`,
    `公开报价：租金 ${Number(row.list_rent_per_sqm)} 元/㎡·月，管理费 ${Number(row.management_fee_per_sqm)} 元/㎡·月`]);
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
    { role: 'system', content: message.kind === 'direct_message' ? `${REPLY_PROMPT}
注意：这本身就是私信对话，不要说“我私信您”；事实里没有的，说“我确认一下再回您”。` : REPLY_PROMPT },
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
    // 私信：电脑后台发的对方收不到；专用手机测试通过并打开开关后，由手机的抖音 App 发。
    const viaPhone = !manual && !DM_SENDING_AVAILABLE && phoneCanSend(message, await phoneDmEnabled(client));
    const byHand = message.source === 'manual' || !message.account_id || (message.kind === 'direct_message' && !DM_SENDING_AVAILABLE && !viaPhone);
    const status = manual ? 'manual' : byHand ? 'failed' : 'queued';
    const via = status !== 'queued' ? null : viaPhone ? 'phone' : 'platform';
    await client.query(`
      UPDATE leadgen.interaction_messages SET reply_text = $2, reply_status = $3, reply_confirmed_by = $4, reply_confirmed_at = now(),
        replied_at = CASE WHEN $3 = 'manual' THEN now() ELSE replied_at END,
        reply_error = CASE WHEN $3 = 'failed' THEN $5 ELSE NULL END, reply_via = $6,
        status = CASE WHEN status = 'new' THEN 'in_progress' ELSE status END, handled_by = $4, handled_at = now(), updated_at = now()
      WHERE id = $1`, [messageId, reply, status, user.id,
      message.kind === 'direct_message' && message.source !== 'manual' ? '私信要在手机上回：从电脑后台发的对方收不到。请复制内容到手机上发，发完点“已手动回复”' : '这条消息是手工录入的，系统发不了，请复制到手机上回复',
      via]);
    if (message.company_id) {
      await client.query(`
        INSERT INTO leadgen.activities (track_id, activity_type, content, created_by)
        SELECT t.id, 'note', $2, $3 FROM leadgen.company_sector_tracks t WHERE t.company_id = $1 ORDER BY t.created_at LIMIT 1`,
      [message.company_id, `${manual ? '已手动回复' : '确认回复'}（${PLATFORM_NAME[message.platform]}）：${reply}`, user.id]);
    }
    return { reply_status: status, reply_via: via };
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
    const contact = extractContact(message.content);
    const senderKey = message.sender_platform_id || `name:${message.sender_name}`;
    const { rows: [existing] } = await client.query('SELECT id FROM leadgen.companies WHERE source = $1 AND source_ref = $2', [message.platform, senderKey]);
    const companyId = existing?.id ?? (await client.query(`
      INSERT INTO leadgen.companies (company_name, source, source_ref, website_url, data_origin, qualification_status, company_description)
      VALUES ($1, $2, $3, $4, 'social_lead', 'qualified', $5) RETURNING id`,
    [`${PLATFORM_NAME[message.platform]}用户 ${message.sender_name}`, message.platform, senderKey, message.sender_profile_url, '来自社交平台的评论或私信'])).rows[0].id;
    const { rows: [track] } = await client.query(`
      INSERT INTO leadgen.company_sector_tracks (company_id, sector_key, stage, owner_user_id, intended_property_id, contact_name, contact_phone)
      VALUES ($1, $2, 'new', $3, $4, $5, $6)
      ON CONFLICT (company_id, sector_key) DO UPDATE SET updated_at = now(),
        contact_phone = COALESCE(leadgen.company_sector_tracks.contact_phone, EXCLUDED.contact_phone)
      RETURNING id, (xmax = 0) AS inserted`,
    [companyId, sectorKey, message.assignee_user_id || user.id, sectorKey === 'office_retail' ? post?.property_id ?? null : null, message.sender_name, contact.phone]);
    const source = [
      `来源：${PLATFORM_NAME[message.platform]}${KIND_NAME[message.kind]}`,
      message.post_title ? `帖子：《${message.post_title}》${message.post_url ? ` ${message.post_url}` : ''}` : null,
      `对方：${message.sender_name}${message.sender_profile_url ? ` ${message.sender_profile_url}` : ''}`,
      `原话：${message.content}`,
      `判断：${INTENTS[message.intent]?.label || '未分类'}`,
      contact.phone ? `对方留的电话：${contact.phone}` : null,
      contact.wechat ? `对方留的微信：${contact.wechat}` : null,
      contact.qq ? `对方留的 QQ：${contact.qq}` : null,
      contact.email ? `对方留的邮箱：${contact.email}` : null,
      message.reply_text && ['sent', 'manual', 'queued'].includes(message.reply_status) ? `${message.reply_status === 'queued' ? '待发回复' : '已回复'}：${message.reply_text}` : null
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
  const { rows: [row] } = await pool.query('SELECT intent_keywords, assignee_property, assignee_event, assignee_hotel, assignee_dining, dm_auto_reply_enabled, dm_auto_reply_text, dm_auto_reply_daily_limit FROM leadgen.inbox_settings WHERE id = 1');
  const { rows: users } = await pool.query(`SELECT u.id, u.display_name FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key WHERE u.is_active AND r.can_write ORDER BY u.display_name`);
  return { ...row, dm_auto_reply_text: row.dm_auto_reply_text || DEFAULT_AUTO_REPLY, dm_auto_reply_available: DM_SENDING_AVAILABLE, users };
}

export async function updateInboxSettings(pool, input, user = null) {
  const keywords = [...new Set((Array.isArray(input.intent_keywords) ? input.intent_keywords : []).map(item => String(item).trim()).filter(Boolean))];
  if (!keywords.length || keywords.length > 300 || keywords.some(keyword => keyword.length > 20)) throw fail(400, 'INBOX_SETTINGS_INVALID', '关键词要 1–300 个，每个不超过 20 字');
  const owner = value => { if (value == null || value === '') return null; if (!UUID.test(String(value))) throw fail(400, 'INBOX_SETTINGS_INVALID', '负责人不正确'); return value; };
  await pool.query(`
    UPDATE leadgen.inbox_settings SET intent_keywords = $1, assignee_property = $2, assignee_event = $3, assignee_hotel = $4, assignee_dining = $5, updated_at = now() WHERE id = 1`,
  [keywords, owner(input.assignee_property), owner(input.assignee_event), owner(input.assignee_hotel), owner(input.assignee_dining)]);
  if (input.dm_auto_reply_enabled !== undefined) {
    // 自动回复的话术和人写的回复守同样的规矩：不出现底价，不超过 300 字。打开它的人就是认可这段话术的人。
    const enabled = input.dm_auto_reply_enabled === true;
    if (enabled && !DM_SENDING_AVAILABLE) throw fail(409, 'DM_AUTO_REPLY_UNAVAILABLE', '自动回复暂时用不了：从电脑后台发的私信对方收不到，私信请在手机上回');
    const text = String(input.dm_auto_reply_text || '').trim();
    const limit = Number(input.dm_auto_reply_daily_limit ?? 30);
    if (enabled && !user) throw fail(400, 'INBOX_SETTINGS_INVALID', '需要登录的管理员来打开自动回复');
    if (!text || text.length > 300) throw fail(400, 'INBOX_SETTINGS_INVALID', '自动回复的话术要 1–300 字');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail(400, 'INBOX_SETTINGS_INVALID', '每天自动回复的上限要在 1–200 之间');
    const { rows } = await pool.query('SELECT floor_price_per_sqm FROM leadgen.leasing_policy WHERE floor_price_per_sqm IS NOT NULL');
    const forbidden = findForbidden(text, rows.map(row => Number(row.floor_price_per_sqm)));
    if (forbidden) throw fail(400, 'REPLY_FORBIDDEN_WORDING', `话术里不能出现${forbidden}`);
    await pool.query(`
      UPDATE leadgen.inbox_settings SET dm_auto_reply_enabled = $1, dm_auto_reply_text = $2, dm_auto_reply_daily_limit = $3,
        dm_auto_reply_enabled_by = CASE WHEN $1 THEN $4::uuid ELSE dm_auto_reply_enabled_by END, updated_at = now() WHERE id = 1`,
    [enabled, text, limit, user?.id ?? null]);
  }
  return getInboxSettings(pool);
}
