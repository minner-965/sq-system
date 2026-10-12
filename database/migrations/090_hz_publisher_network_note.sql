-- 090: 发布程序把自己的浏览器是从哪里出去的记在在线状态里（走本机宽带直连，还是照原样经代理软件出去）。
-- 平台看到的登录地点不对，是频繁要验证、账号被登出的常见原因，要能在页面上一眼看到。
ALTER TABLE leadgen.publisher_heartbeat ADD COLUMN IF NOT EXISTS network_note text;
