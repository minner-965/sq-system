// 用真实数据库和真实的大模型核对“需求发现”：筛选、转线索、合并、不感兴趣、主动联系的上限。事务里跑，结束回滚。
// 用法（在 services/demo-dashboard 下）：npm run check:demand
// 帖子样本是照着真实帖子的说法自己写的，只在这个事务里存在；真实搜索要等搜索专用小号。
import assert from 'node:assert/strict';
import { createHostPool } from '../../src/db/pool.js';
import { createLlmClient } from '../../src/llm/llmClient.js';
import { closeDemand, convertDemand, listDemand, recordContact, screenPending } from '../../src/demand/demandService.js';

const real = createHostPool();
const client = await real.connect();
const inner = {
  query: (sql, params) => {
    const text = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
    if (text === 'BEGIN') return client.query('SAVEPOINT step');
    if (text === 'COMMIT') return client.query('RELEASE SAVEPOINT step');
    if (text === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT step');
    return client.query(sql, params);
  },
  release() {}
};
const pool = { connect: async () => inner, query: (sql, params) => client.query(sql, params) };

const SAMPLES = [
  ['need-office', 'post', 'a1', '科学城附近求租办公室', '公司 12 个人，想在黄埔科学城或者长岭居附近租一间 150 到 200 平的办公室，预算每月 8000 以内，最好精装能直接搬进去，有推荐的吗', 'office_retail'],
  ['need-hotel', 'post', 'a2', '', '下个月去宝能看演唱会，求推荐黄埔那边的酒店，两个人住一晚，离场馆近一点的', 'hotel_apartment'],
  ['need-dining', 'post', 'a3', '黄埔公司年会聚餐', '部门 30 人年底聚餐，想在黄埔长岭居附近找个有大包间的餐厅，人均 150 左右，求推荐', 'dining'],
  ['agency', 'post', 'a4', '黄埔写字楼招租', '黄埔科学城甲级写字楼招租，100-2000 平任选，精装带家私，免佣金，欢迎随时看房，联系王经理', null],
  ['irrelevant', 'post', 'a5', '', '今天去黄埔的商场吃了一家很好吃的牛肉火锅，下次还来', null],
  ['need-office-2', 'comment', 'a1', '', '同问，我们也在找长岭居附近 100 平左右的办公室，楼主找到了吗', 'office_retail']
];

try {
  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`SELECT id FROM leadgen.users WHERE username = 'admin'`);
  const user = { id: admin.id, sectors: ['office_retail', 'hotel_apartment', 'dining'] };
  for (const [key, kind, author, title, content] of SAMPLES) {
    await client.query(`
      INSERT INTO leadgen.demand_posts (platform, kind, platform_item_id, author_key, author_name, title, content, post_url, posted_at, keyword)
      VALUES ('xiaohongshu', $1, $2, $3, $4, NULLIF($5, ''), $6, 'https://www.xiaohongshu.com/explore/selftest', now() - interval '2 days', '黄埔 办公室 求租')`,
    [kind, `selftest-${key}`, `selftest-${author}`, `用*${author}`, title, content]);
  }
  const llm = createLlmClient();
  assert.ok(llm.configured, '要先配置大模型');
  const screened = await screenPending(pool, { llm, limit: 20 });
  const { rows: verdicts } = await client.query(`SELECT platform_item_id, verdict, sector_key, facts, reason FROM leadgen.demand_posts WHERE platform_item_id LIKE 'selftest-%'`);
  const by = Object.fromEntries(verdicts.map(row => [row.platform_item_id.replace('selftest-', ''), row]));
  for (const [key, , , , , sector] of SAMPLES) {
    const row = by[key];
    console.log(`  ${key}: ${row.verdict}${row.sector_key ? ` / ${row.sector_key}` : ''} ${JSON.stringify(row.facts)} —— ${row.reason}`);
    if (sector) { assert.equal(row.verdict, 'need', key); assert.equal(row.sector_key, sector, key); } else assert.notEqual(row.verdict, 'need', key);
  }
  assert.equal(by.agency.verdict, 'agency');
  assert.ok(by['need-office'].facts.area && by['need-office'].facts.budget, '写明了面积和预算的要记下来');
  console.log(`筛选：${screened.screened} 条里 ${screened.needs} 条有需求，中介招租和无关的被排除，面积预算记下来了 ✔`);

  const open = await listDemand(pool, { view: 'open', user });
  assert.equal(open.items.filter(item => item.content.includes('办公室')).length, 2);
  assert.equal((await listDemand(pool, { view: 'open', user: { ...user, sectors: ['dining'] } })).items.length, 1);
  console.log('列表：有需求的进“待处理”；只负责餐饮的同事只看到餐饮那一条 ✔');

  const id = async key => (await client.query(`SELECT id FROM leadgen.demand_posts WHERE platform_item_id = $1`, [`selftest-${key}`])).rows[0].id;
  const first = await convertDemand(pool, { postId: await id('need-office'), user });
  assert.equal(first.merged, false);
  const { rows: [note] } = await client.query(`
    SELECT a.content, c.data_origin FROM leadgen.activities a JOIN leadgen.company_sector_tracks t ON t.id = a.track_id JOIN leadgen.companies c ON c.id = t.company_id WHERE c.id = $1`, [first.company_id]);
  assert.match(note.content, /来源：主动发现 · 小红书帖子/);
  assert.match(note.content, /链接：https:\/\/www\.xiaohongshu\.com/);
  assert.equal(note.data_origin, 'demand_post');
  await assert.rejects(async () => convertDemand(pool, { postId: await id('need-hotel'), user: { ...user, sectors: ['dining'] } }), error => error.code === 'SECTOR_FORBIDDEN');
  console.log('转线索：进了“招商客户”，来源写明主动发现、平台和帖子链接；别的板块的同事不能转 ✔');

  // 同一个人（a1）的另一条：并到原来的档案。
  await client.query(`UPDATE leadgen.demand_posts SET author_key = 'selftest-a1' WHERE platform_item_id = 'selftest-need-office-2'`);
  const second = await convertDemand(pool, { postId: await id('need-office-2'), user });
  assert.equal(second.company_id, first.company_id);
  assert.equal(second.merged, true);
  console.log('同一个人再出现：并到原来的客户档案，不新建 ✔');

  const { rows: [account] } = await client.query(`SELECT id FROM leadgen.publish_accounts WHERE platform = 'xiaohongshu' AND purpose = 'publish' LIMIT 1`);
  const { rows: [other] } = await client.query(`SELECT id FROM leadgen.publish_accounts WHERE platform = 'douyin' AND purpose = 'publish' LIMIT 1`);
  await assert.rejects(async () => recordContact(pool, { postId: await id('need-hotel'), text: '我们这边底价可以谈', accountId: account.id, user }), error => error.code === 'CONTACT_FORBIDDEN_WORDING');
  await assert.rejects(async () => recordContact(pool, { postId: await id('need-hotel'), text: '恒兆广场有宜尚酒店，可以了解一下', accountId: other.id, user }), error => error.code === 'CONTACT_ACCOUNT_PLATFORM');
  await recordContact(pool, { postId: await id('need-hotel'), text: '恒兆广场有宜尚酒店，离宝能约 4 公里，可以了解一下', accountId: account.id, user });
  await assert.rejects(async () => recordContact(pool, { postId: await id('need-hotel'), text: '再说一次', accountId: account.id, user }), error => error.code === 'CONTACT_ALREADY');
  // 同一个人的另一条帖子：不重复联系。
  await client.query(`INSERT INTO leadgen.demand_posts (platform, kind, platform_item_id, author_key, content, verdict, sector_key) VALUES ('xiaohongshu', 'post', 'selftest-again', 'selftest-a2', '还是想找酒店', 'need', 'hotel_apartment')`);
  await assert.rejects(async () => recordContact(pool, { postId: await id('again'), text: '您好', accountId: account.id, user }), error => error.code === 'CONTACT_REPEAT');
  // 每天上限：把今天的联系数补到上限，再联系一个新的人应该被拦住。
  await client.query(`
    INSERT INTO leadgen.demand_posts (platform, kind, platform_item_id, author_key, content, verdict, sector_key, contact_text, contact_account_id, contacted_at)
    SELECT 'xiaohongshu', 'post', 'selftest-limit-' || n, 'selftest-l' || n, '占位', 'need', 'dining', '占位', $1, now() FROM generate_series(1, 9) n`, [account.id]);
  await assert.rejects(async () => recordContact(pool, { postId: await id('need-dining'), text: '恒兆广场有带包间的餐厅，可以了解一下', accountId: account.id, user }), error => error.code === 'CONTACT_DAILY_LIMIT');
  console.log('主动联系：不能带底价的说法；账号要和帖子同一个平台；同一个人不重复联系；一个账号一天满 10 人就拦住 ✔');

  const closed = await closeDemand(pool, { postId: await id('need-dining'), reason: 'not_interested', user });
  assert.equal(closed.status, 'not_interested');
  await client.query(`INSERT INTO leadgen.demand_posts (platform, kind, platform_item_id, author_key, content) VALUES ('xiaohongshu', 'post', 'selftest-later', 'selftest-a3', '又来问一次，黄埔哪里有大包间的餐厅')`);
  await screenPending(pool, { llm, limit: 5 });
  const { rows: [later] } = await client.query(`SELECT verdict, status FROM leadgen.demand_posts WHERE platform_item_id = 'selftest-later'`);
  assert.equal(later.status, 'not_interested');
  assert.equal((await listDemand(pool, { view: 'open', user })).items.some(item => item.content.includes('又来问一次')), false);
  console.log('对方不感兴趣：这个人后来再发的帖子不再进列表 ✔');
} finally {
  await client.query('ROLLBACK');
  client.release();
  const { rows: [left] } = await real.query(`SELECT (SELECT count(*)::int FROM leadgen.demand_posts WHERE platform_item_id LIKE 'selftest-%') AS posts, (SELECT count(*)::int FROM leadgen.companies WHERE data_origin = 'demand_post') AS companies`);
  console.log('回滚后残留：', left);
  await real.end();
}
