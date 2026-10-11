-- 内容发布：在“发布账号”页发起扫码登录；发布程序的在线状态。
-- 页面写一条登录请求，跑在这台电脑上的发布程序看到后弹出浏览器窗口显示二维码。
CREATE TABLE leadgen.publish_login_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES leadgen.publish_accounts(id) ON DELETE CASCADE,
    requested_by uuid REFERENCES leadgen.users(id),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'opened', 'succeeded', 'failed')),
    message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX idx_publish_login_requests_account ON leadgen.publish_login_requests (account_id, created_at DESC);

-- 发布程序每一轮写一次时间，页面据此显示它是否在运行。
CREATE TABLE leadgen.publisher_heartbeat (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_seen_at timestamptz,
    host_name text
);
INSERT INTO leadgen.publisher_heartbeat (id) VALUES (1);
