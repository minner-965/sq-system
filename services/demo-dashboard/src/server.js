import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDetailId } from './httpIdValidation.js';
import { maintenanceReadOnly, maintenanceWriteGuard } from './maintenanceMode.js';
import { createTelemetryService, instrumentPgPool } from './observability/telemetry.js';
import { createPhase5Queue, PHASE5_QUEUES } from './jobs/phase5Queue.js';
import { ScoringService } from './scoring/scoringService.js';
import { createSessionAuth } from './auth/sessionAuth.js';
import { AutomationControlService } from './automation/AutomationControlService.js';
import { poolConfig } from './db/pool.js';
import { runMigrations } from './db/migrator.js';
import { createLeasingRouter } from './leasing/leasingRoutes.js';
import { getOverview } from './overview/overviewService.js';
import { createProviders } from './discovery/providers/index.js';
import { createRun, getSettings, runDiscovery } from './discovery/discoveryService.js';
import { createDiscoveryRouter } from './discovery/discoveryRoutes.js';
import { createCustomerRouter } from './customers/customerRoutes.js';
import { createLeadRouter, createPublicLeadRouter } from './leads/leadRoutes.js';
import { createReportRouter } from './reports/reportRoutes.js';
import { createLlmClient } from './llm/llmClient.js';
import { createPublishingRouter } from './publishing/publishingRoutes.js';
import { createInboxRouter } from './inbox/inboxRoutes.js';
import { createDemandRouter } from './demand/demandRoutes.js';
import { createHotelRouter } from './hotels/hotelRoutes.js';
import { screenPending } from './demand/demandService.js';
import { classifyPending } from './inbox/inboxService.js';

const { Pool } = pg;
const app = express();
app.param(['id'], validateDetailId);
const port = Number(process.env.PORT || 3000);
const httpListenEnabled = !/^(0|false|no|off)$/i.test(process.env.HTTP_LISTEN_ENABLED || 'true');
const maintenanceMode = maintenanceReadOnly();
if (maintenanceMode && !httpListenEnabled) throw new Error('Read-only maintenance is an HTTP-only mode');
app.use(maintenanceWriteGuard(maintenanceMode));

const telemetry = createTelemetryService({
  enabled: /^(1|true|yes|on)$/i.test(process.env.OTEL_ENABLED || ''),
  serviceName: 'hz-leasing-app'
});
const pool = new Pool({
  ...poolConfig(),
  ...(maintenanceMode ? { options: `${poolConfig().options} -c default_transaction_read_only=on` } : {}),
});
instrumentPgPool(pool, telemetry);

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const mediaDir = process.env.HZ_MEDIA_DIR || path.join(process.env.DPV_PROJECT_ROOT || fileURLToPath(new URL('../../..', import.meta.url)), 'data', 'media');

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

const providers = createProviders();
const llm = createLlmClient();

// 手动检索带着 run_id 进来；每天定时的那次没有，在这里建记录。
async function discoverCompanies(data) {
  let runId = data.run_id;
  if (!runId) {
    if (!providers.amap.configured || !(await getSettings(pool)).daily_run_enabled) return { skipped: true };
    runId = await createRun(pool, { trigger: 'scheduled' });
  }
  const totals = await runDiscovery(pool, { runId, provider: providers.amap, search: providers.baiduSearch, llm, log: line => audit('discovery', { run_id: runId, detail: line }) });
  audit('discovery_completed', { run_id: runId, ...totals });
  return totals;
}

const jobQueue = createPhase5Queue({
  telemetry,
  audit,
  handlers: {
    [PHASE5_QUEUES.SCORE_COMPANY]: scoreCompany,
    [PHASE5_QUEUES.REPLAY_RULE_VERSION]: scoreCompany,
    [PHASE5_QUEUES.DISCOVER_COMPANIES]: discoverCompanies,
    // 读取程序写进来的评论和私信，每分钟分一次类。
    // 同一趟里把搜索程序找到的帖子也筛一遍。
    [PHASE5_QUEUES.CLASSIFY_INTERACTIONS]: async () => { await classifyPending(pool, { llm }); await screenPending(pool, { llm }); }
  }
});

app.use((_req, res, next) => {
  // Business state changes between requests; never serve it from a cache.
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16mb' }));

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const queue = await jobQueue.health();
    res.json({ status: 'ok', database: 'ready', jobs: queue.status });
  } catch (error) { res.status(503).json({ status: 'error', error: error.message }); }
});

// The worker has no HTTP listener, so it mounts no pages, sessions or business routes.
if (httpListenEnabled) mountWorkspace(createSessionAuth({ pool }));

function mountWorkspace(auth) {
  // Behind Docker's network and, for the public demo, the cloudflared tunnel.
  app.set('trust proxy', 'loopback, uniquelocal');
  // 留资页是唯一不用登录的入口：客人扫码打开、填表、提交。放在登录这道墙前面，只暴露这三个地址。
  app.use(auth.sameOriginWrites, createPublicLeadRouter({ pool, formPage: path.join(publicDir, 'lead-form.html') }));
  app.use(auth.sessionMiddleware);
  app.use(auth.sameOriginWrites);
  app.use('/api/auth', auth.router);

  // Only the login page and the shared assets are reachable without signing in.
  app.get('/login.html', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.use('/assets', express.static(path.join(publicDir, 'assets')));
  app.use('/vendor/chartjs', auth.requirePageSession, express.static(fileURLToPath(new URL('../node_modules/chart.js/dist', import.meta.url))));
  app.use('/media', auth.requirePageSession, express.static(mediaDir));

  const signedIn = [auth.authenticate];
  const controlWrite = [auth.authenticate, auth.requireRoles('ADMIN')];

  app.get('/api/automation/controls/:key', ...signedIn, async (req, res, next) => {
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

  app.use('/api', createLeasingRouter({ pool, auth }));
  app.use('/api', createCustomerRouter({ pool, auth }));
  app.use('/api', createLeadRouter({ pool, auth }));
  app.use('/api', createReportRouter({ pool, auth }));
  app.use('/api/publishing', createPublishingRouter({ pool, auth, llm, mediaDir }));
  app.use('/api/inbox', createInboxRouter({ pool, auth, llm }));
  app.use('/api/demand', createDemandRouter({ pool, auth, llm }));
  app.use('/api/hotels', createHotelRouter({ pool, auth }));
  app.use('/api/discovery', createDiscoveryRouter({
    pool, auth, providers, llm,
    enqueueRun: runId => jobQueue.enqueue(PHASE5_QUEUES.DISCOVER_COMPANIES, { run_id: runId }, { singletonKey: runId })
  }));

  app.get('/api/overview', ...signedIn, async (req, res, next) => {
    try { res.json(await getOverview(pool, { user: req.managementUser, sector: req.query.sector })); } catch (error) { next(error); }
  });

  app.get('/api/companies/:id/score', ...signedIn, async (req, res, next) => {
    try {
      const latest = await scoringService.getLatest(req.params.id);
      if (!latest) return res.status(404).json({ error: 'Score not found', code: 'SCORE_NOT_FOUND' });
      res.json(latest);
    } catch (error) { next(error); }
  });
  app.get('/api/companies/:id/score-history', ...signedIn, async (req, res, next) => {
    try { res.json({ items: await scoringService.getHistory(req.params.id, { limit: Number(req.query.limit) || 50 }) }); }
    catch (error) { next(error); }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));
  // Every page other than the login page needs a session.
  app.use(auth.requirePageSession, express.static(publicDir));
}

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
  // The worker starts after the app is healthy, so only the app applies migrations.
  if (httpListenEnabled && !/^(0|false|no|off)$/i.test(process.env.DB_MIGRATE_ON_START || 'true')) {
    const result = await runMigrations({ pool, log: line => audit('migration', { detail: line }) });
    audit('migrations_checked', { total: result.total, applied: result.applied.length });
  }
  await jobQueue.start();
  // 每天 07:30 检索一次周边企业（设置里可以关）。由应用登记，worker 执行。
  if (httpListenEnabled && jobQueue.enabled) {
    await jobQueue.schedule(PHASE5_QUEUES.DISCOVER_COMPANIES, '30 7 * * *');
    await jobQueue.schedule(PHASE5_QUEUES.CLASSIFY_INTERACTIONS, '* * * * *');
  }
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
