# 复用登记

规则：不重复造轮子。每个工作包动手前先查有没有现成的开源项目能直接用；引入新依赖前在这里登记官方来源、许可、维护状态和用途。原海外版的登记见 `docs/history/REUSE_CANDIDATE_REGISTRY_DPV.md`。

## 已在使用

版本取自 `services/demo-dashboard/package.json`。许可为各项目公开声明的许可；本表建立时没有逐个重新核对最新发布和安全公告，升级前要核对。

| 依赖 | 版本 | 许可 | 用途 |
|---|---|---|---|
| express | 5.2.1 | MIT | Web 服务 |
| pg | 8.23.0 | MIT | PostgreSQL 连接 |
| pg-boss | 12.28.0 | MIT | 任务队列、定时任务 |
| exceljs | 4.4.0 | MIT | Excel 读写（房源导入、报表导出） |
| csv-parse | 7.0.2 | MIT | CSV 解析 |
| @gorules/zen-engine | 2.0.2 | MIT | 评分规则引擎 |
| @tabler/core | 1.4.0 | MIT | 界面基础样式和组件 |
| @tabler/icons-webfont | 3.46.0 | MIT | 图标 |
| cheerio | 1.2.0 | MIT | 解析公开网页 |
| tldts | 7.4.11 | MIT | 域名解析 |
| libphonenumber-js | 1.13.12 | MIT | 电话号码规范化 |
| validator | 13.15.35 | MIT | 输入校验 |
| @opentelemetry/api、sdk-trace-base | 1.9.1 / 2.10.0 | Apache-2.0 | 本地追踪 |
| umzug | 3.8.3 | MIT | 数据库迁移执行（WP02 引入，见下） |
| pdf-to-img（仅开发依赖） | 6.3.0 | MIT | 房源导入时把平面图 PDF 拆成图片；不进运行镜像 |

WP01 移除：`nodemailer`、`imapflow`（随发信收信功能删除）。

## 待评估（对应工作包开始时补全并做决定）

| 方向 | 工作包 | 候选 | 状态 |
|---|---|---|---|
| 登录与会话 | WP03 | 现成的会话中间件和密码哈希库 | 未评估 |
| 图表 | WP03 | Chart.js（计划已选定，需本地打包） | 未登记版本 |
| 企业发现 | WP04 | 高德、百度开放接口的官方或社区 SDK | 未评估 |
| 客户跟进 | WP05 | 开源 CRM 的数据结构和界面做法 | 未评估 |
| 平台发布 | WP06 | social-auto-upload（计划注明 MIT，引入前核对） | 未评估 |
| 朋友圈发布 | WP08 | uiautomator2 | 未评估 |

## WP02 的选型记录（2026-10-10）

### 数据库迁移执行：采用 umzug

要求：直接执行现有的 67 个纯 SQL 文件（文件名 `NNN_名称.sql`，多数自带 `BEGIN/COMMIT`，不能改）；按编号顺序；已执行的记到现有的 `leadgen.schema_migrations` 表；可重复运行；能接管已经用旧方式建好的库。

| 候选 | 来源 | 许可 | 维护状态（npm，2026-10-10 查） | 结论 |
|---|---|---|---|---|
| umzug | https://github.com/sequelize/umzug | MIT | 3.8.3，2026-05 发布，Sequelize 团队维护 | **采用**。只负责排序、判断哪些待执行、逐个执行；文件怎么跑、记到哪张表都可以自己接，正好能沿用现有文件名和 `schema_migrations` 表 |
| node-pg-migrate | https://github.com/salsita/node-pg-migrate | MIT | 9.0.0，2026-10 发布 | 不采用。每个迁移外面固定再包一层事务，和现有文件自带的 `BEGIN/COMMIT` 嵌套；记录表结构固定，不能用现有的表 |
| Postgrator | https://github.com/rickbergfalk/postgrator | MIT | 8.0.0，2024-11 发布 | 不采用。要求文件名为 `001.do.名称.sql`，现有 67 个文件都要改名，违反“不改历史迁移” |

自己写的部分（`src/db/migrator.js`，约 130 行）：执行 SQL 文件并在同一事务里登记、文件内容校验（已执行的文件被改动就报错）、并发锁、给旧方式建的库补登记 001–063。

### 平面图 PDF 转图片：采用 pdf-to-img

来源 https://github.com/k-yle/pdf-to-img ，MIT，基于 Mozilla 的 pdfjs。只在本机跑导入脚本时用，装成开发依赖。用 6.3.0（2026-08 发布）；7.0.1 是登记当天刚发布的版本，暂不跟进。
