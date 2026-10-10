// ADMIN 管理员（全部权限）、BOSS 老板（只读）、LEASING 招商人员，对应 leadgen.roles。
// 其余是保留模块仍在使用的旧角色名。
export const MANAGEMENT_ROLES = Object.freeze([
  'ADMIN',
  'BOSS',
  'LEASING',
  'SALES',
  'MANAGEMENT',
  'DATA_ADMIN',
  'FINANCE',
  'MANAGEMENT_APPROVER',
  'OUTREACH_APPROVER',
  'SENDER_OPERATOR'
]);

/** The leasing floor price is visible to administrators only. */
export function canSeeFloorPrice(user) {
  return user?.role === 'ADMIN';
}

/**
 * Supplies the audit identity used by the single-company workspace.
 *
 * This is deliberately not an authentication mechanism: there is no browser
 * token, bearer token, CSRF challenge or verification dialog. A future public
 * deployment can replace this adapter with the company's normal account login
 * without changing the business services that consume req.managementUser.
 */
export function createManagementAuth(env = process.env) {
  const identity = String(env.DPV_WORKSPACE_ACTOR || 'admin').trim() || 'admin';
  const configuredRole = String(env.DPV_WORKSPACE_ROLE || 'ADMIN').trim().toUpperCase();
  // An unrecognised role gets the read-only one, never administrator.
  const role = MANAGEMENT_ROLES.includes(configuredRole) ? configuredRole : 'BOSS';
  const user = Object.freeze({ identity, role });

  function attachWorkspaceUser(req, _res, next) {
    req.managementUser = user;
    next();
  }

  function requireRoles(...allowed) {
    const roles = new Set(allowed.map(value => String(value).toUpperCase()));
    return (req, res, next) => {
      if (!roles.has(req.managementUser?.role)) {
        return res.status(403).json({ error: 'Role is not permitted for this operation', code: 'MANAGEMENT_ROLE_FORBIDDEN' });
      }
      next();
    };
  }

  return Object.freeze({
    configured: true,
    authenticate: attachWorkspaceUser,
    tryAuthenticate: attachWorkspaceUser,
    requireRoles
  });
}
