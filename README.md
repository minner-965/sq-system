# 恒兆广场招商与获客系统

服务广州黄埔区恒兆广场的招商与获客系统，覆盖商铺写字楼、酒店公寓、自营餐饮三个板块，另有内容发布中心。

- 项目规则：[`CLAUDE.md`](CLAUDE.md)
- 分阶段执行计划：[`docs/hz/执行计划_V1.2.md`](docs/hz/执行计划_V1.2.md)
- 当前进度：[`docs/hz/进度.md`](docs/hz/进度.md)
- 界面样稿：[`docs/hz/ui-mockup/overview.html`](docs/hz/ui-mockup/overview.html)

## 本地启动

需要 Docker Desktop、Node.js 24。

```bash
cp .env.example .env        # 填写数据库密码
docker compose up -d postgres app
```

打开 http://localhost:3000 。健康检查：`/api/health`。

后台任务进程按需启动：`docker compose up -d worker`。

## 测试

```bash
cd services/demo-dashboard
npm ci
npm test
```

## 目录

| 路径 | 内容 |
|---|---|
| `services/demo-dashboard/` | 应用服务（Express）、页面、测试 |
| `database/migrations/` | 数据库迁移，只增不改 |
| `rules/` | 评分规则 |
| `config/search/` | 检索词与域名策略 |
| `docs/hz/` | 方案、计划、进度、样稿 |
| `docs/history/` | 原海外版的历史文档，仅供参考 |
