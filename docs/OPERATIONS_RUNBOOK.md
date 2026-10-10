# 运行手册

## 启动与停止

```bash
docker compose up -d postgres app     # 数据库 + 应用
docker compose up -d worker           # 后台任务（评分、导出），需要时再开
docker compose ps                     # 查看状态
docker compose down                   # 停止，保留数据
```

应用地址 http://localhost:3000 ，健康检查 `/api/health`。

## 配置

`.env` 由 `.env.example` 复制后填写，不进 Git。修改 `.env` 后要重新创建容器才生效：`docker compose up -d app`。

## 只读维护

`.env` 里设 `DPV_MAINTENANCE_READ_ONLY=true` 并重建 `app` 容器：页面可看，所有写操作返回 503，后台任务不启动。

## 数据库

- 迁移文件在 `database/migrations/`，只新增，不修改已有文件。
- 应用每次启动时自动执行还没执行过的迁移（按编号顺序，记在 `leadgen.schema_migrations`），空库和已有数据库都一样。不想自动执行时设 `DB_MIGRATE_ON_START=false`。
- 手动执行：在 `services/demo-dashboard` 下 `npm run migrate:host`；只看待执行的文件加 `-- --dry`。
- 已执行过的迁移文件被改动时，执行器会报错并停下；改动一律新增文件。
- 数据库只映射到本机 `127.0.0.1:5433`（可用 `POSTGRES_HOST_PORT` 改），供迁移命令和导入脚本使用。

## 房源导入

在 `services/demo-dashboard` 下运行 `npm run import:properties`。脚本从 `E:\claude\训练数据`（只读）读取推租表和平面图，写入房源、招商政策和项目信息，并生成 `docs/hz/房源导入报告.md`。可重复运行；房源的跟进状态不会被覆盖。平面图图片生成在 `data/media/floorplans/`，不进 Git。
- `docker compose down -v` 会删除数据卷，执行前先确认数据已备份或不需要。

## 发布

提交前检查没有把 `.env`、登录状态、数据库备份、客户导出加入暂存区。推送到 `origin`（sq-system），不强制推送。
