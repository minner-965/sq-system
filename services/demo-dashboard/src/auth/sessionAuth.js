import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { rateLimit } from 'express-rate-limit';
import { hashPassword, verifyPassword } from './password.js';

const SESSION_HOURS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
// Verified against when the account does not exist, so both cases take the same time.
const UNKNOWN_ACCOUNT_HASH = hashPassword('unknown-account-placeholder');

const ROLE_CODE = { admin: 'ADMIN', boss: 'BOSS', leasing: 'LEASING' };

/** The signed-in user as business code sees it (req.managementUser). */
export async function loadUser(pool, userId) {
  const { rows: [row] } = await pool.query(`
    SELECT u.id, u.username, u.display_name, u.role_key, r.name AS role_name, r.can_write, r.all_sectors,
           CASE WHEN r.all_sectors THEN (SELECT array_agg(key ORDER BY sort_order) FROM leadgen.sectors)
                ELSE COALESCE((SELECT array_agg(us.sector_key ORDER BY s.sort_order)
                               FROM leadgen.user_sectors us JOIN leadgen.sectors s ON s.key = us.sector_key
                               WHERE us.user_id = u.id), '{}') END AS sectors
    FROM leadgen.users u JOIN leadgen.roles r ON r.key = u.role_key
    WHERE u.id = $1 AND u.is_active`, [userId]);
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    identity: row.username,
    displayName: row.display_name,
    role: ROLE_CODE[row.role_key],
    roleName: row.role_name,
    canWrite: row.can_write,
    allSectors: row.all_sectors,
    sectors: Object.freeze(row.sectors)
  });
}

export function publicUser(user) {
  return {
    username: user.identity, display_name: user.displayName, role: user.role, role_name: user.roleName,
    can_write: user.canWrite, all_sectors: user.allSectors, sectors: user.sectors
  };
}

export function createSessionAuth({ pool, env = process.env }) {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw Object.assign(new Error('SESSION_SECRET must be set to at least 32 characters'), { code: 'SESSION_SECRET_REQUIRED' });
  }
  const PgStore = connectPgSimple(session);
  const sessionMiddleware = session({
    name: 'hz.sid',
    secret,
    store: new PgStore({ pool, schemaName: 'leadgen', tableName: 'user_sessions', pruneSessionInterval: 15 * 60 }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'auto': secure whenever the request arrived over HTTPS (the public tunnel), plain on localhost.
      secure: 'auto',
      maxAge: SESSION_HOURS * 60 * 60 * 1000
    }
  });

  async function authenticate(req, res, next) {
    try {
      const user = req.session?.userId ? await loadUser(pool, req.session.userId) : null;
      if (!user) return res.status(401).json({ error: '请先登录', code: 'LOGIN_REQUIRED' });
      req.managementUser = user;
      next();
    } catch (error) { next(error); }
  }

  function requireRoles(...allowed) {
    const roles = new Set(allowed.map(value => String(value).toUpperCase()));
    return (req, res, next) => {
      if (!roles.has(req.managementUser?.role)) {
        return res.status(403).json({ error: '当前账号没有这项权限', code: 'MANAGEMENT_ROLE_FORBIDDEN' });
      }
      next();
    };
  }

  /** Blocks every state-changing request from accounts that are read-only. */
  function requireWrite(req, res, next) {
    if (!req.managementUser?.canWrite) return res.status(403).json({ error: '当前账号只能查看', code: 'READ_ONLY_ACCOUNT' });
    next();
  }

  /** Pages: send visitors without a session to the login page. */
  async function requirePageSession(req, res, next) {
    try {
      if (req.session?.userId && await loadUser(pool, req.session.userId)) return next();
      res.redirect(302, '/login.html');
    } catch (error) { next(error); }
  }

  /** Rejects writes sent from another site's page; the cookie is SameSite=Lax as well. */
  function sameOriginWrites(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: '请求来源不正确', code: 'CROSS_SITE_REQUEST' });
    }
    next();
  }

  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '尝试次数过多，请 10 分钟后再试', code: 'LOGIN_RATE_LIMITED' }
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const username = String(req.body?.username || '').trim().toLowerCase();
      const password = req.body?.password;
      const failed = () => res.status(401).json({ error: '账号或密码不正确', code: 'LOGIN_FAILED' });
      if (!username || typeof password !== 'string') return failed();

      const { rows: [account] } = await pool.query(`
        SELECT id, password_hash, is_active, locked_until > now() AS locked
        FROM leadgen.users WHERE username = $1`, [username]);
      const matches = await verifyPassword(password, account?.password_hash ?? await UNKNOWN_ACCOUNT_HASH);
      if (!account || !account.is_active || !account.password_hash) return failed();
      if (account.locked) {
        return res.status(423).json({ error: `密码连续输错，账号已锁定 ${LOCK_MINUTES} 分钟`, code: 'ACCOUNT_LOCKED' });
      }
      if (!matches) {
        await pool.query(`
          UPDATE leadgen.users SET
            failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
            locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`, [account.id, MAX_FAILED_LOGINS, LOCK_MINUTES]);
        return failed();
      }

      await pool.query('UPDATE leadgen.users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [account.id]);
      // A fresh session id on sign-in, so an id planted before login is useless.
      await new Promise((resolve, reject) => req.session.regenerate(error => (error ? reject(error) : resolve())));
      req.session.userId = account.id;
      await new Promise((resolve, reject) => req.session.save(error => (error ? reject(error) : resolve())));
      res.json(publicUser(await loadUser(pool, account.id)));
    } catch (error) { next(error); }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('hz.sid');
      res.status(204).end();
    });
  });

  router.get('/me', authenticate, (req, res) => res.json(publicUser(req.managementUser)));

  return Object.freeze({
    configured: true, sessionMiddleware, sameOriginWrites, authenticate, tryAuthenticate: authenticate,
    requireRoles, requireWrite, requirePageSession, router
  });
}
