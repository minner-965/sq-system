import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { validateDetailId } from './httpIdValidation.js';
import { maintenanceReadOnly, maintenanceWriteGuard } from './maintenanceMode.js';
import { createTelemetryService, instrumentPgPool } from './observability/telemetry.js';
import { createPhase5Queue, PHASE5_QUEUES } from './jobs/phase5Queue.js';
import { ScoringService } from './scoring/scoringService.js';
import { createManagementAuth } from './auth/managementAuth.js';
import { AutomationControlService } from './automation/AutomationControlService.js';

const { Pool } = pg;
const app = express();
app.param(['id'], validateDetailId);
const port = Number(process.env.PORT || 3000);
const httpListenEnabled = !/^(0|false|no|off)$/i.test(process.env.HTTP_LISTEN_ENABLED || 'true');
const maintenanceMode = maintenanceReadOnly();
if (maintenanceMode && !httpListenEnabled) throw new Error('Read-only maintenance is an HTTP-only mode');
app.use(maintenanceWriteGuard(maintenanceMode));

const managementAuth = createManagementAuth(process.env);
const telemetry = createTelemetryService({
  enabled: /^(1|true|yes|on)$/i.test(process.env.OTEL_ENABLED || ''),
  serviceName: 'hz-leasing-app'
});
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'leadgen',
  user: process.env.POSTGRES_USER || 'leadgen',
  password: process.env.POSTGRES_PASSWORD,
  ...(maintenanceMode ? { options: '-c default_transaction_read_only=on' } : {}),
});
instrumentPgPool(pool, telemetry);

const scoringService = new ScoringService({ pool });
const automationControls = new AutomationControlService({ pool });

function audit(event, fields = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

async function scoreCompany(data, job) {
  if (!data.company_id) throw Object.assign(new Error('company_id is required'), { code: 'SCORE_SCOPE_REQUIRED' });
  const run = await scoringService.scoreCompany({
    companyId: data.company_id,
    executionKey: job?.id ? `${job.id}:${data.company_id}` : null
  });
  return { processed: 1, score_run_ids: [run.id] };
}

const jobQueue = createPhase5Queue({
  telemetry,
  audit,
  handlers: {
    [PHASE5_QUEUES.SCORE_COMPANY]: scoreCompany,
    [PHASE5_QUEUES.REPLAY_RULE_VERSION]: scoreCompany
  }
});

app.use((_req, res, next) => {
  // Business state changes between requests; never serve it from a cache.
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16mb' }));
app.use('/vendor/tabler', express.static(new URL('../node_modules/@tabler/core/dist', import.meta.url).pathname));
app.use('/vendor/tabler-icons', express.static(new URL('../node_modules/@tabler/icons-webfont/dist', import.meta.url).pathname));
app.use(express.static(new URL('../public', import.meta.url).pathname));

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const queue = await jobQueue.health();
    res.json({ status: 'ok', database: 'ready', jobs: queue.status });
  } catch (error) { res.status(503).json({ status: 'error', error: error.message }); }
});

const controlRead = [managementAuth.authenticate, managementAuth.requireRoles('MANAGEMENT', 'DATA_ADMIN', 'SALES')];
const controlWrite = [managementAuth.authenticate, managementAuth.requireRoles('MANAGEMENT', 'DATA_ADMIN')];

app.get('/api/automation/controls/:key', ...controlRead, async (req, res, next) => {
  try { res.json(await automationControls.get(req.params.key)); } catch (error) { next(error); }
});
app.put('/api/automation/controls/:key', ...controlWrite, async (req, res, next) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ code: 'AUTOMATION_ENABLED_REQUIRED' });
    const event = await automationControls.set({
      controlKey: req.params.key,
      enabled: req.body.enabled,
      settings: req.body.settings || {},
      actor: req.managementUser.identity,
      reason: String(req.body.reason || (req.body.enabled ? 'Enabled by management' : 'Paused by management')),
      idempotencyKey: String(req.get('idempotency-key') || randomUUID())
    });
    audit('AUTOMATION_CONTROL_CHANGED', { control_key: event.control_key, enabled: event.enabled, actor: event.actor });
    res.json(event);
  } catch (error) { next(error); }
});

app.get('/api/companies/:id/score', async (req, res, next) => {
  try {
    const latest = await scoringService.getLatest(req.params.id);
    if (!latest) return res.status(404).json({ error: 'Score not found', code: 'SCORE_NOT_FOUND' });
    res.json(latest);
  } catch (error) { next(error); }
});
app.get('/api/companies/:id/score-history', async (req, res, next) => {
  try { res.json({ items: await scoringService.getHistory(req.params.id, { limit: Number(req.query.limit) || 50 }) }); }
  catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const notFoundCodes = new Set(['COMPANY_NOT_FOUND']);
  const badRequestCodes = new Set(['SCORE_SCOPE_REQUIRED']);
  const declaredStatus = Number(error.status);
  const status = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
    ? declaredStatus : badRequestCodes.has(error.code) ? 400 : notFoundCodes.has(error.code) ? 404 : 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message, code: error.code || undefined });
});

async function start() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try { await pool.query('SELECT 1'); break; }
    catch (error) {
      if (attempt === 30) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (maintenanceMode) {
    const readOnlyServer = app.listen(port, '0.0.0.0', () => console.log(`Read-only app listening on ${port}`));
    const stop = async () => { readOnlyServer.close(); await telemetry.shutdown(); await pool.end(); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    return;
  }
  await jobQueue.start();
  const server = httpListenEnabled
    ? app.listen(port, '0.0.0.0', () => console.log(`App listening on ${port}`))
    : null;
  if (!httpListenEnabled) console.log('Worker started without an HTTP listener');
  const shutdown = async signal => {
    audit('application_shutdown', { signal });
    server?.close();
    await jobQueue.stop();
    await telemetry.shutdown();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start().catch(error => { console.error(error); process.exit(1); });
