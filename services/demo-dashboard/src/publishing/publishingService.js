import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CONTENT_TYPES, PLATFORMS, findForbidden, normalizeDraft, writeDraft } from './copywriter.js';

export const MAX_IMAGES = 18;
export const MAX_VIDEOS = 1;
export const MIN_GAP_MINUTES = 10;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const VIDEO_TYPES = { 'video/mp4': '.mp4', 'video/quicktime': '.mov' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TASK_STATUS_NAME = Object.freeze({ draft: '待确认', confirmed: '待发布', publishing: '发布中', published: '已发布', failed: '发布失败', withdrawn: '已撤回', removed: '已在平台删除' });

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const requireUuid = (value, code) => { if (!UUID.test(String(value))) throw fail(404, code, '没有找到这条记录'); };

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

async function moveFile(from, to) {
  try { await rename(from, to); }
  catch (error) {
    // 临时目录和素材目录不在同一个盘时不能直接改名。
    if (error.code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await unlink(from);
  }
}

export function parseMaterialFields(body) {
  const topic = String(body.topic || '').trim();
  if (!topic) throw fail(400, 'MATERIAL_TOPIC_REQUIRED', '请填写主题');
  if (topic.length > 100) throw fail(400, 'MATERIAL_TOPIC_TOO_LONG', '主题不超过 100 字');
  if (!CONTENT_TYPES[body.content_type]) throw fail(400, 'MATERIAL_TYPE_INVALID', '请选择内容类型');
  const platforms = [...new Set([].concat(body.target_platforms || []).flatMap(value => String(value).split(',')).map(value => value.trim()).filter(Boolean))];
  if (!platforms.length) throw fail(400, 'MATERIAL_PLATFORM_REQUIRED', '至少选一个目标平台');
  if (platforms.some(platform => !PLATFORMS[platform])) throw fail(400, 'MATERIAL_PLATFORM_INVALID', '目标平台不正确');
  const propertyId = body.property_id || null;
  if (propertyId) requireUuid(propertyId, 'PROPERTY_NOT_FOUND');
  return {
    topic, contentType: body.content_type, platforms, note: String(body.note || '').trim().slice(0, 1000) || null,
    propertyId: body.content_type === 'property' ? propertyId : null
  };
}

export function classifyUploads(files) {
  const images = files.filter(file => IMAGE_TYPES[file.mimetype]);
  const videos = files.filter(file => VIDEO_TYPES[file.mimetype]);
  if (images.length + videos.length !== files.length) throw fail(400, 'MATERIAL_FILE_TYPE', '只能上传 JPG、PNG、WebP 图片和 MP4、MOV 视频');
  if (!files.length) throw fail(400, 'MATERIAL_FILE_REQUIRED', '至少上传一张图片或一个视频');
  if (images.length > MAX_IMAGES) throw fail(400, 'MATERIAL_TOO_MANY_IMAGES', `图片最多 ${MAX_IMAGES} 张`);
  if (videos.length > MAX_VIDEOS) throw fail(400, 'MATERIAL_TOO_MANY_VIDEOS', '视频最多 1 个');
  return [...images.map(file => ({ file, kind: 'image', ext: IMAGE_TYPES[file.mimetype] })), ...videos.map(file => ({ file, kind: 'video', ext: VIDEO_TYPES[file.mimetype] }))];
}

/** Stores the files on disk, records path and hash, and opens one draft task per target platform. */
export async function createMaterial(pool, { user, body, files, mediaDir }) {
  const fields = parseMaterialFields(body);
  const uploads = classifyUploads(files);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (fields.propertyId) {
      const { rowCount } = await client.query('SELECT 1 FROM leadgen.properties WHERE id = $1', [fields.propertyId]);
      if (!rowCount) throw fail(404, 'PROPERTY_NOT_FOUND', '没有找到这套房源');
    }
    const { rows: [material] } = await client.query(`
      INSERT INTO leadgen.materials (topic, content_type, property_id, note, target_platforms, created_by)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [fields.topic, fields.contentType, fields.propertyId, fields.note, fields.platforms, user.id]);
    const directory = path.join(mediaDir, 'materials', material.id);
    await mkdir(directory, { recursive: true });
    const duplicates = [];
    const seen = new Set();
    let order = 0;
    for (const { file, kind, ext } of uploads) {
      const sha = await sha256File(file.path);
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      if (seen.has(sha)) { await unlink(file.path).catch(() => {}); duplicates.push(`${name}（本次重复选了两遍，只保留一份）`); continue; }
      seen.add(sha);
      const { rows: [earlier] } = await client.query(`
        SELECT m.topic FROM leadgen.material_files f JOIN leadgen.materials m ON m.id = f.material_id WHERE f.sha256 = $1 LIMIT 1`, [sha]);
      if (earlier) duplicates.push(`${name}（以前在“${earlier.topic}”里传过）`);
      const relative = `materials/${material.id}/${sha.slice(0, 16)}${ext}`;
      await moveFile(file.path, path.join(mediaDir, relative));
      await client.query(`
        INSERT INTO leadgen.material_files (material_id, kind, file_path, original_name, mime_type, size_bytes, sha256, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [material.id, kind, relative, name.slice(0, 200), file.mimetype, file.size, sha, order]);
      order += 1;
    }
    for (const platform of fields.platforms) {
      await client.query('INSERT INTO leadgen.publish_tasks (material_id, platform) VALUES ($1, $2)', [material.id, platform]);
    }
    await client.query('COMMIT');
    return { id: material.id, duplicates };
  } catch (error) {
    await client.query('ROLLBACK');
    await Promise.all(files.map(file => unlink(file.path).catch(() => {})));
    throw error;
  } finally {
    client.release();
  }
}

/** Opens one more draft for a material that is already in the system, so the same files can go to another platform. */
export async function addPlatform(pool, { materialId, platform, user }) {
  requireUuid(materialId, 'MATERIAL_NOT_FOUND');
  if (!PLATFORMS[platform]) throw fail(400, 'MATERIAL_PLATFORM_INVALID', '目标平台不正确');
  return inTransaction(pool, async client => {
    const { rows: [material] } = await client.query('SELECT id FROM leadgen.materials WHERE id = $1 FOR UPDATE', [materialId]);
    if (!material) throw fail(404, 'MATERIAL_NOT_FOUND', '没有找到这条素材');
    // 已在平台上删除的不算：删掉以后可以重新出一条。
    const { rowCount } = await client.query(`SELECT 1 FROM leadgen.publish_tasks WHERE material_id = $1 AND platform = $2 AND status <> 'removed'`, [materialId, platform]);
    if (rowCount) throw fail(409, 'PLATFORM_ALREADY_ADDED', `这条素材已经有${PLATFORMS[platform].label}的内容了`);
    const { rows: [task] } = await client.query('INSERT INTO leadgen.publish_tasks (material_id, platform) VALUES ($1, $2) RETURNING id', [materialId, platform]);
    await client.query('UPDATE leadgen.materials SET target_platforms = array_append(target_platforms, $2) WHERE id = $1 AND NOT ($2 = ANY(target_platforms))', [materialId, platform]);
    // 重发：这个平台上有删掉的那一条时，把它的文案带过来当草稿，人看过再确认。
    const { rows: [earlier] } = await client.query(`
      SELECT title, body, topics FROM leadgen.publish_tasks WHERE material_id = $1 AND platform = $2 AND status = 'removed' AND body IS NOT NULL
      ORDER BY removed_at DESC NULLS LAST LIMIT 1`, [materialId, platform]);
    if (earlier && user) await saveVersion(client, task, { title: earlier.title, body: earlier.body, topics: earlier.topics || [] }, 'manual', user.id);
    return { task_id: task.id, platform, copied: Boolean(earlier && user) };
  });
}

export async function listMaterials(pool, { limit = 50, offset = 0, mine = null } = {}) {
  const { rows } = await pool.query(`
    SELECT m.id, m.topic, m.content_type, m.created_at, u.display_name AS created_by_name,
           (SELECT count(*)::int FROM leadgen.material_files f WHERE f.material_id = m.id AND f.kind = 'image') AS image_count,
           (SELECT count(*)::int FROM leadgen.material_files f WHERE f.material_id = m.id AND f.kind = 'video') AS video_count,
           (SELECT '/media/' || f.file_path FROM leadgen.material_files f WHERE f.material_id = m.id AND f.kind = 'image' ORDER BY f.sort_order LIMIT 1) AS cover_url,
           (SELECT json_agg(json_build_object('platform', t.platform, 'status', t.status, 'scheduled_at', t.scheduled_at, 'has_body', t.body IS NOT NULL) ORDER BY t.platform)
              FROM leadgen.publish_tasks t WHERE t.material_id = m.id) AS tasks
    FROM leadgen.materials m LEFT JOIN leadgen.users u ON u.id = m.created_by
    WHERE ($3::uuid IS NULL OR m.created_by = $3)
    ORDER BY m.created_at DESC LIMIT $1 OFFSET $2`,
  [Math.min(Math.max(Number(limit) || 50, 1), 100), Math.max(Number(offset) || 0, 0), mine]);
  return { items: rows.map(row => ({ ...row, content_type_name: CONTENT_TYPES[row.content_type].label, tasks: (row.tasks || []).map(decorateTask) })) };
}

const decorateTask = task => ({ ...task, platform_name: PLATFORMS[task.platform].label, status_name: task.status === 'draft' && task.has_body === false ? '待生成' : TASK_STATUS_NAME[task.status] });

async function loadMaterial(db, materialId) {
  requireUuid(materialId, 'MATERIAL_NOT_FOUND');
  const { rows: [material] } = await db.query(`
    SELECT m.*, u.display_name AS created_by_name,
           (SELECT count(*)::int FROM leadgen.material_files f WHERE f.material_id = m.id AND f.kind = 'image') AS image_count,
           (SELECT count(*)::int FROM leadgen.material_files f WHERE f.material_id = m.id AND f.kind = 'video') AS video_count
    FROM leadgen.materials m LEFT JOIN leadgen.users u ON u.id = m.created_by WHERE m.id = $1`, [materialId]);
  if (!material) throw fail(404, 'MATERIAL_NOT_FOUND', '没有找到这份素材');
  const property = material.property_id
    ? (await db.query('SELECT * FROM leadgen.properties WHERE id = $1', [material.property_id])).rows[0] : null;
  return { material, property };
}

/** Floor figures a post about this material must not contain. A shop's own listed rent is public, so only its type's floor applies. */
async function floorPricesFor(db, property) {
  const { rows } = await db.query('SELECT property_type, floor_price_per_sqm FROM leadgen.leasing_policy WHERE floor_price_per_sqm IS NOT NULL');
  return rows.filter(row => !property || row.property_type === property.property_type).map(row => Number(row.floor_price_per_sqm));
}

export async function getMaterial(pool, materialId) {
  const { material, property } = await loadMaterial(pool, materialId);
  const [{ rows: files }, { rows: tasks }] = await Promise.all([
    pool.query(`SELECT id, kind, '/media/' || file_path AS url, original_name, size_bytes FROM leadgen.material_files WHERE material_id = $1 ORDER BY sort_order`, [materialId]),
    pool.query(`
      SELECT t.id, t.platform, t.status, t.title, t.body, t.topics, t.scheduled_at, t.confirmed_at, t.published_at, t.post_url, t.stat_views, t.stat_likes, t.stat_comments, t.stat_favorites, t.stat_shares, t.metrics_at, t.removed_at, t.removed_note,
             t.error_message, CASE WHEN t.error_screenshot IS NOT NULL THEN '/media/' || t.error_screenshot END AS error_screenshot_url,
             t.body IS NOT NULL AS has_body, a.account_name, c.display_name AS confirmed_by_name,
             (SELECT count(*)::int FROM leadgen.publish_task_versions v WHERE v.task_id = t.id) AS version_count
      FROM leadgen.publish_tasks t
      LEFT JOIN leadgen.publish_accounts a ON a.id = t.account_id
      LEFT JOIN leadgen.users c ON c.id = t.confirmed_by
      WHERE t.material_id = $1 ORDER BY array_position(ARRAY['douyin', 'channels', 'xiaohongshu', 'moments'], t.platform), (t.status = 'removed'), t.created_at DESC`, [materialId])
  ]);
  const floors = await floorPricesFor(pool, property);
  return {
    id: material.id, topic: material.topic, content_type: material.content_type, content_type_name: CONTENT_TYPES[material.content_type].label,
    note: material.note, created_at: material.created_at, created_by_name: material.created_by_name,
    property: property ? { id: property.id, label: `${property.building} ${property.unit_no}`, floor: property.floor, area_sqm: Number(property.area_sqm) } : null,
    files,
    tasks: tasks.map(task => ({
      ...decorateTask(task), limits: PLATFORMS[task.platform],
      problems: task.body ? normalizeDraft(task.platform, task, floors).problems : []
    }))
  };
}

const EDITABLE = ['draft', 'failed', 'withdrawn'];

async function saveVersion(client, task, draft, source, userId) {
  await client.query(`
    UPDATE leadgen.publish_tasks SET title = $2, body = $3, topics = $4, status = 'draft', error_message = NULL, updated_at = now() WHERE id = $1`,
  [task.id, draft.title, draft.body, draft.topics]);
  await client.query(`
    INSERT INTO leadgen.publish_task_versions (task_id, title, body, topics, source, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
  [task.id, draft.title, draft.body, draft.topics, source, userId]);
}

/** Writes a draft for each target platform that is still editable (or just the one asked for). Earlier versions are kept. */
/** 酒店档案里的事实，给酒店类内容用。没有价格（房价不在档案里）。 */
async function hotelFacts(pool) {
  const { rows: [hotel] } = await pool.query(`
    SELECT h.name, h.brand_note, h.address, h.room_count, h.opened_year, h.check_in_time, h.check_out_time, h.location_notes, h.room_highlights,
           h.facilities, h.meeting_room_area_sqm, h.meeting_room_capacity_min, h.meeting_room_capacity_max,
           (SELECT array_agg(r.name || COALESCE('（' || trim_scale(r.area_sqm)::text || ' ㎡）', '') ORDER BY r.sort_order) FROM leadgen.hotel_room_types r WHERE r.hotel_id = h.id) AS rooms
    FROM leadgen.hotels h ORDER BY h.name LIMIT 1`);
  if (!hotel) return [];
  const list = value => (value || []).join('；');
  return [
    `酒店：${hotel.name}${hotel.brand_note ? `，${hotel.brand_note}` : ''}`,
    `酒店地址：${hotel.address}`,
    hotel.room_count ? `客房 ${hotel.room_count} 间${hotel.opened_year ? `，${hotel.opened_year} 年开业` : ''}` : null,
    hotel.rooms?.length ? `房型：${list(hotel.rooms)}` : null,
    hotel.room_highlights?.length ? `客房特点：${list(hotel.room_highlights)}` : null,
    hotel.facilities?.length ? `设施：${list(hotel.facilities)}` : null,
    hotel.location_notes?.length ? `位置：${list(hotel.location_notes)}` : null,
    hotel.meeting_room_area_sqm ? `会议室 ${Number(hotel.meeting_room_area_sqm)} ㎡，可容纳 ${hotel.meeting_room_capacity_min}–${hotel.meeting_room_capacity_max} 人` : null,
    hotel.check_in_time ? `入住 ${hotel.check_in_time}，退房 ${hotel.check_out_time}` : null
  ].filter(Boolean);
}

export async function generateDrafts(pool, { materialId, platform = null, user, llm, env = process.env }) {
  if (!llm.configured) throw fail(409, 'LLM_KEY_MISSING', '还没有配置大模型，暂时不能生成文案，可以先手写');
  const { material, property } = await loadMaterial(pool, materialId);
  const floors = await floorPricesFor(pool, property);
  const { rows: [project] } = await pool.query('SELECT address, transport_notes, target_industries, parking_monthly_fee, parking_hourly_fee, parking_free_hours FROM leadgen.project_profile WHERE id = 1');
  if (material.content_type === 'hotel') material.venue_lines = await hotelFacts(pool);
  const { rows: tasks } = await pool.query(
    `SELECT id, platform, status FROM leadgen.publish_tasks WHERE material_id = $1 AND ($2::text IS NULL OR platform = $2) AND status = ANY($3)`,
    [materialId, platform, EDITABLE]);
  if (!tasks.length) throw fail(409, 'NO_EDITABLE_TASK', '没有可以生成的草稿（已确认或已发布的要先撤回）');
  const results = [];
  for (const task of tasks) {
    const started = Date.now();
    let draft;
    try {
      draft = await writeDraft({ llm, platform: task.platform, material, property, project, floorPrices: floors });
    } catch (error) {
      await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, error_code, duration_ms) VALUES ($1, 'chat/completions', $2, 'error', $3, $4)`,
        [llm.provider, `文案：${material.topic}／${PLATFORMS[task.platform].label}`, error.code || error.name, Date.now() - started]);
      throw fail(502, 'LLM_FAILED', `大模型服务不可用：${error.message}`);
    }
    const cost = (draft.usage.inputTokens * Number(env.LLM_PRICE_INPUT_PER_M || 2) + draft.usage.outputTokens * Number(env.LLM_PRICE_OUTPUT_PER_M || 8)) / 1_000_000;
    await pool.query(`INSERT INTO leadgen.api_usage_events (provider, endpoint, request_summary, status, cost_cny, duration_ms) VALUES ($1, 'chat/completions', $2, 'ok', $3, $4)`,
      [llm.provider, `文案：${material.topic}／${PLATFORMS[task.platform].label}（输入 ${draft.usage.inputTokens}，输出 ${draft.usage.outputTokens} token）`, cost, Date.now() - started]);
    // 两次都带着底价的稿子不保存。
    if (draft.problems.some(problem => problem.startsWith('出现了'))) { results.push({ platform: task.platform, saved: false, problems: draft.problems }); continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await saveVersion(client, task, draft, 'model', user.id);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    results.push({ platform: task.platform, saved: true, problems: draft.problems, removed: draft.removed });
  }
  return { results };
}

async function lockTask(client, taskId) {
  requireUuid(taskId, 'TASK_NOT_FOUND');
  const { rows: [task] } = await client.query(`
    SELECT t.*, m.property_id FROM leadgen.publish_tasks t JOIN leadgen.materials m ON m.id = t.material_id WHERE t.id = $1 FOR UPDATE OF t`, [taskId]);
  if (!task) throw fail(404, 'TASK_NOT_FOUND', '没有找到这条发布任务');
  const property = task.property_id ? (await client.query('SELECT property_type FROM leadgen.properties WHERE id = $1', [task.property_id])).rows[0] : null;
  return { task, floors: await floorPricesFor(client, property) };
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

/** Manual edit. Length problems are reported back; wording about the floor price is refused outright. */
export function updateDraft(pool, { taskId, user, input }) {
  return inTransaction(pool, async client => {
    const { task, floors } = await lockTask(client, taskId);
    if (!EDITABLE.includes(task.status)) throw fail(409, 'TASK_NOT_EDITABLE', '已确认或已发布的内容不能直接改，请先撤回');
    const topics = Array.isArray(input.topics) ? input.topics : String(input.topics || '').split(/[\s,，、#]+/);
    const draft = normalizeDraft(task.platform, { title: input.title, body: input.body, topics }, floors);
    const forbidden = findForbidden(`${draft.title || ''}\n${draft.body}\n${draft.topics.join(' ')}`, floors);
    if (forbidden) throw fail(400, 'DRAFT_FORBIDDEN_WORDING', `文案里不能出现${forbidden}`);
    if (!draft.body) throw fail(400, 'DRAFT_BODY_REQUIRED', '正文不能为空');
    await saveVersion(client, task, draft, 'manual', user.id);
    return { problems: draft.problems };
  });
}

/**
 * Puts a draft in the publishing queue. Nothing reaches the publisher without this step.
 * The time is moved later when the same account already has a post within ten minutes.
 */
export function confirmTask(pool, { taskId, user, scheduledAt }) {
  return inTransaction(pool, async client => {
    const { task, floors } = await lockTask(client, taskId);
    if (!EDITABLE.includes(task.status)) throw fail(409, 'TASK_NOT_EDITABLE', '这条内容已经确认过');
    if (!task.body) throw fail(400, 'DRAFT_BODY_REQUIRED', '还没有文案，先生成或手写');
    const { problems } = normalizeDraft(task.platform, task, floors);
    if (problems.length) throw fail(400, 'DRAFT_HAS_PROBLEMS', `文案还有问题：${problems.join('；')}`);
    const { rows: [account] } = await client.query(`
      SELECT id, account_name, daily_limit FROM leadgen.publish_accounts
      WHERE platform = $1 AND purpose = 'publish' AND NOT is_paused ORDER BY created_at LIMIT 1`, [task.platform]);
    if (!account) throw fail(409, 'PUBLISH_ACCOUNT_MISSING', `还没有可用的${PLATFORMS[task.platform].label}发布账号，请管理员先添加`);
    let when = scheduledAt ? new Date(scheduledAt) : new Date();
    if (Number.isNaN(when.getTime())) throw fail(400, 'SCHEDULE_INVALID', '发布时间不正确');
    if (when.getTime() < Date.now() - 60_000) when = new Date();
    const { rows: busy } = await client.query(`
      SELECT COALESCE(published_at, scheduled_at) AS at FROM leadgen.publish_tasks
      WHERE account_id = $1 AND id <> $2 AND status IN ('confirmed', 'publishing', 'published', 'removed') ORDER BY 1`, [account.id, taskId]);
    const gap = MIN_GAP_MINUTES * 60_000;
    let moved = false;
    for (const { at } of busy) {
      if (Math.abs(new Date(at).getTime() - when.getTime()) < gap) { when = new Date(new Date(at).getTime() + gap); moved = true; }
    }
    const { rows: [day] } = await client.query(`
      SELECT count(*)::int AS n FROM leadgen.publish_tasks
      WHERE account_id = $1 AND id <> $2 AND status IN ('confirmed', 'publishing', 'published', 'removed')
        AND date_trunc('day', COALESCE(published_at, scheduled_at)) = date_trunc('day', $3::timestamptz)`, [account.id, taskId, when.toISOString()]);
    if (day.n >= account.daily_limit) throw fail(409, 'DAILY_LIMIT_REACHED', `这个账号当天已经排了 ${day.n} 条，达到每日上限，请换一天`);
    await client.query(`
      UPDATE leadgen.publish_tasks SET status = 'confirmed', account_id = $2, scheduled_at = $3, confirmed_by = $4, confirmed_at = now(),
        error_message = NULL, updated_at = now() WHERE id = $1`, [taskId, account.id, when.toISOString(), user.id]);
    return { status: 'confirmed', scheduled_at: when.toISOString(), moved, account_name: account.account_name };
  });
}

export function withdrawTask(pool, { taskId }) {
  return inTransaction(pool, async client => {
    const { task } = await lockTask(client, taskId);
    if (task.status !== 'confirmed') throw fail(409, 'TASK_NOT_WITHDRAWABLE', task.status === 'publishing' ? '正在发布，来不及撤回了' : '只有待发布的内容可以撤回');
    await client.query(`UPDATE leadgen.publish_tasks SET status = 'withdrawn', scheduled_at = NULL, updated_at = now() WHERE id = $1`, [taskId]);
    return { status: 'withdrawn' };
  });
}

/** Records that a published post was later deleted on the platform by a person. The system never deletes posts itself. */
export function markRemoved(pool, { taskId, note }) {
  return inTransaction(pool, async client => {
    const { task } = await lockTask(client, taskId);
    if (task.status !== 'published') throw fail(409, 'TASK_NOT_PUBLISHED', '只有已发布的内容可以标记为已删除');
    await client.query(`UPDATE leadgen.publish_tasks SET status = 'removed', removed_at = now(), removed_note = $2, updated_at = now() WHERE id = $1`,
      [taskId, String(note || '').trim().slice(0, 200) || null]);
    return { status: 'removed' };
  });
}

export async function listVersions(pool, taskId) {
  requireUuid(taskId, 'TASK_NOT_FOUND');
  const { rows } = await pool.query(`
    SELECT v.id, v.title, v.body, v.topics, v.source, v.created_at, u.display_name AS created_by_name
    FROM leadgen.publish_task_versions v LEFT JOIN leadgen.users u ON u.id = v.created_by
    WHERE v.task_id = $1 ORDER BY v.created_at DESC LIMIT 30`, [taskId]);
  return { items: rows };
}

// 发布程序已经接入的平台。其余平台可以先建账号，但还不能扫码和发布。
// 朋友圈发得多容易被限制，每天最多这么多条。
export const MOMENTS_DAILY_MAX = 3;
export const CONNECTED_PLATFORMS = Object.freeze(['douyin', 'xiaohongshu', 'channels']);
const PUBLISHER_ONLINE_SECONDS = 90;

export async function listAccounts(pool) {
  const [{ rows }, { rows: [beat] }] = await Promise.all([
    pool.query(`
      SELECT a.id, a.platform, a.account_name, a.account_type, a.purpose, a.login_status, a.last_login_at, a.daily_limit, a.is_paused,
             (SELECT count(*)::int FROM leadgen.publish_tasks t WHERE t.account_id = a.id AND t.status = 'confirmed') AS queued,
             (SELECT count(*)::int FROM leadgen.publish_tasks t WHERE t.account_id = a.id AND t.status = 'published'
                AND t.published_at >= date_trunc('day', now())) AS published_today,
             r.status AS login_request_status, r.message AS login_request_message, r.created_at AS login_requested_at
      FROM leadgen.publish_accounts a
      LEFT JOIN LATERAL (SELECT status, message, created_at FROM leadgen.publish_login_requests WHERE account_id = a.id ORDER BY created_at DESC LIMIT 1) r ON true
      ORDER BY array_position(ARRAY['douyin', 'channels', 'xiaohongshu', 'moments'], a.platform), a.created_at`),
    pool.query(`SELECT last_seen_at, last_seen_at > now() - make_interval(secs => $1) AS online, network_note, phone, phone_checked_at > now() - interval '5 minutes' AS phone_fresh FROM leadgen.publisher_heartbeat WHERE id = 1`, [PUBLISHER_ONLINE_SECONDS])
  ]);
  return {
    publisher: { online: Boolean(beat?.online), last_seen_at: beat?.last_seen_at ?? null, network_note: beat?.online ? beat.network_note ?? null : null },
    // 专用手机：发朋友圈用。发布程序每分钟看一次；程序没在跑或很久没看过，就当不知道。
    phone: beat?.online && beat.phone_fresh && beat.phone
      ? { known: true, connected: Boolean(beat.phone.connected), ready: Boolean(beat.phone.ready), model: beat.phone.model || null,
        moments_ready: Boolean(beat.phone.moments_ready), note: String(beat.phone.note || '') }
      : { known: false, connected: false, ready: false, model: null, moments_ready: false, note: '发布程序没有在运行，不知道手机的状态' },
    items: rows.map(row => ({ ...row, platform_name: PLATFORMS[row.platform].label, connected: CONNECTED_PLATFORMS.includes(row.platform), uses_phone: row.platform === 'moments' }))
  };
}

/** Asks the publisher on this computer to open the QR login window for an account. */
export async function requestLogin(pool, { accountId, user }) {
  requireUuid(accountId, 'ACCOUNT_NOT_FOUND');
  const { rows: [account] } = await pool.query('SELECT id, platform FROM leadgen.publish_accounts WHERE id = $1', [accountId]);
  if (!account) throw fail(404, 'ACCOUNT_NOT_FOUND', '没有找到这个账号');
  if (!CONNECTED_PLATFORMS.includes(account.platform)) throw fail(409, 'PLATFORM_NOT_CONNECTED', `${PLATFORMS[account.platform].label}还没有接入，暂时不能扫码登录`);
  const { rows: [beat] } = await pool.query(`SELECT last_seen_at > now() - make_interval(secs => $1) AS online FROM leadgen.publisher_heartbeat WHERE id = 1`, [PUBLISHER_ONLINE_SECONDS]);
  if (!beat?.online) throw fail(409, 'PUBLISHER_OFFLINE', '发布程序没有在运行。请先在这台电脑上双击 publisher 文件夹里的 start-publisher.cmd');
  const { rows: [open] } = await pool.query(`SELECT 1 FROM leadgen.publish_login_requests WHERE account_id = $1 AND status IN ('queued', 'opened')`, [accountId]);
  if (open) throw fail(409, 'LOGIN_ALREADY_REQUESTED', '已经在等扫码了，请看电脑上弹出的浏览器窗口');
  await pool.query('INSERT INTO leadgen.publish_login_requests (account_id, requested_by) VALUES ($1, $2)', [accountId, user.id]);
  return { status: 'queued' };
}

/** Tasks that have copy, by the day they are scheduled or were published, for the calendar. */
export async function calendarTasks(pool, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) throw fail(400, 'CALENDAR_MONTH_INVALID', '月份不正确');
  const { rows } = await pool.query(`
    SELECT t.id, t.material_id, m.topic, t.platform, t.status, COALESCE(t.published_at, t.scheduled_at) AS at,
           to_char(COALESCE(t.published_at, t.scheduled_at), 'YYYY-MM-DD') AS day
    FROM leadgen.publish_tasks t JOIN leadgen.materials m ON m.id = t.material_id
    WHERE t.status IN ('confirmed', 'publishing', 'published', 'failed') AND COALESCE(t.published_at, t.scheduled_at) IS NOT NULL
      AND COALESCE(t.published_at, t.scheduled_at) >= ($1 || '-01')::date - interval '7 days'
      AND COALESCE(t.published_at, t.scheduled_at) < ($1 || '-01')::date + interval '1 month' + interval '7 days'
    ORDER BY 6`, [month]);
  return { month, items: rows.map(row => ({ ...row, platform_name: PLATFORMS[row.platform].label, status_name: TASK_STATUS_NAME[row.status] })) };
}

export async function addAccount(pool, input) {
  const name = String(input.account_name || '').trim();
  if (!PLATFORMS[input.platform]) throw fail(400, 'ACCOUNT_PLATFORM_INVALID', '请选择平台');
  if (!name || name.length > 40) throw fail(400, 'ACCOUNT_NAME_INVALID', '请填写账号名称（不超过 40 字）');
  const limit = Number(input.daily_limit ?? (input.platform === 'moments' ? 3 : 5));
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw fail(400, 'ACCOUNT_LIMIT_INVALID', '每日上限应为 1–50');
  // 搜索专用的小号只用来搜公开帖子，不发内容；只有小红书和抖音能搜。
  const purpose = input.purpose === 'search' ? 'search' : 'publish';
  if (purpose === 'search' && !['xiaohongshu', 'douyin'].includes(input.platform)) throw fail(400, 'ACCOUNT_PLATFORM_INVALID', '搜索专用的账号只能是小红书或抖音');
  if (input.platform === 'moments' && limit > MOMENTS_DAILY_MAX) throw fail(400, 'ACCOUNT_LIMIT_INVALID', `朋友圈每天最多 ${MOMENTS_DAILY_MAX} 条`);
  try {
    const { rows: [row] } = await pool.query(`
      INSERT INTO leadgen.publish_accounts (platform, account_name, daily_limit, purpose) VALUES ($1, $2, $3, $4) RETURNING id`, [input.platform, name, limit, purpose]);
    return row;
  } catch (error) {
    if (error.code === '23505') throw fail(409, 'ACCOUNT_EXISTS', '这个账号已经添加过');
    throw error;
  }
}

export async function updateAccount(pool, accountId, input) {
  requireUuid(accountId, 'ACCOUNT_NOT_FOUND');
  const limit = input.daily_limit === undefined ? null : Number(input.daily_limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw fail(400, 'ACCOUNT_LIMIT_INVALID', '每日上限应为 1–50');
  const name = input.account_name === undefined ? null : String(input.account_name).trim();
  if (name !== null && (!name || name.length > 40)) throw fail(400, 'ACCOUNT_NAME_INVALID', '请填写账号名称（不超过 40 字）');
  if (limit !== null && limit > MOMENTS_DAILY_MAX) {
    const { rows: [current] } = await pool.query('SELECT platform FROM leadgen.publish_accounts WHERE id = $1', [accountId]);
    if (current?.platform === 'moments') throw fail(400, 'ACCOUNT_LIMIT_INVALID', `朋友圈每天最多 ${MOMENTS_DAILY_MAX} 条`);
  }
  const { rowCount } = await pool.query(`
    UPDATE leadgen.publish_accounts SET is_paused = COALESCE($2, is_paused), daily_limit = COALESCE($3, daily_limit),
      account_name = COALESCE($4, account_name), updated_at = now() WHERE id = $1`,
  [accountId, typeof input.is_paused === 'boolean' ? input.is_paused : null, limit, name]).catch(error => {
    if (error.code === '23505') throw fail(409, 'ACCOUNT_EXISTS', '这个平台已经有同名的账号');
    throw error;
  });
  if (!rowCount) throw fail(404, 'ACCOUNT_NOT_FOUND', '没有找到这个账号');
}
