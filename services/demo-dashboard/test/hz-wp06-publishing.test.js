import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, buildPrompt, findForbidden, normalizeDraft, writeDraft } from '../src/publishing/copywriter.js';
import { classifyUploads, parseMaterialFields } from '../src/publishing/publishingService.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const material = { topic: '1 栋 13 层写字楼招租', content_type: 'property', note: '南向采光', image_count: 3, video_count: 0 };
const property = { building: '1栋', floor: 13, unit_no: '1307', property_type: 'office', area_sqm: '193.00', list_rent_per_sqm: '30.00', management_fee_per_sqm: '10.00', fit_out: '精装修3隔＋15卡' };

test('the floor price can never appear in a post, as a word or as a figure', () => {
  assert.equal(findForbidden('租金 30 元/㎡·月，管理费 10 元，欢迎咨询', [35]), null);
  assert.equal(findForbidden('面积 135 元起的说法不存在，电话 13500000000', [35]), null);
  assert.equal(findForbidden('底价可谈', [35]), '“底价”一类的说法');
  assert.equal(findForbidden('最低价给到你', []), '“底价”一类的说法');
  assert.equal(findForbidden('最低 35 元都能谈', [35]), '底价数字（35 元）');
  assert.equal(findForbidden('35元/㎡', [35]), '底价数字（35 元）');
  assert.equal(findForbidden('三十五元一平', [35]), '底价数字（35 元）');
  // 商铺自己的挂牌租金是公开报价，不受写字楼底价限制
  assert.equal(findForbidden('租金 35 元/㎡·月', []), null);
});

test('drafts are held to each platform\'s length and topic limits', () => {
  const ok = normalizeDraft('douyin', { title: '黄埔精装写字楼出租', body: '193 平，南向采光。', topics: ['#广州写字楼#', '黄埔', '恒兆广场', '黄埔'] }, [35]);
  assert.deepEqual(ok, { title: '黄埔精装写字楼出租', body: '193 平，南向采光。', topics: ['广州写字楼', '黄埔', '恒兆广场'], problems: [] });

  const long = normalizeDraft('douyin', { title: '标'.repeat(31), body: '文'.repeat(201), topics: ['a'] });
  assert.deepEqual(long.problems, ['标题 31 字，超过 30 字', '正文 201 字，超过 200 字', '话题 1 个，不到 3 个']);
  assert.deepEqual(normalizeDraft('xiaohongshu', { title: '好办公室', body: '太短', topics: ['a', 'b', 'c'] }).problems, ['正文 2 字，不到 300 字']);

  const moments = normalizeDraft('moments', { title: '不该有的标题', body: '恒兆广场写字楼招租，欢迎私信。', topics: ['话题'] });
  assert.deepEqual([moments.title, moments.topics, moments.problems], [null, [], []]);
  assert.deepEqual(normalizeDraft('channels', { title: '好', body: '底价 35 元', topics: ['a', 'b', 'c'] }, [35]).problems, ['出现了“底价”一类的说法']);
  assert.deepEqual(normalizeDraft('douyin', {}).problems, ['没有正文', '没有标题', '话题 0 个，不到 3 个']);
});

test('the writing brief carries only supplied facts and forbids invented ones', () => {
  const [system, user] = buildPrompt({ platform: 'xiaohongshu', material, property, project: { address: '广州市黄埔区长岭街', transport_notes: ['地铁 21 号线长平站 1 公里'] } });
  assert.match(system.content, /小红书/);
  assert.match(system.content, /只用下面给出的事实/);
  assert.match(system.content, /不写任何优惠价、最低价、底价/);
  assert.match(system.content, /商务招商口吻/);
  assert.match(user.content, /关联房源：1栋 13 层 1307，写字楼，193 ㎡/);
  assert.match(user.content, /公开报价：租金 30 元\/㎡·月，管理费 10 元\/㎡·月/);
  assert.doesNotMatch(`${system.content}${user.content}`, /35/);
  assert.match(buildPrompt({ platform: 'moments', material: { ...material, content_type: 'dining' }, property: null, project: null })[0].content, /生活化的种草口吻/);
});

test('a draft that breaks the rules is sent back to the model once with the reasons', async () => {
  const replies = [
    { title: '写字楼', body: '底价 35 元可谈', topics: ['a', 'b', 'c'] },
    { title: '黄埔写字楼出租', body: '193 平精装，欢迎咨询。', topics: ['广州写字楼', '黄埔', '恒兆广场'] }
  ];
  const asked = [];
  const llm = { async chatJson({ messages }) { asked.push(messages.length); return { data: replies.shift(), usage: { inputTokens: 100, outputTokens: 50 } }; } };
  const draft = await writeDraft({ llm, platform: 'douyin', material, property, project: null, floorPrices: [35] });
  assert.deepEqual(asked, [2, 4]);
  assert.deepEqual(draft.problems, []);
  assert.equal(draft.body, '193 平精装，欢迎咨询。');
  assert.deepEqual(draft.usage, { inputTokens: 200, outputTokens: 100 });
});

test('material uploads need a topic, a type, a platform and only images or one video', () => {
  const fields = parseMaterialFields({ topic: ' 招租 ', content_type: 'hotel', target_platforms: ['douyin', 'moments', 'douyin'], property_id: '33333333-3333-4333-8333-333333333333' });
  assert.deepEqual(fields, { topic: '招租', contentType: 'hotel', platforms: ['douyin', 'moments'], note: null, propertyId: null });
  assert.throws(() => parseMaterialFields({ content_type: 'hotel', target_platforms: 'douyin' }), { code: 'MATERIAL_TOPIC_REQUIRED' });
  assert.throws(() => parseMaterialFields({ topic: 'x', content_type: 'news', target_platforms: 'douyin' }), { code: 'MATERIAL_TYPE_INVALID' });
  assert.throws(() => parseMaterialFields({ topic: 'x', content_type: 'hotel' }), { code: 'MATERIAL_PLATFORM_REQUIRED' });
  assert.throws(() => parseMaterialFields({ topic: 'x', content_type: 'hotel', target_platforms: 'weibo' }), { code: 'MATERIAL_PLATFORM_INVALID' });

  const image = { mimetype: 'image/jpeg' };
  const video = { mimetype: 'video/mp4' };
  assert.deepEqual(classifyUploads([image, video]).map(item => [item.kind, item.ext]), [['image', '.jpg'], ['video', '.mp4']]);
  assert.throws(() => classifyUploads([]), { code: 'MATERIAL_FILE_REQUIRED' });
  assert.throws(() => classifyUploads([{ mimetype: 'application/pdf' }]), { code: 'MATERIAL_FILE_TYPE' });
  assert.throws(() => classifyUploads(Array(19).fill(image)), { code: 'MATERIAL_TOO_MANY_IMAGES' });
  assert.throws(() => classifyUploads([video, video]), { code: 'MATERIAL_TOO_MANY_VIDEOS' });
});

test('nothing is queued for publishing without an explicit confirmation by an account that can edit', () => {
  const routes = readFileSync(path.join(appRoot, 'src', 'publishing', 'publishingRoutes.js'), 'utf8');
  for (const route of ["post('/materials'", "post('/materials/:materialId/drafts'", "put('/tasks/:taskId'", "post('/tasks/:taskId/confirm'", "post('/tasks/:taskId/withdraw'"]) {
    assert.ok(routes.includes(`router.${route}, ...write`), route);
  }
  assert.match(routes, /router\.post\('\/accounts', \.\.\.admin/);
  const service = readFileSync(path.join(appRoot, 'src', 'publishing', 'publishingService.js'), 'utf8');
  // The only place a task becomes 'confirmed' is confirmTask.
  assert.equal(service.match(/SET status = 'confirmed'/g).length, 1);
  const migration = readFileSync(path.resolve(appRoot, '..', '..', 'database', 'migrations', '073_hz_publishing.sql'), 'utf8');
  assert.match(migration, /CHECK \(status <> 'confirmed' OR \(scheduled_at IS NOT NULL AND confirmed_by IS NOT NULL AND body IS NOT NULL\)\)/);
  assert.equal(Object.keys(PLATFORMS).length, 4);
});
