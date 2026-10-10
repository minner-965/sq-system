import express from 'express';
import { canSeeFloorPrice } from '../auth/managementAuth.js';

const PROPERTY_TYPES = new Set(['office', 'retail']);
const PROPERTY_STATUSES = new Set(['available', 'negotiating', 'signed']);

const POLICY_COLUMNS = `property_type, list_rent_per_sqm, list_management_fee_per_sqm, min_lease_years, deposit_months,
  payment_cycle_months, annual_increase_pct, rent_free_days_min, rent_free_days_max, updated_at`;

/**
 * The floor price column is only ever selected for administrators, so no
 * other role's response can carry it.
 */
export async function listLeasingPolicy(pool, user) {
  const columns = canSeeFloorPrice(user) ? `${POLICY_COLUMNS}, floor_price_per_sqm` : POLICY_COLUMNS;
  const { rows } = await pool.query(`SELECT ${columns} FROM leadgen.leasing_policy ORDER BY property_type`);
  return rows;
}

export async function listProperties(pool, { type, status, building } = {}) {
  const { rows } = await pool.query(`
    SELECT id, building, floor, unit_no, property_type, area_sqm, list_rent_per_sqm, management_fee_per_sqm,
           delivery_standard, fit_out, partition_rooms, workstations, allows_open_flame, allows_catering, has_exhaust,
           CASE WHEN floor_plan_file IS NOT NULL THEN '/media/' || floor_plan_file END AS floor_plan_url,
           status, remark, updated_at
    FROM leadgen.properties
    WHERE ($1::text IS NULL OR property_type = $1)
      AND ($2::text IS NULL OR status = $2)
      AND ($3::text IS NULL OR building = $3)
    ORDER BY property_type DESC, building, floor, unit_no`,
  [type ?? null, status ?? null, building ?? null]);
  return rows;
}

export function createLeasingRouter({ pool, auth }) {
  const router = express.Router();
  const read = [auth.authenticate, auth.requireRoles('ADMIN', 'BOSS', 'LEASING')];

  router.get('/properties', ...read, async (req, res, next) => {
    try {
      const { type, status, building } = req.query;
      if (type !== undefined && !PROPERTY_TYPES.has(type)) return res.status(400).json({ code: 'PROPERTY_TYPE_INVALID' });
      if (status !== undefined && !PROPERTY_STATUSES.has(status)) return res.status(400).json({ code: 'PROPERTY_STATUS_INVALID' });
      const items = await listProperties(pool, { type, status, building: building === undefined ? undefined : String(building) });
      res.json({ total: items.length, items });
    } catch (error) { next(error); }
  });

  router.get('/properties/summary', ...read, async (_req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT property_type, status, count(*)::int AS units, sum(area_sqm)::float AS area_sqm
        FROM leadgen.properties GROUP BY property_type, status ORDER BY property_type DESC, status`);
      res.json({ items: rows });
    } catch (error) { next(error); }
  });

  router.get('/leasing-policy', ...read, async (req, res, next) => {
    try { res.json({ items: await listLeasingPolicy(pool, req.managementUser) }); } catch (error) { next(error); }
  });

  router.get('/project-profile', ...read, async (_req, res, next) => {
    try {
      const { rows } = await pool.query(`
        SELECT name, address, target_industries, electricity_fee_per_kwh, water_fee_per_ton, fees_include_tax,
               parking_monthly_fee, parking_hourly_fee, parking_free_hours, retail_delivery_standard,
               office_delivery_standard, transport_notes, updated_at
        FROM leadgen.project_profile WHERE id = 1`);
      res.json(rows[0] ?? null);
    } catch (error) { next(error); }
  });

  return router;
}
