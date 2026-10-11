import express from 'express';
import { visibleSectors } from '../overview/overviewService.js';
import { PLANNED_PROVIDERS } from './providers/index.js';
import {
  createRun, getSettings, listCandidates, recentRuns, reviewCandidate, updateSettings, usageSummary
} from './discoveryService.js';

export function createDiscoveryRouter({ pool, auth, providers, llm, enqueueRun }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const write = [auth.authenticate, auth.requireWrite];
  const admin = [auth.authenticate, auth.requireRoles('ADMIN')];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };

  router.get('/candidates', ...read, handle(async (req, res) => {
    const sectors = visibleSectors(req.managementUser, req.query.sector);
    if (!sectors) return res.status(403).json({ error: '当前账号不负责这个板块', code: 'SECTOR_FORBIDDEN' });
    res.json(await listCandidates(pool, {
      sectors, status: req.query.status || 'pending', search: String(req.query.q || '').trim().slice(0, 50) || null,
      limit: req.query.limit, offset: req.query.offset
    }));
  }));

  router.post('/candidates/:candidateId/review', ...write, handle(async (req, res) => {
    res.json(await reviewCandidate(pool, {
      candidateId: req.params.candidateId, decision: req.body?.decision, reason: req.body?.reason, user: req.managementUser
    }));
  }));

  router.get('/status', ...read, handle(async (_req, res) => {
    res.json({
      providers: [
        { name: 'amap', label: '高德地图', purpose: '周边企业', connected: providers.amap.configured },
        { name: 'baidu_search', label: '百度搜索', purpose: '需求信号', connected: providers.baiduSearch.configured },
        { name: llm.provider, label: '大模型', purpose: '判断搜索结果', connected: llm.configured },
        ...PLANNED_PROVIDERS.map(provider => ({ ...provider, connected: false }))
      ],
      runs: await recentRuns(pool),
      usage: await usageSummary(pool)
    });
  }));

  router.post('/runs', ...write, handle(async (req, res) => {
    if (!providers.amap.configured) return res.status(409).json({ error: '还没有配置高德 Key，无法检索', code: 'AMAP_KEY_MISSING' });
    const runId = await createRun(pool, { trigger: 'manual', userId: req.managementUser.id });
    try { await enqueueRun(runId); }
    catch (error) {
      await pool.query(`UPDATE leadgen.discovery_runs SET status = 'failed', error_message = '没有排上队', finished_at = now() WHERE id = $1`, [runId]);
      throw error;
    }
    res.status(202).json({ id: runId, status: 'queued' });
  }));

  router.get('/settings', ...admin, handle(async (_req, res) => res.json(await getSettings(pool))));
  router.put('/settings', ...admin, handle(async (req, res) => res.json(await updateSettings(pool, req.body || {}, req.managementUser.id))));

  return router;
}
