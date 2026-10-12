-- 093: 已在平台上删除的内容，同一条素材可以在同一个平台重新发一条。
-- 原来一条素材每个平台只能有一条发布任务；改成“没被删除的”只能有一条，删除过的留作记录。

ALTER TABLE leadgen.publish_tasks DROP CONSTRAINT IF EXISTS publish_tasks_material_id_platform_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_tasks_material_platform_live
    ON leadgen.publish_tasks (material_id, platform) WHERE status <> 'removed';
