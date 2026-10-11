import express from 'express';
import { visibleSectors } from '../overview/overviewService.js';
import { buildReportWorkbook, getReport } from './reportService.js';

const SECTOR_NAME = { all: '全部板块', office_retail: '商铺写字楼', hotel_apartment: '酒店公寓', dining: '自营餐饮' };

export function createReportRouter({ pool, auth }) {
  const router = express.Router();
  const read = [auth.authenticate];
  const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  const scope = (req, res) => {
    const sectors = visibleSectors(req.managementUser, req.query.sector);
    if (!sectors) res.status(403).json({ error: '当前账号不负责这个板块', code: 'SECTOR_FORBIDDEN' });
    return sectors;
  };
  const period = req => ({ ...(req.query.from ? { from: String(req.query.from) } : {}), ...(req.query.to ? { to: String(req.query.to) } : {}) });

  router.get('/reports', ...read, handle(async (req, res) => {
    const sectors = scope(req, res);
    if (sectors) res.json(await getReport(pool, { user: req.managementUser, sectors, query: period(req) }));
  }));

  router.get('/reports/export', ...read, handle(async (req, res) => {
    const sectors = scope(req, res);
    if (!sectors) return;
    const report = await getReport(pool, { user: req.managementUser, sectors, query: period(req) });
    const buffer = await buildReportWorkbook(report, { sectorName: SECTOR_NAME[req.query.sector] || SECTOR_NAME.all });
    const name = `恒兆广场招商报表_${report.period.from}_${report.period.to}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="report_${report.period.from}_${report.period.to}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store'
    });
    res.send(buffer);
  }));
  return router;
}
