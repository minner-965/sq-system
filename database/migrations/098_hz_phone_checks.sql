-- 098: 专用手机的“测试一下”和两个开关（发朋友圈、在手机抖音里回私信）。
-- 页面写一条测试请求，跑在这台电脑上的发布程序看到后在手机上打开对应的 App 看一眼、截一张图，不发任何东西。
-- 某个 App 测试通过后，管理员才能打开对应的开关；开关关着时，手机上什么都不发。
CREATE TABLE leadgen.phone_check_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    app text NOT NULL CHECK (app IN ('wechat', 'douyin')),
    requested_by uuid REFERENCES leadgen.users(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    logged_in boolean,
    page_ok boolean,
    message text,
    screenshot text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX idx_phone_check_requests_app ON leadgen.phone_check_requests (app, created_at DESC);

CREATE TABLE leadgen.phone_settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    moments_enabled boolean NOT NULL DEFAULT false,
    moments_enabled_by uuid REFERENCES leadgen.users(id),
    moments_enabled_at timestamptz,
    dm_enabled boolean NOT NULL DEFAULT false,
    dm_enabled_by uuid REFERENCES leadgen.users(id),
    dm_enabled_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (NOT moments_enabled OR moments_enabled_by IS NOT NULL),
    CHECK (NOT dm_enabled OR dm_enabled_by IS NOT NULL)
);
INSERT INTO leadgen.phone_settings (id) VALUES (1);

-- 私信回复从哪里发出：phone = 在专用手机的抖音 App 里发。
ALTER TABLE leadgen.interaction_messages
    ADD COLUMN IF NOT EXISTS reply_via text CHECK (reply_via IN ('platform', 'phone'));

COMMENT ON TABLE leadgen.phone_check_requests IS '专用手机的“测试一下”：只打开 App 看一眼并截图，不发任何内容';
COMMENT ON COLUMN leadgen.phone_settings.moments_enabled_by IS '看过测试结果、打开朋友圈发布的管理员';
COMMENT ON COLUMN leadgen.phone_settings.dm_enabled_by IS '看过测试结果、打开手机回私信的管理员';
COMMENT ON COLUMN leadgen.interaction_messages.reply_via IS '回复从哪里发出：phone = 专用手机的抖音 App';
