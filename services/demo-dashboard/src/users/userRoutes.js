import express from 'express';
import { createUser, listUsers, resetPassword, updateUser } from './userService.js';

const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

/** 人员和权限，只有系统负责人能用。新密码只在返回里出现一次，不缓存。 */
export function createUserRouter({ pool, auth, credentialsFile = null }) {
  const router = express.Router();
  const admin = [auth.authenticate, auth.requireRoles('ADMIN')];
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

  router.get('/', ...admin, handle(async (req, res) => res.json(await listUsers(pool, { actor: req.managementUser }))));
  router.post('/', ...admin, noStore, handle(async (req, res) => {
    res.status(201).json(await createUser(pool, { input: req.body || {}, credentialsFile, actor: req.managementUser }));
  }));
  router.patch('/:userId', ...admin, handle(async (req, res) => {
    res.json(await updateUser(pool, { userId: req.params.userId, input: req.body || {}, actor: req.managementUser }));
  }));
  router.post('/:userId/password', ...admin, noStore, handle(async (req, res) => {
    res.json(await resetPassword(pool, {
      userId: req.params.userId, credentialsFile, actor: req.managementUser, keepSessionId: req.sessionID ?? null
    }));
  }));
  return router;
}
