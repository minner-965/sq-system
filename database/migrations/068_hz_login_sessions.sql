-- 恒兆广场国内版：登录会话。表结构按 connect-pg-simple 的要求，放在 leadgen 下。
-- 连续输错密码的次数和锁定时间记在账号上。

CREATE TABLE leadgen.user_sessions (
    sid varchar NOT NULL PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
);
CREATE INDEX idx_user_sessions_expire ON leadgen.user_sessions (expire);

ALTER TABLE leadgen.users
    ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
    ADD COLUMN locked_until timestamptz,
    ADD COLUMN last_login_at timestamptz;
