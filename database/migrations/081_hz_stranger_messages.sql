-- 081: 读取发布账号收到的陌生人私信。
-- 只读“陌生人私信”一栏；账号接入时这一栏里已有的会话记为基线，不收进系统，之后新来的才收。
ALTER TABLE leadgen.publish_accounts
    ADD COLUMN IF NOT EXISTS dm_baseline_at timestamptz,
    ADD COLUMN IF NOT EXISTS dm_baseline_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN leadgen.publish_accounts.dm_baseline_at IS '第一次读陌生人私信的时间；在这之前就有的会话不收';
COMMENT ON COLUMN leadgen.publish_accounts.dm_baseline_keys IS '基线时已有会话的指纹，用来跳过';
