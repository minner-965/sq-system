-- 096: 人员和权限按 Simon 2026-10-22 的分工调整为四个人：
--   系统负责人（admin，全部权限）、老板（boss，只读）、运营（operations，全部板块，负责内容发布、互动收件箱、素材库）、
--   销售（sales，按板块分配，跟进客户）。
-- 原来的 leasing（招商人员）保留，已有数据和旧账号仍可用，只是不再分配给新的人。
-- 由迁移执行器在一个事务内执行并登记，本文件不写 BEGIN/COMMIT。重复执行结果不变。

ALTER TABLE leadgen.roles DROP CONSTRAINT IF EXISTS roles_key_check;
ALTER TABLE leadgen.roles ADD CONSTRAINT roles_key_check
    CHECK (key IN ('admin', 'boss', 'leasing', 'operations', 'sales'));

INSERT INTO leadgen.roles (key, name, can_write, all_sectors, sees_floor_price) VALUES
    ('operations', '运营', true, true, false),
    ('sales', '销售', true, false, false)
ON CONFLICT (key) DO UPDATE SET
    name = EXCLUDED.name, can_write = EXCLUDED.can_write,
    all_sectors = EXCLUDED.all_sectors, sees_floor_price = EXCLUDED.sees_floor_price;

-- 角色名称和四个人的分工一致：管理员改称系统负责人。
UPDATE leadgen.roles SET name = '系统负责人' WHERE key = 'admin';

-- 现有四个账号：admin 改称系统负责人；chen 改为运营；lin 改为销售，负责三个板块。
-- 只改还是原样的账号，已经在页面上改过的不动。
UPDATE leadgen.users SET display_name = '系统负责人', updated_at = now()
WHERE username = 'admin' AND display_name = 'Simon';

UPDATE leadgen.users SET display_name = '运营', role_key = 'operations', updated_at = now()
WHERE username = 'chen' AND role_key = 'leasing';
-- 运营负责全部板块，原来按板块分配的记录不再需要。
DELETE FROM leadgen.user_sectors
WHERE user_id IN (SELECT id FROM leadgen.users WHERE username = 'chen' AND role_key = 'operations');

UPDATE leadgen.users SET display_name = '销售', role_key = 'sales', updated_at = now()
WHERE username = 'lin' AND role_key = 'leasing';
INSERT INTO leadgen.user_sectors (user_id, sector_key)
SELECT u.id, s.key FROM leadgen.users u CROSS JOIN leadgen.sectors s
WHERE u.username = 'lin' AND u.role_key = 'sales'
ON CONFLICT DO NOTHING;
