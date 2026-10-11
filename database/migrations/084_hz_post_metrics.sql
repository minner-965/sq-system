-- 084: 已发布帖子的数据（浏览、点赞、收藏、转发）。发布程序每 6 小时读一次，发布满 30 天后不再读。
ALTER TABLE leadgen.publish_tasks
    ADD COLUMN IF NOT EXISTS stat_views integer,
    ADD COLUMN IF NOT EXISTS stat_likes integer,
    ADD COLUMN IF NOT EXISTS stat_favorites integer,
    ADD COLUMN IF NOT EXISTS stat_shares integer,
    ADD COLUMN IF NOT EXISTS metrics_at timestamptz;

COMMENT ON COLUMN leadgen.publish_tasks.metrics_at IS '上一次读到浏览、点赞等数据的时间';
