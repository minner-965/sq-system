import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTENTS, LEAD_INTENTS, acceptKeyword, classifyByKeywords, classifyMessage, matchedKeywords } from '../src/inbox/inboxService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYWORDS = ['多少钱', '租', '订房', '看看', '办公室'];
const comment = content => ({ platform: 'douyin', kind: 'comment', post_title: '写字楼招租', content });
const model = reply => {
  const calls = [];
  return { calls, configured: true, async chatJson(request) { calls.push(request); return { data: reply, usage: { inputTokens: 80, outputTokens: 20 } }; } };
};

test('four intents raise a reminder; ordinary interaction and spam do not', () => {
  assert.deepEqual(LEAD_INTENTS, ['inquiry', 'viewing', 'cooperation', 'booking']);
  assert.deepEqual(Object.keys(INTENTS).filter(key => !INTENTS[key].lead), ['chat', 'spam']);
  assert.deepEqual(matchedKeywords('这个多少钱，怎么租', KEYWORDS), ['多少钱', '租']);
});

test('with a model configured every message is judged by it, keyword or not', async () => {
  // “带家具不”没有任何关键词，自测里这类说法被关键词初筛漏掉了一半。
  const llm = model({ intent: 'inquiry', reason: '问是否带家具' });
  const result = await classifyMessage({ message: comment('带家具不'), keywords: KEYWORDS, llm });
  assert.deepEqual([result.intent, result.source, llm.calls.length], ['inquiry', 'model', 1]);
});

test('the audit only learns a keyword that really occurs in the comment and is worth filtering on', () => {
  const existing = ['多少钱'];
  assert.equal(acceptKeyword('带看', '明天下午方便带看不', existing), '带看');
  assert.equal(acceptKeyword('看房', '明天下午方便带看不', existing), null);
  assert.equal(acceptKeyword('多少钱', '多少钱一个月', existing), null);
  assert.equal(acceptKeyword('不', '带家具不', existing), null);
  assert.equal(acceptKeyword('可以', '可以注册公司不', existing), null);
  assert.equal(acceptKeyword('我们十来个人想搬过来', '我们十来个人想搬过来', existing), null);
});

test('the model reads the post title and its verdict is kept only when it is a known intent', async () => {
  const llm = model({ intent: 'viewing', reason: '想周六过去看办公室' });
  const viewing = await classifyMessage({ message: comment('周六可以过去看看吗，想找个 80 平的办公室'), keywords: KEYWORDS, llm });
  assert.deepEqual([viewing.intent, viewing.source, viewing.reason], ['viewing', 'model', '想周六过去看办公室']);
  assert.match(llm.calls[0].messages[1].content, /所在帖子：写字楼招租/);

  const spam = model({ intent: 'spam', reason: '引流广告' });
  const direct = await classifyMessage({ message: { platform: 'douyin', kind: 'direct_message', content: '加V领福利' }, keywords: KEYWORDS, llm: spam });
  assert.deepEqual([direct.intent, spam.calls.length], ['spam', 1]);

  const odd = await classifyMessage({ message: comment('怎么租'), keywords: KEYWORDS, llm: model({ intent: 'purchase' }) });
  assert.deepEqual([odd.intent, odd.reason], ['chat', '模型没有给出依据']);
});

test('without a model, keywords decide: a hit is an enquiry, no hit is ordinary interaction', async () => {
  const hit = await classifyMessage({ message: comment('多少钱一个月'), keywords: KEYWORDS, llm: { configured: false } });
  assert.deepEqual([hit.intent, hit.source], ['inquiry', 'keyword']);
  assert.match(hit.reason, /出现关键词：多少钱（还没有配置大模型，只按关键词判断）/);
  const miss = classifyByKeywords(comment('拍得不错'), KEYWORDS, '大模型暂时不可用');
  assert.deepEqual([miss.intent, miss.source], ['chat', 'keyword']);
});

test('replies are queued only by a person confirming or by the fixed reply to stranger messages, and never mention the floor price', () => {
  const service = readFileSync(path.join(appRoot, 'src', 'inbox', 'inboxService.js'), 'utf8');
  // A reply becomes 'queued' in exactly one place, confirmReply, which records who confirmed it.
  assert.equal(service.match(/: 'queued';/g).length, 1);
  // The one exception (CLAUDE.md section 3, confirmed 2026-10-11): the fixed reply to a stranger's direct message.
  assert.equal(service.match(/reply_status = 'queued'/g).length, 1);
  assert.ok(service.indexOf("reply_status = 'queued'") > service.indexOf('async function queueAutoReply')
    && service.indexOf("reply_status = 'queued'") < service.indexOf('* Classifies every message that has no intent yet'));
  assert.doesNotMatch(service, /reply_status = 'sent'/);
  assert.match(service, /export async function updateInboxSettings[\s\S]+findForbidden\(text/);
  assert.match(service, /export function confirmReply[\s\S]+findForbidden\(reply[\s\S]+reply_confirmed_by = \$4/);
  assert.match(service, /export async function draftReply[\s\S]+findForbidden\(reply, floorPrices\)/);
  const migration = readFileSync(path.resolve(appRoot, '..', '..', 'database', 'migrations', '074_hz_interaction_inbox.sql'), 'utf8');
  assert.match(migration, /CHECK \(reply_status NOT IN \('queued', 'sent'\) OR \(reply_text IS NOT NULL AND reply_confirmed_by IS NOT NULL\)\)/);
  assert.match(migration, /UNIQUE \(platform, platform_message_id\)/);
  const routes = readFileSync(path.join(appRoot, 'src', 'inbox', 'inboxRoutes.js'), 'utf8');
  for (const route of ["post('/messages'", "put('/messages/:messageId/intent'", "post('/messages/:messageId/reply'", "post('/messages/:messageId/lead'"]) {
    assert.ok(routes.includes(`router.${route}, ...write`), route);
  }
});

test('a phone number or WeChat id the sender left is picked out of the message', async () => {
  const { extractContact } = await import('../src/inbox/inboxService.js');
  assert.deepEqual(extractContact('1307还在吗 电话13812345678'), { phone: '13812345678', wechat: null, qq: null, email: null });
  assert.equal(extractContact('打我 138 1234 5678 或 138-1234-5678').phone, '13812345678');
  assert.equal(extractContact('订单号 2026101112345678901').phone, null);
  assert.equal(extractContact('加我微信：hz_office2026').wechat, 'hz_office2026');
  assert.equal(extractContact('qq 123456789').qq, '123456789');
  assert.equal(extractContact('发我邮箱 zhang.san@example.com 谢谢').email, 'zhang.san@example.com');
  assert.deepEqual(extractContact('多少钱一平'), { phone: null, wechat: null, qq: null, email: null });
});

test('the automatic reply is limited to stranger messages read by the system, once per person, within a daily limit', () => {
  const service = readFileSync(path.join(appRoot, 'src', 'inbox', 'inboxService.js'), 'utf8');
  const rule = service.slice(service.indexOf('async function queueAutoReply'), service.indexOf('* Classifies every message that has no intent yet'));
  assert.match(rule, /message\.kind !== 'direct_message' \|\| message\.source !== 'reader'/);
  assert.match(rule, /message\.intent === 'spam'/);
  assert.match(rule, /contact\.phone \|\| contact\.wechat \|\| contact\.qq \|\| contact\.email/);
  assert.match(rule, /s\.dm_auto_reply_enabled AND i\.reply_status = 'none'/);
  assert.match(rule, /earlier\.sender_platform_id = i\.sender_platform_id/);
  assert.match(rule, /< s\.dm_auto_reply_daily_limit/);
  // Comments are never answered automatically: the only caller passes through this guard.
  assert.equal(service.split('queueAutoReply(').length - 1, 2);
});
