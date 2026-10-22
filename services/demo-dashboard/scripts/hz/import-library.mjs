// 把资料文件夹里的图片和视频收进素材库。资料文件夹只读：先复制一份到临时目录，再按上传的同一套规则收进库里，原文件不动。
// 已经在库里的（内容相同）跳过，可以重复运行。
// 用法（在 services/demo-dashboard 下）：npm run library:import -- [资料文件夹，默认 E:\claude\训练数据]
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostPool } from '../../src/db/pool.js';
import { addToLibrary } from '../../src/publishing/libraryService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const source = process.argv[2] || 'E:\\claude\\训练数据';
const mediaDir = process.env.HZ_MEDIA_DIR || path.join(projectRoot, 'data', 'media');
// 资料文件夹里第一层的目录名 -> 素材类型
const FOLDER_TYPE = { 写字楼商铺: 'property', 酒店公寓: 'hotel', 餐饮: 'dining', 活动: 'event' };
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(target));
    else if (MIME[path.extname(entry.name).toLowerCase()]) found.push(target);
  }
  return found;
}

const pool = createHostPool();
const staging = path.join(tmpdir(), 'hz-library-import');
await mkdir(staging, { recursive: true });
try {
  for (const [folder, contentType] of Object.entries(FOLDER_TYPE)) {
    const directory = path.join(source, folder);
    const files = await walk(directory).catch(() => []);
    if (!files.length) { console.log(`${folder}：没有图片或视频`); continue; }
    let added = 0;
    const skipped = [];
    for (const file of files) {
      const copy = path.join(staging, `${Date.now()}-${path.basename(file)}`);
      await copyFile(file, copy);
      const name = path.relative(directory, file);
      const result = await addToLibrary(pool, {
        user: null, mediaDir, origin: 'import',
        body: { content_type: contentType, note: null },
        // 和网页上传收到的文件对象一样；文件名按上传时的编码传。
        files: [{ path: copy, originalname: Buffer.from(name, 'utf8').toString('latin1'), mimetype: MIME[path.extname(file).toLowerCase()], size: (await stat(copy)).size }]
      });
      added += result.added;
      skipped.push(...result.skipped);
    }
    console.log(`${folder}：收进 ${added} 个，跳过 ${skipped.length} 个（已经在库里）`);
  }
} finally {
  await pool.end();
}
