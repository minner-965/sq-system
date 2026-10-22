import express from 'express';
import { phonePanel, requestPhoneCheck, setPhoneSwitch } from './phoneService.js';

/** 专用手机：状态和测试结果谁都能看；“测试一下”要能写的账号；两个开关只有管理员能动。 */
export function createPhoneRouter({ pool, auth }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];
  const admin = [auth.authenticate, auth.requireRoles('ADMIN')];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

  router.get('/', ...read, handle(async (_req, res) => res.json(await phonePanel(pool))));
  router.post('/checks', ...write, handle(async (req, res) => {
    res.status(202).json(await requestPhoneCheck(pool, { app: req.body?.app, user: req.managementUser }));
  }));
  router.put('/switches/:feature', ...admin, handle(async (req, res) => {
    res.json(await setPhoneSwitch(pool, { feature: req.params.feature, enabled: req.body?.enabled, user: req.managementUser }));
  }));
  return router;
}
