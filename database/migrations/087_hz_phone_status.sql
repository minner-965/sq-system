-- 087: 专用安卓手机的状态（发朋友圈、在抖音 App 里回私信都靠它）。发布程序每分钟看一次，写在在线状态这一行里。
ALTER TABLE leadgen.publisher_heartbeat
    ADD COLUMN IF NOT EXISTS phone jsonb,
    ADD COLUMN IF NOT EXISTS phone_checked_at timestamptz;

COMMENT ON COLUMN leadgen.publisher_heartbeat.phone IS '专用手机的状态：是否连接、是否可用、型号、一句说明';
