// 留资表单：每条发布内容一个带参数的链接和二维码；客人主动填写后进对应板块的“待联系”。
// 需求见 docs/hz/执行计划_V1.2.md 的 WP09。只接收客人主动留下的信息，不做任何主动联系。
import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const PLATFORM_NAME = { douyin: '抖音', channels: '视频号', xiaohongshu: '小红书', moments: '朋友圈' };
// 内容类型 → 线索进入哪个板块；和互动收件箱的口径一致。
const SECTOR_OF = { property: 'office_retail', event: 'office_retail', hotel: 'hotel_apartment', dining: 'dining' };
// 板块 → 设置里的哪个负责人。
const ASSIGNEE_OF = { office_retail: 'assignee_property', hotel_apartment: 'assignee_hotel', dining: 'assignee_dining' };
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉了容易看混的 i l o 0 1
export const CODE_PATTERN = /^[a-z0-9]{8}$/;
export const MOBILE = /^1[3-9]\d{9}$/;

const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** The address a guest's phone can reach. A fixed public address is configured for production; otherwise the address this request came in on. */
export function publicBase(req, env = process.env) {
  const configured = String(env.HZ_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(configured)) return { base: configured, fixed: true };
  return { base: `${req.protocol}://${req.get('host')}`, fixed: false };
}

/** Whether a scanned code would still work tomorrow, on another network. */
export function addressNote({ base, fixed }) {
  if (fixed) return null;
  const host = new URL(base).hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(host) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)) {
    return '这个二维码里是内部地址，只有连着公司网络的手机才打得开。对外用之前要先有固定的公网地址。';
  }
  if (host.endsWith('.trycloudflare.com')) return '这个二维码里是临时演示地址，演示窗口一关就失效。印出来或发出去之前要先有固定的公网地址。';
  return '这个地址不是在系统里固定配置的，换了地址后旧二维码会失效。';
}

/** The form for one publishing task, created the first time someone asks for its code. */
export async function formForTask(pool, { taskId, user, req, env = process.env }) {
  if (!UUID.test(String(taskId))) throw fail(404, 'TASK_NOT_FOUND', '没有找到这条内容');
  const { rows: [task] } = await pool.query(`
    SELECT t.id, t.platform, t.title, m.topic, m.content_type
    FROM leadgen.publish_tasks t JOIN leadgen.materials m ON m.id = t.material_id WHERE t.id = $1`, [taskId]);
  if (!task) throw fail(404, 'TASK_NOT_FOUND', '没有找到这条内容');
  let { rows: [form] } = await pool.query('SELECT id, code, is_active FROM leadgen.lead_forms WHERE publish_task_id = $1', [taskId]);
  for (let attempt = 0; !form && attempt < 5; attempt += 1) {
    ({ rows: [form] } = await pool.query(`
      INSERT INTO leadgen.lead_forms (code, publish_task_id, sector_key, title, created_by) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING RETURNING id, code, is_active`,
    [newCode(), taskId, SECTOR_OF[task.content_type] || 'office_retail', task.topic.slice(0, 100), user.id]));
    if (!form) ({ rows: [form] } = await pool.query('SELECT id, code, is_active FROM leadgen.lead_forms WHERE publish_task_id = $1', [taskId]));
  }
  if (!form) throw fail(500, 'FORM_CODE_FAILED', '没能生成留资链接，请再试一次');
  const address = publicBase(req, env);
  const url = `${address.base}/f/${form.code}`;
  return {
    code: form.code, url, platform_name: PLATFORM_NAME[task.platform], topic: task.topic, address_note: addressNote(address),
    qr_svg: await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
  };
}

/** What the public page may know about a form: its title and the three sectors. Nothing about the property, prices or staff. */
export async function publicForm(pool, code) {
  if (!CODE_PATTERN.test(String(code))) return null;
  const { rows: [form] } = await pool.query('SELECT title, sector_key FROM leadgen.lead_forms WHERE code = $1 AND is_active', [code]);
  if (!form) return null;
  const { rows: sectors } = await pool.query('SELECT key, name FROM leadgen.sectors ORDER BY sort_order');
  return { title: form.title, sector_key: form.sector_key, sectors };
}

export function parseSubmission(body) {
  const name = String(body?.contact_name || '').trim();
  const phone = String(body?.phone || '').replace(/[\s-]/g, '');
  const need = String(body?.need || '').trim();
  if (!name || name.length > 20) throw fail(400, 'LEAD_NAME_INVALID', '请填写称呼（不超过 20 个字）');
  if (!MOBILE.test(phone)) throw fail(400, 'LEAD_PHONE_INVALID', '请填写 11 位手机号');
  if (need.length > 300) throw fail(400, 'LEAD_NEED_TOO_LONG', '需求说明不超过 300 个字');
  if (body?.consent !== true) throw fail(400, 'LEAD_CONSENT_REQUIRED', '请先勾选同意我们联系您');
  return { name, phone, need: need || null, sector: String(body?.sector_key || '') };
}

/**
 * Stores what the guest typed and puts them in the sector's "待联系" stage. One record per phone number:
 * the same phone coming back is added to the existing customer instead of creating another.
 */
export async function submitLead(pool, { code, body }) {
  // 蜜罐：页面上看不见的一栏，人不会填，自动提交的程序会填。填了就假装成功，什么都不存。
  if (String(body?.website || '').trim()) return { ok: true };
  const input = parseSubmission(body);
  if (!CODE_PATTERN.test(String(code))) throw fail(404, 'FORM_NOT_FOUND', '这个页面已经失效');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [form] } = await client.query(`
      SELECT f.id, f.sector_key, f.publish_task_id, t.platform, m.topic, m.content_type, m.property_id
      FROM leadgen.lead_forms f
      LEFT JOIN leadgen.publish_tasks t ON t.id = f.publish_task_id
      LEFT JOIN leadgen.materials m ON m.id = t.material_id
      WHERE f.code = $1 AND f.is_active`, [code]);
    if (!form) throw fail(404, 'FORM_NOT_FOUND', '这个页面已经失效');
    const { rows: sectors } = await client.query('SELECT key, name FROM leadgen.sectors');
    const sector = sectors.find(row => row.key === input.sector) || sectors.find(row => row.key === form.sector_key);
    const { rows: [settings] } = await client.query('SELECT assignee_property, assignee_hotel, assignee_dining FROM leadgen.inbox_settings WHERE id = 1');
    const owner = settings?.[ASSIGNEE_OF[sector.key]] ?? null;

    const { rows: [existing] } = await client.query(`SELECT id FROM leadgen.companies WHERE source = 'lead_form' AND source_ref = $1`, [input.phone]);
    const companyId = existing?.id ?? (await client.query(`
      INSERT INTO leadgen.companies (company_name, source, source_ref, phone, data_origin, qualification_status, company_description)
      VALUES ($1, 'lead_form', $2, $2, 'form_lead', 'qualified', '客人扫码填表主动留下的联系方式') RETURNING id`,
    [`${input.name}（扫码留资）`, input.phone])).rows[0].id;
    const { rows: [track] } = await client.query(`
      INSERT INTO leadgen.company_sector_tracks (company_id, sector_key, stage, owner_user_id, intended_property_id, contact_name, contact_phone)
      VALUES ($1, $2, 'new', $3, $4, $5, $6)
      ON CONFLICT (company_id, sector_key) DO UPDATE SET updated_at = now(),
        contact_name = COALESCE(leadgen.company_sector_tracks.contact_name, EXCLUDED.contact_name),
        contact_phone = COALESCE(leadgen.company_sector_tracks.contact_phone, EXCLUDED.contact_phone)
      RETURNING id, (xmax = 0) AS inserted`,
    [companyId, sector.key, owner, sector.key === 'office_retail' && form.content_type === 'property' ? form.property_id : null, input.name, input.phone]);
    const source = form.publish_task_id ? `${PLATFORM_NAME[form.platform]}《${form.topic}》` : '通用留资页';
    await client.query(`INSERT INTO leadgen.activities (track_id, activity_type, content) VALUES ($1, 'note', $2)`,
      [track.id, [`来源：扫码留资（${source}）`, `称呼：${input.name}`, `电话：${input.phone}`, input.need ? `需求：${input.need}` : null].filter(Boolean).join('\n')]);
    await client.query(`
      INSERT INTO leadgen.lead_submissions (form_id, contact_name, phone, need, sector_key, source_platform, source_topic, publish_task_id, company_id, track_id, merged, consent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
    [form.id, input.name, input.phone, input.need, sector.key, form.platform ?? null, form.topic ?? null, form.publish_task_id, companyId, track.id, !track.inserted]);
    await client.query(`
      INSERT INTO leadgen.notifications (recipient_user_id, recipient_role, kind, title, body, link)
      VALUES ($1, $2, 'lead', $3, $4, $5)`,
    [owner, owner ? null : 'admin', `有人扫码留了联系方式（${sector.name}）`, `${input.name}，来自${source}${input.need ? `：${input.need.slice(0, 40)}` : ''}`, `/company.html?id=${companyId}`]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Submissions for the sectors this account looks after, newest first. */
export async function listSubmissions(pool, { sectors, limit = 50, offset = 0 }) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pool.query(`
    SELECT s.id, s.contact_name, s.phone, s.need, s.sector_key, k.name AS sector_name, s.source_platform, s.source_topic, s.merged, s.created_at,
           s.company_id, t.stage, u.display_name AS owner_name, count(*) OVER()::int AS total
    FROM leadgen.lead_submissions s
    JOIN leadgen.sectors k ON k.key = s.sector_key
    LEFT JOIN leadgen.company_sector_tracks t ON t.id = s.track_id
    LEFT JOIN leadgen.users u ON u.id = t.owner_user_id
    WHERE s.sector_key = ANY($1)
    ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`, [sectors, size, Math.max(Number(offset) || 0, 0)]);
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total, ...row }) => ({ ...row, source_name: row.source_platform ? `${PLATFORM_NAME[row.source_platform]}《${row.source_topic}》` : '通用留资页' }))
  };
}
