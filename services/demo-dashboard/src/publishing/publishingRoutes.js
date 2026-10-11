import express from 'express';
import multer from 'multer';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CONTENT_TYPES, PLATFORMS } from './copywriter.js';
import {
  MAX_IMAGES, MAX_VIDEOS, addAccount, calendarTasks, confirmTask, requestLogin, createMaterial, generateDrafts, getMaterial, listAccounts, listMaterials,
  listVersions, markRemoved, updateAccount, updateDraft, withdrawTask
} from './publishingService.js';

const MAX_FILE_BYTES = 500 * 1024 * 1024;

export function createPublishingRouter({ pool, auth, llm, mediaDir }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];
  const admin = [auth.authenticate, auth.requireRoles('ADMIN')];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  const upload = multer({
    dest: path.join(tmpdir(), 'hz-uploads'),
    limits: { files: MAX_IMAGES + MAX_VIDEOS, fileSize: MAX_FILE_BYTES, fields: 20 }
  }).array('files', MAX_IMAGES + MAX_VIDEOS);
  const receive = (req, res, next) => upload(req, res, error => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? '单个文件不能超过 500 MB'
      : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? `最多 ${MAX_IMAGES} 张图片加 ${MAX_VIDEOS} 个视频` : '文件没有传上来，请重试';
    res.status(400).json({ error: message, code: 'MATERIAL_UPLOAD_FAILED' });
  });

  router.get('/options', ...read, handle(async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT id, building, floor, unit_no, property_type, area_sqm::float AS area_sqm FROM leadgen.properties
      WHERE status <> 'signed' ORDER BY property_type DESC, building, floor, unit_no`);
    res.json({
      platforms: Object.entries(PLATFORMS).map(([key, spec]) => ({ key, label: spec.label })),
      content_types: Object.entries(CONTENT_TYPES).map(([key, type]) => ({ key, label: type.label })),
      properties: rows, model_ready: llm.configured, max_images: MAX_IMAGES
    });
  }));

  router.get('/materials', ...read, handle(async (req, res) => {
    res.json(await listMaterials(pool, { limit: req.query.limit, offset: req.query.offset, mine: req.query.mine === '1' ? req.managementUser.id : null }));
  }));
  router.post('/materials', ...write, receive, handle(async (req, res) => {
    res.status(201).json(await createMaterial(pool, { user: req.managementUser, body: req.body, files: req.files || [], mediaDir }));
  }));
  router.get('/materials/:materialId', ...read, handle(async (req, res) => res.json(await getMaterial(pool, req.params.materialId))));
  router.post('/materials/:materialId/drafts', ...write, handle(async (req, res) => {
    res.json(await generateDrafts(pool, { materialId: req.params.materialId, platform: req.body?.platform || null, user: req.managementUser, llm }));
  }));

  router.put('/tasks/:taskId', ...write, handle(async (req, res) => {
    res.json(await updateDraft(pool, { taskId: req.params.taskId, user: req.managementUser, input: req.body || {} }));
  }));
  router.post('/tasks/:taskId/confirm', ...write, handle(async (req, res) => {
    res.json(await confirmTask(pool, { taskId: req.params.taskId, user: req.managementUser, scheduledAt: req.body?.scheduled_at || null }));
  }));
  router.post('/tasks/:taskId/removed', ...write, handle(async (req, res) => res.json(await markRemoved(pool, { taskId: req.params.taskId, note: req.body?.note }))));
  router.post('/tasks/:taskId/withdraw', ...write, handle(async (req, res) => res.json(await withdrawTask(pool, { taskId: req.params.taskId }))));
  router.get('/tasks/:taskId/versions', ...read, handle(async (req, res) => res.json(await listVersions(pool, req.params.taskId))));

  router.get('/accounts', ...read, handle(async (_req, res) => res.json(await listAccounts(pool))));
  router.post('/accounts', ...write, handle(async (req, res) => res.status(201).json(await addAccount(pool, req.body || {}))));
  router.post('/accounts/:accountId/login', ...write, handle(async (req, res) => {
    res.status(202).json(await requestLogin(pool, { accountId: req.params.accountId, user: req.managementUser }));
  }));
  router.get('/calendar', ...read, handle(async (req, res) => res.json(await calendarTasks(pool, req.query.month))));
  router.patch('/accounts/:accountId', ...admin, handle(async (req, res) => {
    await updateAccount(pool, req.params.accountId, req.body || {});
    res.status(204).end();
  }));

  return router;
}
