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
- `docker compose down -v` 会删除数据卷，执行前先确认数据已备份或不需要。

## 账号与登录

- 除登录页外，所有页面和接口都要先登录。`.env` 里必须有 `SESSION_SECRET`（至少 32 位随机字符），没有它应用不启动。
- 新建账号或重置密码：在 `services/demo-dashboard` 下运行
  - `npm run user:set -- --username boss --name 老板 --role boss`
  - `npm run user:set -- --username chen --name 陈经理 --role leasing --sectors office_retail,dining`
  - `npm run user:set -- --username admin`（只重置密码）
- 密码随机生成，写在本机 `data/accounts.local.txt`（不进 Git），以该账号的最后一行为准。重置密码后该账号原有的登录全部失效。
- 角色：`admin` 管理员（全部权限，能看底价）、`boss` 老板（只读）、`leasing` 招商人员（只看分配给自己的板块）。
- 密码连续输错 5 次，账号锁定 15 分钟；同一来源 10 分钟内最多尝试 20 次。登录保持 12 小时。

## 企业发现

- `.env` 里填 `AMAP_KEY`（高德开放平台“Web 服务”类型的 Key）。检查 Key 是否可用：在 `services/demo-dashboard` 下 `npm run check:amap`。
- 检索由 `worker` 容器执行，所以 `worker` 要开着。每天 7:30 自动检索一次；也可以在“企业发现”页点“立即检索”。
- 检索半径、企业类别、关键词、每次最多调用次数、是否每天自动检索，管理员在“企业发现”页的“检索设置”里改。
- 每次调用地图接口都记在 `leadgen.api_usage_events`，页面底部显示当天和当月的次数。默认每次检索最多调用 30 次。
- 一次检索超过 30 分钟没结束会被标为失败，可以重新发起。失败的检索不会自动重试。
- 评分规则见 `docs/hz/评分规则.md`。
- 需求信号要 `.env` 里有 `BAIDU_SEARCH_KEY`（百度千帆）和 `DEEPSEEK_API_KEY`，检查：`npm run check:search-llm`。任一个没填就不查需求信号，其他功能不受影响。百度搜索不要开通“后付费”，免费额度用完当天就停。
- 换大模型服务商：`.env` 里填 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`（任何兼容 OpenAI 接口的服务都行），重建 `app` 和 `worker`。

## 内容发布程序（publisher）

发布程序是 Python 写的，直接跑在这台电脑上（不在 Docker 里），因为扫码登录要弹出浏览器窗口。

- 首次安装或换电脑：在仓库根目录执行 `powershell -ExecutionPolicy Bypass -File publisher\setup.ps1`。它会建虚拟环境、下载并固定开源发布组件、安装自动化用的浏览器。可重复运行。
- 扫码登录：`publisher\.venv\Scripts\python.exe publisher\hz_publisher.py login 抖音测试号`（最后是“内容发布”页里的账号名称）。会弹出浏览器，用对应平台的手机 App 扫码。
- 检查登录是否还有效：`publisher\.venv\Scripts\python.exe publisher\hz_publisher.py check`
- 常驻运行：双击 `publisher\start-publisher.cmd`（等于执行 `publisher\.venv\Scripts\python.exe publisher\hz_publisher.py run`），窗口要一直开着。它每 20 秒看一次有没有到点的已确认任务，一次只发一条；页面上发起的扫码登录也由它弹窗。不开它，确认过的内容不会发出去，“发布账号”页会显示“发布程序没有在运行”。
- 账号的扫码、暂停、每日上限都在系统的“发布账号”页操作。
- 只处理一遍：把上面的 `run` 换成 `once`。
- 登录状态存在 `publisher/state/`，等同于账号密码，不进 Git，不要外传；备份时带上它。
- 发布失败不会自动重试。处理完原因后，在页面上重新确认。
- 程序被中断时正在发的那条，会标为失败并提示“不确定是否已经发出”，要到平台上看一眼再决定是否重发。

## 房源导入

在 `services/demo-dashboard` 下运行 `npm run import:properties`。脚本从 `E:\claude\训练数据`（只读）读取推租表和平面图，写入房源、招商政策和项目信息，并生成 `docs/hz/房源导入报告.md`。可重复运行；房源的跟进状态不会被覆盖。平面图图片生成在 `data/media/floorplans/`，不进 Git。

## 发布

提交前检查没有把 `.env`、登录状态、数据库备份、客户导出加入暂存区。推送到 `origin`（sq-system），不强制推送。
