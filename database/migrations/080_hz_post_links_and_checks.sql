-- 内容发布：发布成功后从平台读回的作品编号和互动数；读取程序的检查安排。
ALTER TABLE leadgen.publish_tasks
    ADD COLUMN platform_post_id text,
    ADD COLUMN stat_comments integer,
    ADD COLUMN stats_at timestamptz;
CREATE UNIQUE INDEX idx_publish_tasks_platform_post ON leadgen.publish_tasks (platform, platform_post_id) WHERE platform_post_id IS NOT NULL;

-- 每个账号最近一次读取评论和私信的时间和结果，以及下一次定时读取的时间（每小时一次，带几分钟随机偏移）。
ALTER TABLE leadgen.publish_accounts
    ADD COLUMN last_inbox_check_at timestamptz,
    ADD COLUMN last_inbox_check_note text,
    ADD COLUMN next_inbox_check_at timestamptz;
