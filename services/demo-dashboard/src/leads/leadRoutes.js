import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { visibleSectors } from '../overview/overviewService.js';
import { formForTask, listSubmissions, publicForm, submitLead } from './leadService.js';

const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

/**
 * The only part of the system open to people who are not signed in: the form page a guest reaches by scanning a code,
 * what that page needs to draw itself, and the submission. Mounted before the sign-in wall.
 */
export function createPublicLeadRouter({ pool, formPage }) {
  const router = express.Router();
  // 一个地址 10 分钟内最多提交 5 次；看表单本身宽松一些。
  const submitLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: '提交太频繁了，请过十分钟再试', code: 'TOO_MANY_SUBMISSIONS' })
  });
  const viewLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

  router.get('/f/:code', viewLimiter, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(formPage);
  });
  router.get('/api/public/forms/:code', viewLimiter, handle(async (req, res) => {
    const form = await publicForm(pool, req.params.code);
    if (!form) return res.status(404).json({ error: '这个页面已经失效', code: 'FORM_NOT_FOUND' });
    res.json(form);
  }));
  router.post('/api/public/forms/:code', submitLimiter, handle(async (req, res) => {
    // 正常的一次提交只有几百个字节。
    if (Number(req.get('content-length') || 0) > 4096) return res.status(413).json({ error: '内容太长了', code: 'SUBMISSION_TOO_LARGE' });
    res.status(201).json(await submitLead(pool, { code: req.params.code, body: req.body }));
  }));
  return router;
}

export function createLeadRouter({ pool, auth }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];

  router.get('/leads/submissions', ...read, handle(async (req, res) => {
    const sectors = visibleSectors(req.managementUser, req.query.sector);
    if (!sectors) return res.status(403).json({ error: '当前账号不负责这个板块', code: 'SECTOR_FORBIDDEN' });
    res.json(await listSubmissions(pool, { sectors, limit: req.query.limit, offset: req.query.offset }));
  }));

  router.post('/publishing/tasks/:taskId/lead-form', ...write, handle(async (req, res) => {
    res.json(await formForTask(pool, { taskId: req.params.taskId, user: req.managementUser, req }));
  }));
  return router;
}
