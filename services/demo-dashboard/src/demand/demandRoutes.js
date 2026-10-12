import express from 'express';
import {
  closeDemand, convertDemand, draftContact, getDemandSettings, listDemand, recordContact, requestSearch, screenPending, updateDemandSettings
} from './demandService.js';

export function createDemandRouter({ pool, auth, llm }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];
  const admin = [auth.authenticate, auth.requireRoles('ADMIN')];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

  router.get('/posts', ...read, handle(async (req, res) => {
    res.json({ model_ready: llm.configured, ...await listDemand(pool, { view: req.query.view || 'open', user: req.managementUser, limit: req.query.limit, offset: req.query.offset }) });
  }));
  router.post('/posts/:postId/convert', ...write, handle(async (req, res) => {
    res.json(await convertDemand(pool, { postId: req.params.postId, sector: req.body?.sector || null, user: req.managementUser }));
  }));
  router.post('/posts/:postId/close', ...write, handle(async (req, res) => {
    res.json(await closeDemand(pool, { postId: req.params.postId, reason: req.body?.reason, user: req.managementUser }));
  }));
  router.post('/posts/:postId/draft', ...write, handle(async (req, res) => {
    res.json(await draftContact(pool, { postId: req.params.postId, llm }));
  }));
  router.post('/posts/:postId/contact', ...write, handle(async (req, res) => {
    res.json(await recordContact(pool, { postId: req.params.postId, text: req.body?.text, accountId: req.body?.account_id, user: req.managementUser }));
  }));

  router.get('/settings', ...read, handle(async (_req, res) => res.json(await getDemandSettings(pool))));
  router.put('/settings', ...admin, handle(async (req, res) => res.json(await updateDemandSettings(pool, req.body || {}, req.managementUser))));
  // “现在搜一次”：搜索程序下一次看的时候就跑；顺手把还没筛的筛掉几条。
  router.post('/search', ...write, handle(async (_req, res) => {
    const result = await requestSearch(pool);
    await screenPending(pool, { llm, limit: 5 });
    res.json(result);
  }));

  return router;
}
