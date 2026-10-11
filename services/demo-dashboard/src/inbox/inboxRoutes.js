import express from 'express';
import {
  INTENTS, addManualMessage, changeIntent, checkStatus, requestCheck, classifyPending, confirmReply, convertToLead, draftReply, getInboxSettings,
  inboxSummary, listInbox, setStatus, updateInboxSettings
} from './inboxService.js';

export function createInboxRouter({ pool, auth, llm }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];
  const admin = [auth.authenticate, auth.requireRoles('ADMIN')];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

  router.get('/summary', ...read, handle(async (req, res) => {
    const since = req.query.since && !Number.isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : null;
    res.json(await inboxSummary(pool, { since }));
  }));
  router.get('/messages', ...read, handle(async (req, res) => {
    res.json({
      intents: Object.entries(INTENTS).map(([key, intent]) => ({ key, label: intent.label })),
      model_ready: llm.configured,
      ...await listInbox(pool, { status: req.query.status || 'new', user: req.managementUser, mine: req.query.mine === '1', limit: req.query.limit, offset: req.query.offset })
    });
  }));
  router.post('/messages', ...write, handle(async (req, res) => {
    const message = await addManualMessage(pool, { input: req.body || {}, user: req.managementUser });
    // 手工录入的马上分类，不等每分钟一次的后台任务。
    await classifyPending(pool, { llm, limit: 5 });
    res.status(201).json(message);
  }));
  router.put('/messages/:messageId/intent', ...write, handle(async (req, res) => {
    res.json(await changeIntent(pool, { messageId: req.params.messageId, intent: req.body?.intent, user: req.managementUser }));
  }));
  router.put('/messages/:messageId/status', ...write, handle(async (req, res) => {
    res.json(await setStatus(pool, { messageId: req.params.messageId, status: req.body?.status, user: req.managementUser }));
  }));
  router.post('/messages/:messageId/reply-draft', ...write, handle(async (req, res) => {
    res.json(await draftReply(pool, { messageId: req.params.messageId, llm }));
  }));
  router.post('/messages/:messageId/reply', ...write, handle(async (req, res) => {
    res.json(await confirmReply(pool, { messageId: req.params.messageId, text: req.body?.text, manual: req.body?.manual === true, user: req.managementUser }));
  }));
  router.post('/messages/:messageId/lead', ...write, handle(async (req, res) => {
    res.json(await convertToLead(pool, { messageId: req.params.messageId, user: req.managementUser }));
  }));

  router.get('/check', ...read, handle(async (_req, res) => res.json(await checkStatus(pool))));
  router.post('/check', ...write, handle(async (req, res) => res.status(202).json(await requestCheck(pool, { user: req.managementUser }))));

  router.get('/settings', ...admin, handle(async (_req, res) => res.json(await getInboxSettings(pool))));
  router.put('/settings', ...admin, handle(async (req, res) => res.json(await updateInboxSettings(pool, req.body || {}))));

  return router;
}
