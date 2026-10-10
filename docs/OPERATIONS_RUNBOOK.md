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
- 目前迁移只在首次建库（空数据卷）时由 PostgreSQL 容器按文件名顺序执行。已有数据库应用新迁移的执行器在 WP02 补上。
- `docker compose down -v` 会删除数据卷，执行前先确认数据已备份或不需要。

## 发布

提交前检查没有把 `.env`、登录状态、数据库备份、客户导出加入暂存区。推送到 `origin`（sq-system），不强制推送。
