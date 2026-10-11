-- 085: 陌生人私信用固定话术自动回复（Simon 2026-10-11 确认的例外，见 CLAUDE.md 第 3 节）。
-- 只对“陌生人私信”里读到的消息生效；同一个人只自动回一次；开关、话术、每天上限都在系统设置里。
ALTER TABLE leadgen.inbox_settings
    ADD COLUMN IF NOT EXISTS dm_auto_reply_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS dm_auto_reply_text text,
    ADD COLUMN IF NOT EXISTS dm_auto_reply_daily_limit integer NOT NULL DEFAULT 30 CHECK (dm_auto_reply_daily_limit BETWEEN 1 AND 200),
    ADD COLUMN IF NOT EXISTS dm_auto_reply_enabled_by uuid REFERENCES leadgen.users(id),
    ADD CONSTRAINT inbox_settings_auto_reply_check
        CHECK (NOT dm_auto_reply_enabled OR (dm_auto_reply_text IS NOT NULL AND dm_auto_reply_enabled_by IS NOT NULL));

ALTER TABLE leadgen.interaction_messages
    ADD COLUMN IF NOT EXISTS reply_auto boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN leadgen.inbox_settings.dm_auto_reply_enabled_by IS '打开自动回复并认可话术的人；自动回复记在这个人名下';
COMMENT ON COLUMN leadgen.interaction_messages.reply_auto IS '这条回复是固定话术自动发的，不是人逐条确认的';
