import express from 'express';
import { visibleSectors } from '../overview/overviewService.js';
import {
  addActivity, getCompanyProfile, listCustomers, listNotifications, listOwners, markNotificationsRead,
  matchProperties, updateTrack
} from './customerService.js';

export function createCustomerRouter({ pool, auth }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

  router.get('/customers', ...read, handle(async (req, res) => {
    const sectors = visibleSectors(req.managementUser, req.query.sector);
    if (!sectors) return res.status(403).json({ error: '当前账号不负责这个板块', code: 'SECTOR_FORBIDDEN' });
    res.json(await listCustomers(pool, {
      user: req.managementUser, sectors, stage: req.query.stage || null, mine: req.query.mine === '1',
      search: String(req.query.q || '').trim().slice(0, 50) || null, limit: req.query.limit, offset: req.query.offset
    }));
  }));

  router.get('/companies/:companyId/profile', ...read, handle(async (req, res) => {
    res.json(await getCompanyProfile(pool, { companyId: req.params.companyId, user: req.managementUser }));
  }));

  router.patch('/tracks/:trackId', ...write, handle(async (req, res) => {
    res.json(await updateTrack(pool, { trackId: req.params.trackId, user: req.managementUser, changes: req.body || {} }));
  }));

  router.post('/tracks/:trackId/activities', ...write, handle(async (req, res) => {
    res.status(201).json(await addActivity(pool, {
      trackId: req.params.trackId, user: req.managementUser, type: req.body?.type, content: req.body?.content, occurredAt: req.body?.occurred_at
    }));
  }));

  router.get('/tracks/:trackId/matches', ...read, handle(async (req, res) => {
    res.json(await matchProperties(pool, { trackId: req.params.trackId, user: req.managementUser }));
  }));

  router.get('/sectors/:sectorKey/owners', ...read, handle(async (req, res) => {
    if (!req.managementUser.sectors.includes(req.params.sectorKey)) return res.status(403).json({ error: '当前账号不负责这个板块', code: 'SECTOR_FORBIDDEN' });
    res.json({ items: await listOwners(pool, req.params.sectorKey) });
  }));

  router.get('/notifications', ...read, handle(async (req, res) => res.json(await listNotifications(pool, req.managementUser))));
  router.post('/notifications/read', ...read, handle(async (req, res) => {
    await markNotificationsRead(pool, req.managementUser);
    res.status(204).end();
  }));

  return router;
}
