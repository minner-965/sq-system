-- 086: 已发布的帖子后来在平台上被删掉（比如发现声明有误，删掉重发），系统里要能如实记下来。
-- 新增状态 removed：已在平台删除。它当天仍然算发过一条（计入每日上限），但不再读数据、不计入发布统计。
ALTER TABLE leadgen.publish_tasks DROP CONSTRAINT IF EXISTS publish_tasks_status_check;
ALTER TABLE leadgen.publish_tasks ADD CONSTRAINT publish_tasks_status_check
    CHECK (status IN ('draft', 'confirmed', 'publishing', 'published', 'failed', 'withdrawn', 'removed'));
ALTER TABLE leadgen.publish_tasks ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE leadgen.publish_tasks ADD COLUMN IF NOT EXISTS removed_note text;
