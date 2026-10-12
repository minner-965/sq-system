// 主动发现需求：搜索程序把公开帖子和评论写进 demand_posts；这里负责筛选、列出来、转线索、记主动联系。
// 筛选由模型做（是不是真有需求、属于哪个板块、能看出的面积预算），模型不可用时留着不筛，不乱猜。
import { findForbidden } from '../publishing/copywriter.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLATFORM_NAME = { xiaohongshu: '小红书', douyin: '抖音' };
const KIND_NAME = { post: '帖子', comment: '评论' };
const SECTOR_NAME = { office_retail: '商铺写字楼', hotel_apartment: '酒店公寓', dining: '餐饮' };
const VERDICT_NAME = { pending: '还没筛', need: '有需求', agency: '中介或同行', irrelevant: '无关' };
const STATUS_NAME = { new: '待处理', converted: '已转线索', dismissed: '不合适', not_interested: '对方不感兴趣' };
const FACT_KEYS = ['area', 'budget', 'region', 'industry'];

const SCREEN_PROMPT = `你在帮广州黄埔区恒兆广场的招商团队筛选公开帖子。恒兆广场有三块业务：
- office_retail：写字楼和商铺出租
- hotel_apartment：酒店（宜尚酒店）住宿、会议室，公寓长租
- dining：自营餐厅（团餐、宴请、包间）

判断这条帖子或评论的作者是不是“自己正在找”上面某一种场地或服务的人。

verdict 只能是：
- need：作者自己在找铺位、写字楼、办公室、准备开店选址；或在找酒店长住、公寓、会场；或在找聚餐、团建、宴请的餐厅
- agency：中介、房东、同行在招租、推销房源、招商，或者是广告
- irrelevant：其他（闲聊、探店分享、求职、已经租到、和广州黄埔一带明显无关的城市）

只根据文字里写明的内容判断，不要猜。拿不准是不是在找，就判 irrelevant。
sector 在 verdict 是 need 时填上面三个之一，否则填 null。
facts 里只填文字里明确写了的：area（面积）、budget（预算或租金）、region（想要的区域）、industry（行业或用途），没写的不要出现。
reason 用一句不超过 40 个字的中文说明依据，要引用原文里的词。

只输出 JSON：{"verdict":"…","sector":"…或null","facts":{},"reason":"…"}`;

const llmCost = (usage, env) => (usage.inputTokens * Number(env.LLM_PRICE_INPUT_PER_M || 2) + usage.outputTokens * Number(env.LLM_PRICE_OUTPUT_PER_M || 8)) / 1_000_000;

/** Cleans up whatever the model returned into the four fields we store. Anything outside the allowed values becomes "irrelevant". */
export function normalizeScreening(data) {
  const verdict = ['need', 'agency', 'irrelevant'].includes(data?.verdict) ? data.verdict : 'irrelevant';
  const sector = verdict === 'need' && SECTOR_NAME[data?.sector] ? data.sector : null;
  const facts = {};
  for (const key of FACT_KEYS) {
    const raw = data?.facts?.[key];
    const value = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim().slice(0, 60) : '';
    if (value) facts[key] = value;
  }
  // 说有需求却说不出是哪一块的，不进列表。
  return { verdict: verdict === 'need' && !sector ? 'irrelevant' : verdict, sector, facts, reason: String(data?.reason || '').trim().slice(0, 80) || '模型没有给出依据' };
}

/** Screens posts that have not been looked at yet. Run by the worker every minute; does nothing when the model is not configured. */
export async function screenPending(pool, { llm, env = process.env, limit = 20 }) {
  if (!llm.configured) return { screened: 0, needs: 0 };
  const { rows: pending } = await pool.query(`
    SELECT d.id, d.platform, d.kind, d.title, d.content, d.parent_title, d.keyword, d.author_key FROM leadgen.demand_posts d
    WHERE d.verdict = 'pending' ORDER BY d.created_at LIMIT $1`, [limit]);
  let screened = 0;
  let needs = 0;
  for (const post of pending) {
    // 对方表示过不感兴趣的人，后面的帖子直接不看。
    if (post.author_key) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM leadgen.demand_posts WHERE platform = $1 AND author_key = $2 AND status = 'not_interested' LIMIT 1`, [post.platform, post.author_key]);
      if (rowCount) {
        await pool.query(`UPDATE leadgen.demand_posts SET verdict = 'irrelevant', status = 'not_interested', reason = '这个人之前表示过不感兴趣', screened_at = now() WHERE id = $1`, [post.id]);
        continue;
      }
    }
    const started = Date.now();
    let result;
    try {
      const { data, usage } = await llm.chatJson({
        messages: [
          { role: 'system', content: SCREEN_PROMPT },
          { role: 'user', content: [`平台：${PLATFORM_NAME[post.platform]}${KIND_NAME[post.kind]}`, post.kind === 'comment' && post.parent_title ? `所在帖子：${post.parent_title}` : null,
            post.title ? `标题：${post.title}` : null, `内容：${String(post.content).slice(0, 800)}`].filter(Boolean).join('\n') }
        ],
        maxTokens: 200, temperature: 0
      });
      result = normalizeScreening(data);
      await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, cost_cny, duration_ms) VALUES ($1, 'chat/completions', '需求帖筛选', 'ok', $2, $3)`,
        [llm.provider, llmCost(usage, env), Date.now() - started]);
    } catch (error) {
      await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, error_code, duration_ms) VALUES ($1, 'chat/completions', '需求帖筛选', 'error', $2, $3)`,
        [llm.provider, error.code || error.name, Date.now() - started]);
      break;
    }
    await pool.query(`UPDATE leadgen.demand_posts SET verdict = $2, sector_key = $3, facts = $4, reason = $5, screened_at = now() WHERE id = $1 AND verdict = 'pending'`,
      [post.id, result.verdict, result.sector, JSON.stringify(result.facts), result.reason]);
    screened += 1;
    if (result.verdict === 'need') needs += 1;
  }
  if (needs) {
    await pool.query(`INSERT INTO leadgen.notifications (recipient_role, kind, title, body, link) VALUES ('admin', 'publishing', '发现了新的需求帖', $1, '/demand.html')`,
      [`刚筛出 ${needs} 条在找场地或服务的帖子，到“需求发现”里看。`]);
  }
  return { screened, needs };
}

const present = row => ({
  ...row, platform_name: PLATFORM_NAME[row.platform], kind_name: KIND_NAME[row.kind], sector_name: SECTOR_NAME[row.sector_key] || null,
  verdict_name: VERDICT_NAME[row.verdict], status_name: STATUS_NAME[row.status]
});

export async function listDemand(pool, { view = 'open', user, limit = 50, offset = 0 }) {
  const where = {
    open: `d.verdict = 'need' AND d.status = 'new'`,
    converted: `d.status = 'converted'`,
    closed: `d.status IN ('dismissed', 'not_interested')`,
    filtered: `d.verdict IN ('agency', 'irrelevant') AND d.status = 'new'`
  }[view];
  if (!where) throw fail(400, 'DEMAND_VIEW_INVALID', '列表类型不正确');
  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const [{ rows }, { rows: [counts] }, { rows: [settings] }, { rows: accounts }, { rows: senders }] = await Promise.all([
    pool.query(`
      SELECT d.id, d.platform, d.kind, d.title, d.content, d.parent_title, d.author_name, d.post_url, d.posted_at, d.keyword, d.verdict, d.sector_key, d.facts, d.reason,
             d.status, d.company_id, d.contact_draft, d.contact_text, d.contacted_at, c.display_name AS contacted_by_name, d.created_at
      FROM leadgen.demand_posts d LEFT JOIN leadgen.users c ON c.id = d.contacted_by
      WHERE ${where} AND (d.sector_key IS NULL OR d.sector_key = ANY($1))
      ORDER BY d.posted_at DESC NULLS LAST, d.created_at DESC LIMIT $2 OFFSET $3`, [user.sectors, size, Math.max(Number(offset) || 0, 0)]),
    pool.query(`
      SELECT count(*) FILTER (WHERE verdict = 'need' AND status = 'new')::int AS open,
             count(*) FILTER (WHERE status = 'converted')::int AS converted,
             count(*) FILTER (WHERE status IN ('dismissed', 'not_interested'))::int AS closed,
             count(*) FILTER (WHERE verdict IN ('agency', 'irrelevant') AND status = 'new')::int AS filtered,
             count(*) FILTER (WHERE verdict = 'pending')::int AS pending
      FROM leadgen.demand_posts`),
    pool.query('SELECT enabled, last_run_at, last_run_note, next_run_at FROM leadgen.demand_settings WHERE id = 1'),
    pool.query(`SELECT platform, account_name, login_status FROM leadgen.publish_accounts WHERE purpose = 'search' ORDER BY platform`),
    pool.query(`SELECT id, platform, account_name FROM leadgen.publish_accounts WHERE purpose = 'publish' AND platform IN ('xiaohongshu', 'douyin') ORDER BY platform, created_at`)
  ]);
  return {
    counts, items: rows.map(present),
    contact_accounts: senders.map(account => ({ ...account, platform_name: PLATFORM_NAME[account.platform] })),
    search: {
      ...settings, accounts: accounts.map(account => ({ ...account, platform_name: PLATFORM_NAME[account.platform] || account.platform })),
      ready: accounts.some(account => account.login_status === 'ok')
    }
  };
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

async function lockPost(client, postId) {
  if (!UUID.test(String(postId))) throw fail(404, 'DEMAND_NOT_FOUND', '没有找到这条帖子');
  const { rows: [post] } = await client.query('SELECT * FROM leadgen.demand_posts WHERE id = $1 FOR UPDATE', [postId]);
  if (!post) throw fail(404, 'DEMAND_NOT_FOUND', '没有找到这条帖子');
  return post;
}

/**
 * Turns a post into a lead. One company record per author on a platform, so a second post from the same
 * person lands on the same record; the source note carries platform, link and the original words.
 */
export function convertDemand(pool, { postId, sector = null, user }) {
  return inTransaction(pool, async client => {
    const post = await lockPost(client, postId);
    if (post.status === 'converted') return { company_id: post.company_id, merged: true };
    if (post.status !== 'new') throw fail(409, 'DEMAND_CLOSED', '这条已经处理过了');
    const sectorKey = SECTOR_NAME[sector] ? sector : post.sector_key;
    if (!sectorKey) throw fail(400, 'DEMAND_SECTOR_REQUIRED', '请先选这条线索属于哪个板块');
    if (!user.sectors.includes(sectorKey)) throw fail(403, 'SECTOR_FORBIDDEN', '这条线索属于别的板块，请让负责该板块的同事来转');
    const source = `demand_${post.platform}`;
    const authorKey = post.author_key || `item:${post.platform_item_id}`;
    const { rows: [existing] } = await client.query('SELECT id FROM leadgen.companies WHERE source = $1 AND source_ref = $2', [source, authorKey]);
    const companyId = existing?.id ?? (await client.query(`
      INSERT INTO leadgen.companies (company_name, source, source_ref, website_url, data_origin, qualification_status, company_description)
      VALUES ($1, $2, $3, $4, 'demand_post', 'qualified', '在公开帖子里说自己在找场地或服务的人') RETURNING id`,
    [`${PLATFORM_NAME[post.platform]}用户 ${post.author_name || '（昵称未显示）'}`, source, authorKey, post.post_url])).rows[0].id;
    const { rows: [track] } = await client.query(`
      INSERT INTO leadgen.company_sector_tracks (company_id, sector_key, stage, owner_user_id, contact_name)
      VALUES ($1, $2, 'new', $3, $4) ON CONFLICT (company_id, sector_key) DO UPDATE SET updated_at = now() RETURNING id, (xmax = 0) AS inserted`,
    [companyId, sectorKey, user.id, post.author_name]);
    const facts = post.facts || {};
    const note = [
      `来源：主动发现 · ${PLATFORM_NAME[post.platform]}${KIND_NAME[post.kind]}`,
      post.post_url ? `链接：${post.post_url}` : null,
      post.kind === 'comment' && post.parent_title ? `所在帖子：《${post.parent_title}》` : null,
      post.title ? `标题：${post.title}` : null,
      `原话：${String(post.content).slice(0, 600)}`,
      post.reason ? `判断依据：${post.reason}` : null,
      facts.area ? `面积：${facts.area}` : null, facts.budget ? `预算：${facts.budget}` : null,
      facts.region ? `区域：${facts.region}` : null, facts.industry ? `行业或用途：${facts.industry}` : null,
      post.contact_text ? `已联系：${post.contact_text}` : null
    ].filter(Boolean).join('\n');
    await client.query(`INSERT INTO leadgen.activities (track_id, activity_type, content, occurred_at, created_by) VALUES ($1, 'note', $2, COALESCE($3, now()), $4)`,
      [track.id, note, post.posted_at, user.id]);
    await client.query(`UPDATE leadgen.demand_posts SET status = 'converted', company_id = $2, sector_key = $3, handled_by = $4, handled_at = now() WHERE id = $1`,
      [postId, companyId, sectorKey, user.id]);
    return { company_id: companyId, merged: Boolean(existing) || !track.inserted };
  });
}

/** "不合适" closes this one post. "对方不感兴趣" also keeps this person's other and later posts out of the list. */
export function closeDemand(pool, { postId, reason, user }) {
  if (!['dismissed', 'not_interested'].includes(reason)) throw fail(400, 'DEMAND_REASON_INVALID', '处理方式不正确');
  return inTransaction(pool, async client => {
    const post = await lockPost(client, postId);
    if (post.status !== 'new') throw fail(409, 'DEMAND_CLOSED', '这条已经处理过了');
    await client.query(`UPDATE leadgen.demand_posts SET status = $2, handled_by = $3, handled_at = now() WHERE id = $1`, [postId, reason, user.id]);
    let also = 0;
    if (reason === 'not_interested' && post.author_key) {
      also = (await client.query(`
        UPDATE leadgen.demand_posts SET status = 'not_interested', handled_by = $3, handled_at = now()
        WHERE platform = $1 AND author_key = $2 AND status = 'new' AND id <> $4`, [post.platform, post.author_key, user.id, postId])).rowCount;
    }
    return { status: reason, also_closed: also };
  });
}

const CONTACT_PROMPT = `你是广州黄埔区恒兆广场招商部的工作人员，要在别人公开发的帖子下留一条评论。对方在找场地或服务。
要求：不超过 60 个字；先回应对方提到的具体需求，再说恒兆广场在黄埔长岭街有相应的场地或服务，可以了解一下；语气像真人、客气、不推销；
不要报价格，不要留电话和微信，不要用感叹号，不要用“亲”“宝子”这类称呼。只输出这条评论本身。`;

/** Drafts the comment a person will post themselves. Nothing is sent by the system. */
export async function draftContact(pool, { postId, llm, env = process.env }) {
  if (!UUID.test(String(postId))) throw fail(404, 'DEMAND_NOT_FOUND', '没有找到这条帖子');
  if (!llm.configured) throw fail(409, 'LLM_KEY_MISSING', '还没有配置大模型，暂时不能起草，可以先手写');
  const { rows: [post] } = await pool.query('SELECT id, platform, kind, title, content, sector_key FROM leadgen.demand_posts WHERE id = $1', [postId]);
  if (!post) throw fail(404, 'DEMAND_NOT_FOUND', '没有找到这条帖子');
  const started = Date.now();
  let reply;
  try {
    reply = await llm.chat({
      messages: [{ role: 'system', content: CONTACT_PROMPT },
        { role: 'user', content: `对方的需求属于：${SECTOR_NAME[post.sector_key] || '未定'}\n${post.title ? `标题：${post.title}\n` : ''}对方的原话：${String(post.content).slice(0, 500)}` }],
      maxTokens: 160, temperature: 0.4
    });
  } catch (error) {
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, error_code, duration_ms) VALUES ($1, 'chat/completions', '主动联系起草', 'error', $2, $3)`,
      [llm.provider, error.code || error.name, Date.now() - started]);
    throw fail(502, 'LLM_FAILED', `大模型服务不可用：${error.message}`);
  }
  await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, cost_cny, duration_ms) VALUES ($1, 'chat/completions', '主动联系起草', 'ok', $2, $3)`,
    [llm.provider, llmCost(reply.usage, env), Date.now() - started]);
  const draft = String(reply.text || '').trim().replace(/^["“]|["”]$/g, '').slice(0, 200);
  await pool.query('UPDATE leadgen.demand_posts SET contact_draft = $2 WHERE id = $1', [postId, draft]);
  return { draft };
}

/**
 * Records that a person has contacted the author (they post the comment themselves on their phone).
 * Refused when this author was already contacted, or when the chosen account has reached its daily limit.
 */
export function recordContact(pool, { postId, text, accountId, user }) {
  const words = String(text || '').trim();
  if (!words) throw fail(400, 'CONTACT_TEXT_REQUIRED', '请填写实际发出去的话');
  if (words.length > 300) throw fail(400, 'CONTACT_TEXT_TOO_LONG', '太长了，最多 300 字');
  if (!UUID.test(String(accountId))) throw fail(400, 'CONTACT_ACCOUNT_REQUIRED', '请选是用哪个账号联系的');
  return inTransaction(pool, async client => {
    const post = await lockPost(client, postId);
    if (post.contacted_at) throw fail(409, 'CONTACT_ALREADY', '这条已经联系过了');
    const { rows: floors } = await client.query('SELECT floor_price_per_sqm FROM leadgen.leasing_policy WHERE floor_price_per_sqm IS NOT NULL');
    const forbidden = findForbidden(words, floors.map(row => Number(row.floor_price_per_sqm)));
    if (forbidden) throw fail(400, 'CONTACT_FORBIDDEN_WORDING', `这句话里不能出现${forbidden.startsWith('底价数字') ? '内部价格' : forbidden}`);
    const { rows: [account] } = await client.query(`SELECT id, platform, account_name FROM leadgen.publish_accounts WHERE id = $1 AND purpose = 'publish'`, [accountId]);
    if (!account) throw fail(400, 'CONTACT_ACCOUNT_REQUIRED', '请选是用哪个账号联系的');
    if (account.platform !== post.platform) throw fail(400, 'CONTACT_ACCOUNT_PLATFORM', `这条在${PLATFORM_NAME[post.platform]}上，要选${PLATFORM_NAME[post.platform]}的账号`);
    if (post.author_key) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM leadgen.demand_posts WHERE platform = $1 AND author_key = $2 AND contacted_at IS NOT NULL AND id <> $3 LIMIT 1`, [post.platform, post.author_key, postId]);
      if (rowCount) throw fail(409, 'CONTACT_REPEAT', '这个人之前已经联系过了，不重复联系');
    }
    const { rows: [limits] } = await client.query(`
      SELECT s.contact_daily_limit AS max, (SELECT count(*)::int FROM leadgen.demand_posts d WHERE d.contact_account_id = $1 AND d.contacted_at >= date_trunc('day', now())) AS used
      FROM leadgen.demand_settings s WHERE s.id = 1`, [accountId]);
    if (limits.used >= limits.max) throw fail(409, 'CONTACT_DAILY_LIMIT', `“${account.account_name}”今天已经主动联系了 ${limits.used} 人，到上限了，明天再联系`);
    await client.query(`UPDATE leadgen.demand_posts SET contact_text = $2, contact_account_id = $3, contacted_by = $4, contacted_at = now() WHERE id = $1`, [postId, words, accountId, user.id]);
    return { contacted: true, used_today: limits.used + 1, daily_limit: limits.max };
  });
}

export async function getDemandSettings(pool) {
  const { rows: [settings] } = await pool.query(`
    SELECT enabled, keywords, platforms, runs_per_day, posts_per_keyword, max_age_days, contact_daily_limit, last_run_at, last_run_note, next_run_at FROM leadgen.demand_settings WHERE id = 1`);
  return settings;
}

export async function updateDemandSettings(pool, input, user) {
  const list = Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(/[\n,，]+/);
  const keywords = [...new Set(list.map(word => String(word).trim().replace(/\s+/g, ' ')).filter(Boolean))];
  if (!keywords.length) throw fail(400, 'DEMAND_KEYWORDS_REQUIRED', '至少留一个关键词');
  if (keywords.length > 30) throw fail(400, 'DEMAND_KEYWORDS_TOO_MANY', '关键词最多 30 个，太多了每天搜不完');
  if (keywords.some(word => word.length > 30)) throw fail(400, 'DEMAND_KEYWORD_TOO_LONG', '单个关键词不要超过 30 个字');
  const { rows: [saved] } = await pool.query(`
    UPDATE leadgen.demand_settings SET keywords = $1, enabled = $2, updated_by = $3, updated_at = now() WHERE id = 1 RETURNING enabled, keywords`,
  [keywords, input.enabled !== false, user.id]);
  return saved;
}

/** Asks the search program to run as soon as it next looks (within a minute or so). */
export async function requestSearch(pool) {
  const { rows: [ready] } = await pool.query(`SELECT 1 FROM leadgen.publish_accounts WHERE purpose = 'search' AND login_status = 'ok' LIMIT 1`);
  if (!ready) throw fail(409, 'DEMAND_NO_SEARCH_ACCOUNT', '还没有登录好的搜索专用账号，请先在“发布账号”里添加搜索专用的小号并扫码登录');
  await pool.query('UPDATE leadgen.demand_settings SET next_run_at = now() WHERE id = 1');
  return { queued: true };
}
