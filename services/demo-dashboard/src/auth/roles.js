// 账号角色：leadgen.roles 的 key 和业务代码里用的大写代号一一对应。
//   admin 系统负责人（全部权限）  boss 老板（只读）  operations 运营（全部板块，内容发布、收件箱、素材库）
//   sales 销售（按板块）  leasing 招商人员（旧角色，保留给已有账号，不再分配）

export const ROLE_CODE = Object.freeze({
  admin: 'ADMIN', boss: 'BOSS', operations: 'OPERATIONS', sales: 'SALES', leasing: 'LEASING'
});

/** 页面上能分配给人的角色，按显示顺序。 */
export const ASSIGNABLE_ROLES = Object.freeze(['admin', 'boss', 'operations', 'sales']);

/** 登录后能看房源、招商政策等基础资料的角色。 */
export const STAFF_ROLE_CODES = Object.freeze(Object.values(ROLE_CODE));

/** 报表里只看自己那一行工作量的角色（按板块负责客户的人）。 */
const OWN_ROW_ROLE_CODES = new Set(['SALES', 'LEASING']);

export function seesOnlyOwnWorkload(user) {
  return OWN_ROW_ROLE_CODES.has(user?.role);
}
