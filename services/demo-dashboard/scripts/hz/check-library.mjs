// 用真实数据库核对素材库：挑选规则、用选中的文件开发布素材、停用的不会被挑、视频号必须有视频。事务里跑，结束回滚。
// 复制进发布素材目录的文件在回滚后删掉。
// 用法（在 services/demo-dashboard 下）：npm run check:library
import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostPool } from '../../src/db/pool.js';
import { createMaterialFromLibrary, listLibrary, pickFromLibrary, updateLibraryFile } from '../../src/publishing/libraryService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const mediaDir = process.env.HZ_MEDIA_DIR || path.join(projectRoot, 'data', 'media');
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
const created = [];
try {
  await client.query('BEGIN');
  const { rows: [admin] } = await client.query(`SELECT id FROM leadgen.users WHERE username = 'admin'`);
  const user = { id: admin.id };
  const library = await listLibrary(pool, { contentType: 'hotel' });
  const hotel = library.counts.find(type => type.key === 'hotel');
  assert.ok(hotel.images >= 6 && hotel.videos >= 2, '素材库里要有酒店的图片和视频');
  console.log(`素材库：酒店图片 ${hotel.images} 张、视频 ${hotel.videos} 个 ✔`);

  // 人挑：3 张图，发小红书和抖音。
  const images = library.items.filter(item => item.kind === 'image').slice(0, 3).map(item => item.id);
  const manual = await createMaterialFromLibrary(pool, { user, mediaDir, body: { topic: '自测：酒店图文', content_type: 'hotel', target_platforms: ['xiaohongshu', 'douyin'], file_ids: images } });
  created.push(manual.id);
  const { rows: files } = await client.query('SELECT library_file_id, file_path, sort_order FROM leadgen.material_files WHERE material_id = $1 ORDER BY sort_order', [manual.id]);
  assert.deepEqual(files.map(file => file.library_file_id), images);
  for (const file of files) assert.ok((await stat(path.join(mediaDir, file.file_path))).size > 0);
  const { rows: tasks } = await client.query('SELECT platform, status FROM leadgen.publish_tasks WHERE material_id = $1 ORDER BY platform', [manual.id]);
  assert.deepEqual(tasks.map(task => `${task.platform}:${task.status}`), ['douyin:draft', 'xiaohongshu:draft']);
  const { rows: [used] } = await client.query('SELECT count(*)::int AS n FROM leadgen.library_files WHERE id = ANY($1) AND use_count >= 1', [images]);
  assert.equal(used.n, 3);
  console.log('人挑：3 张图按选的顺序进了新的发布内容，文件在，两个平台各一条待确认的草稿，用过的次数记上了 ✔');

  await assert.rejects(async () => createMaterialFromLibrary(pool, { user, mediaDir, body: { topic: '自测', content_type: 'hotel', target_platforms: ['channels'], file_ids: images } }),
    error => error.code === 'MATERIAL_VIDEO_REQUIRED');
  console.log('只选了图片却要发视频号：拦住，提示视频号只能发视频 ✔');

  // 系统挑：先挑最久没用过的视频。
  const auto = await createMaterialFromLibrary(pool, { user, mediaDir, body: { topic: '自测：酒店视频', content_type: 'hotel', target_platforms: ['douyin', 'channels'] } });
  created.push(auto.id);
  assert.equal(auto.picked, true);
  const { rows: [autoFile] } = await client.query('SELECT library_file_id FROM leadgen.material_files WHERE material_id = $1', [auto.id]);
  // 库里的视频都还没用过，挑中的这个用过次数应该从 0 变成 1（同样没用过的几个之间随机挑）。
  const { rows: [pickedVideo] } = await client.query('SELECT kind, use_count FROM leadgen.library_files WHERE id = $1', [autoFile.library_file_id]);
  assert.equal(pickedVideo.kind, 'video');
  assert.equal(pickedVideo.use_count, 1);
  const next = await pickFromLibrary(client, { contentType: 'hotel', wantVideo: true });
  assert.notEqual(next[0], autoFile.library_file_id, '刚用过的视频不应该马上又被挑中');
  console.log('系统挑：挑了一个还没用过的视频；下一次不会马上又挑同一个 ✔');

  // 停用的不会被挑。
  await updateLibraryFile(pool, { fileId: next[0], input: { archived: true } });
  const afterArchive = await pickFromLibrary(client, { contentType: 'hotel', wantVideo: true });
  assert.ok(!afterArchive.includes(next[0]));
  console.log('停用的文件不会再被挑中 ✔');

  await assert.rejects(async () => createMaterialFromLibrary(pool, { user, mediaDir, body: { topic: '自测', content_type: 'dining', target_platforms: ['douyin'] } }), error => error.code === 'LIBRARY_EMPTY');
  console.log('库里没有餐饮素材时，系统挑会提示先往库里传 ✔');
} finally {
  await client.query('ROLLBACK');
  client.release();
  for (const id of created) await rm(path.join(mediaDir, 'materials', id), { recursive: true, force: true });
  const { rows: [left] } = await real.query(`SELECT (SELECT count(*)::int FROM leadgen.materials WHERE topic LIKE '自测%') AS materials, (SELECT count(*)::int FROM leadgen.library_files WHERE use_count > 0) AS used`);
  console.log('回滚后残留：', left);
  await real.end();
}
