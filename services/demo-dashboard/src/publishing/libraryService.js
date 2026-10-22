// 素材库：各板块的图片和视频先收在这里，发内容时挑几样复制进一条新的发布素材，后面照原来的流程生成文案、人工确认、发布。
// 系统挑素材时按“最久没用过的先用”，同一个文件不会连着几条都用。
import { copyFile, link, mkdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CONTENT_TYPES, PLATFORMS } from './copywriter.js';
import { IMAGE_TYPES, MAX_IMAGES, VIDEO_TYPES, moveFile, parseMaterialFields, sha256File } from './publishingService.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 系统自动挑时，一条图文最多用几张图。
const AUTO_IMAGES = 6;

const present = row => ({ ...row, url: `/media/${row.file_path}`, content_type_name: CONTENT_TYPES[row.content_type]?.label });

export async function listLibrary(pool, { contentType = null, kind = null, archived = false, limit = 300, offset = 0 } = {}) {
  if (contentType && !CONTENT_TYPES[contentType]) throw fail(400, 'LIBRARY_TYPE_INVALID', '素材类型不正确');
  if (kind && !['image', 'video'].includes(kind)) throw fail(400, 'LIBRARY_KIND_INVALID', '文件类型不正确');
  const size = Math.min(Math.max(Number(limit) || 300, 1), 300);
  const params = [contentType, kind, Boolean(archived), size, Math.max(Number(offset) || 0, 0)];
  const [{ rows }, { rows: counts }] = await Promise.all([
    pool.query(`
      SELECT f.id, f.content_type, f.property_id, f.kind, f.file_path, f.original_name, f.size_bytes, f.note, f.origin, f.archived, f.use_count, f.last_used_at, f.created_at,
             CASE WHEN p.id IS NOT NULL THEN p.building || ' ' || p.unit_no END AS property_label
      FROM leadgen.library_files f LEFT JOIN leadgen.properties p ON p.id = f.property_id
      WHERE ($1::text IS NULL OR f.content_type = $1) AND ($2::text IS NULL OR f.kind = $2) AND f.archived = $3
      ORDER BY f.created_at DESC, f.id LIMIT $4 OFFSET $5`, params),
    pool.query(`
      SELECT content_type, count(*) FILTER (WHERE kind = 'image')::int AS images, count(*) FILTER (WHERE kind = 'video')::int AS videos
      FROM leadgen.library_files WHERE NOT archived GROUP BY content_type`)
  ]);
  const byType = Object.fromEntries(counts.map(row => [row.content_type, row]));
  return {
    items: rows.map(present),
    counts: Object.entries(CONTENT_TYPES).map(([key, type]) => ({ key, label: type.label, images: byType[key]?.images || 0, videos: byType[key]?.videos || 0 }))
  };
}

/**
 * Stores uploaded files in the library. A file that is already in the library (same content) is not stored twice.
 * Returns what was added and what was skipped.
 */
export async function addToLibrary(pool, { user, body, files, mediaDir, origin = 'upload' }) {
  if (!CONTENT_TYPES[body.content_type]) throw fail(400, 'LIBRARY_TYPE_INVALID', '请选择素材属于哪一类');
  const propertyId = body.content_type === 'property' && body.property_id ? body.property_id : null;
  if (propertyId && !UUID.test(String(propertyId))) throw fail(404, 'PROPERTY_NOT_FOUND', '没有找到这套房源');
  if (!files.length) throw fail(400, 'LIBRARY_FILE_REQUIRED', '至少选一个图片或视频');
  const note = String(body.note || '').trim().slice(0, 500) || null;
  const directory = path.join(mediaDir, 'library');
  await mkdir(directory, { recursive: true });
  const added = [];
  const skipped = [];
  for (const file of files) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const kind = IMAGE_TYPES[file.mimetype] ? 'image' : VIDEO_TYPES[file.mimetype] ? 'video' : null;
    if (!kind) { skipped.push(`${name}（只收 JPG、PNG、WebP 图片和 MP4、MOV 视频）`); await unlink(file.path).catch(() => {}); continue; }
    const sha = await sha256File(file.path);
    const { rows: [existing] } = await pool.query('SELECT id FROM leadgen.library_files WHERE sha256 = $1', [sha]);
    if (existing) { skipped.push(`${name}（素材库里已经有了）`); await unlink(file.path).catch(() => {}); continue; }
    const relative = `library/${sha.slice(0, 16)}${IMAGE_TYPES[file.mimetype] || VIDEO_TYPES[file.mimetype]}`;
    await moveFile(file.path, path.join(mediaDir, relative));
    const { rows: [row] } = await pool.query(`
      INSERT INTO leadgen.library_files (content_type, property_id, kind, file_path, sha256, original_name, mime_type, size_bytes, note, origin, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (sha256) DO NOTHING RETURNING id`,
    [body.content_type, propertyId, kind, relative, sha, name.slice(0, 200), file.mimetype, file.size, note, origin, user?.id ?? null]);
    if (row) added.push(row.id); else skipped.push(`${name}（素材库里已经有了）`);
  }
  return { added: added.length, skipped };
}

export async function updateLibraryFile(pool, { fileId, input }) {
  if (!UUID.test(String(fileId))) throw fail(404, 'LIBRARY_FILE_NOT_FOUND', '没有找到这个文件');
  if (input.content_type !== undefined && !CONTENT_TYPES[input.content_type]) throw fail(400, 'LIBRARY_TYPE_INVALID', '素材类型不正确');
  const { rows: [row] } = await pool.query(`
    UPDATE leadgen.library_files SET
      content_type = COALESCE($2, content_type),
      note = CASE WHEN $3::boolean THEN $4 ELSE note END,
      archived = COALESCE($5, archived)
    WHERE id = $1 RETURNING id, content_type, note, archived`,
  [fileId, input.content_type ?? null, input.note !== undefined, String(input.note ?? '').trim().slice(0, 500) || null, typeof input.archived === 'boolean' ? input.archived : null]);
  if (!row) throw fail(404, 'LIBRARY_FILE_NOT_FOUND', '没有找到这个文件');
  return row;
}

/** Picks files for one post: the ones used least (and longest ago) first. One video when a video is wanted, otherwise up to six images. */
export async function pickFromLibrary(db, { contentType, propertyId = null, wantVideo }) {
  const { rows } = await db.query(`
    SELECT id, kind FROM leadgen.library_files
    WHERE NOT archived AND content_type = $1 AND kind = $2 AND ($3::uuid IS NULL OR property_id = $3)
    ORDER BY use_count, last_used_at NULLS FIRST, random() LIMIT $4`,
  [contentType, wantVideo ? 'video' : 'image', propertyId, wantVideo ? 1 : AUTO_IMAGES]);
  return rows.map(row => row.id);
}

async function placeFile(from, to) {
  // 同一个盘上用硬链接，不多占空间；不行就复制一份。
  try { await link(from, to); } catch { await copyFile(from, to); }
}

/**
 * Creates a publishing material from library files and opens one draft per platform, exactly as an upload would.
 * With no files given, the system picks them. Returns the new material id.
 */
export async function createMaterialFromLibrary(pool, { user, body, mediaDir }) {
  const fields = parseMaterialFields(body);
  let fileIds = [...new Set([].concat(body.file_ids || []).map(String))];
  if (fileIds.some(id => !UUID.test(id))) throw fail(400, 'LIBRARY_FILE_NOT_FOUND', '选的文件不正确');
  const client = await pool.connect();
  let directory = null;
  try {
    await client.query('BEGIN');
    let picked = false;
    if (!fileIds.length) {
      // 只发视频号时必须用视频；其余优先用视频，库里没有视频就用图片。
      const needVideo = fields.platforms.every(platform => platform === 'channels');
      fileIds = await pickFromLibrary(client, { contentType: fields.contentType, propertyId: fields.propertyId, wantVideo: true });
      if (!fileIds.length && !needVideo) fileIds = await pickFromLibrary(client, { contentType: fields.contentType, propertyId: fields.propertyId, wantVideo: false });
      if (!fileIds.length) throw fail(409, 'LIBRARY_EMPTY', `素材库里还没有可用的${CONTENT_TYPES[fields.contentType].label}${needVideo ? '视频' : '图片或视频'}，先往库里传一些`);
      picked = true;
    }
    const { rows: files } = await client.query(
      'SELECT id, kind, file_path, sha256, original_name, mime_type, size_bytes, note FROM leadgen.library_files WHERE id = ANY($1) AND NOT archived FOR UPDATE', [fileIds]);
    if (files.length !== fileIds.length) throw fail(404, 'LIBRARY_FILE_NOT_FOUND', '有的文件已经不在素材库里了，请刷新后重选');
    const videos = files.filter(file => file.kind === 'video');
    const images = files.filter(file => file.kind === 'image');
    if (videos.length > 1) throw fail(400, 'MATERIAL_TOO_MANY_VIDEOS', '一条内容只能用 1 个视频');
    if (images.length > MAX_IMAGES) throw fail(400, 'MATERIAL_TOO_MANY_IMAGES', `一条内容最多 ${MAX_IMAGES} 张图片`);
    if (!videos.length && fields.platforms.includes('channels')) throw fail(400, 'MATERIAL_VIDEO_REQUIRED', '视频号只能发视频，选的素材里没有视频');
    // 素材库里给文件写的“画面里是什么”带进补充说明，文案才写得贴着画面。
    const pictures = [...new Set(files.map(file => file.note).filter(Boolean))];
    const note = [fields.note, pictures.length ? `画面：${pictures.join('；')}` : null].filter(Boolean).join('\n').slice(0, 1000) || null;
    const { rows: [material] } = await client.query(`
      INSERT INTO leadgen.materials (topic, content_type, property_id, note, target_platforms, created_by)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [fields.topic, fields.contentType, fields.propertyId, note, fields.platforms, user.id]);
    directory = path.join(mediaDir, 'materials', material.id);
    await mkdir(directory, { recursive: true });
    // 视频放在最前面，其余按选的顺序。
    const ordered = [...videos, ...fileIds.map(id => images.find(file => file.id === id)).filter(Boolean)];
    for (const [order, file] of ordered.entries()) {
      const relative = `materials/${material.id}/${path.basename(file.file_path)}`;
      await placeFile(path.join(mediaDir, file.file_path), path.join(mediaDir, relative));
      await client.query(`
        INSERT INTO leadgen.material_files (material_id, kind, file_path, original_name, mime_type, size_bytes, sha256, sort_order, library_file_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [material.id, file.kind, relative, file.original_name, file.mime_type, file.size_bytes, file.sha256, order, file.id]);
    }
    for (const platform of fields.platforms) {
      await client.query('INSERT INTO leadgen.publish_tasks (material_id, platform) VALUES ($1, $2)', [material.id, platform]);
    }
    await client.query('UPDATE leadgen.library_files SET use_count = use_count + 1, last_used_at = now() WHERE id = ANY($1)', [fileIds]);
    await client.query('COMMIT');
    return { id: material.id, picked, files: ordered.length };
  } catch (error) {
    await client.query('ROLLBACK');
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const LIBRARY_PLATFORMS = Object.keys(PLATFORMS);
