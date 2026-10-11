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
| express-session、connect-pg-simple、express-rate-limit | 1.19.0 / 10.0.0 / 8.7.0 | MIT | 账号登录（WP03 引入，见下） |
| chart.js | 4.5.1 | MIT | 图表（WP03 引入，见下） |
| multer | 2.4.0 | MIT | 素材上传（WP06 引入，见下） |
| pdf-to-img（仅开发依赖） | 6.3.0 | MIT | 房源导入时把平面图 PDF 拆成图片；不进运行镜像 |

WP01 移除：`nodemailer`、`imapflow`（随发信收信功能删除）。

## 待评估（对应工作包开始时补全并做决定）

| 方向 | 工作包 | 候选 | 状态 |
|---|---|---|---|
| 平台发布 | WP06 | social-auto-upload（计划注明 MIT，引入前核对） | 未评估 |
| 朋友圈发布 | WP08 | uiautomator2 | 未评估 |

## WP06 第一阶段的选型记录（2026-10-11）

| 用途 | 采用 | 版本 | 来源 | 许可 | 维护状态（npm，2026-10-11 查） | 说明 |
|---|---|---|---|---|---|---|
| 接收上传的图片和视频 | multer | 2.4.0 | https://github.com/expressjs/multer | MIT | 2026-09 发布，Express 官方维护 | Express 处理文件上传的标准中间件 |

大模型调用没有用 SDK：DeepSeek、智谱、通义都兼容 OpenAI 的 `chat/completions`，一个 `fetch` 请求就够，封装在 `src/llm/llmClient.js`。

### WP06 第二阶段：发布程序（`publisher/`，Python）

| 用途 | 采用 | 版本 | 来源 | 许可 | 状态（2026-10-11 查） | 集成边界 |
|---|---|---|---|---|---|---|
| 抖音等平台的扫码登录和上传 | social-auto-upload | 固定在提交 `0012d2c`（2026-09-03） | https://github.com/dreammis/social-auto-upload | MIT | 活跃，项目自述处于重构期 | 不改它的代码，不进本仓库：`publisher/setup.ps1` 下载到 `publisher/vendor/`（不进 Git）并固定版本。只调用它的命令行 `sau <平台> login / check / upload-note / upload-video`，不用它自带的网页界面和数据库。升级前先在测试账号上回归 |
| 浏览器自动化 | patchright | 1.58.2 | https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python | Apache-2.0 | 随 social-auto-upload 安装 | 它是 social-auto-upload 指定的依赖，我们不直接调用 |
| 同上（组件的部分平台代码直接引用） | playwright | 1.52.0 | https://github.com/microsoft/playwright-python | Apache-2.0 | 版本取自组件的 requirements.txt | 只为让组件的命令行能加载 |
| 发布程序读写数据库 | psycopg（binary） | 3.3.5 | https://github.com/psycopg/psycopg | LGPL-3.0 | 活跃 | 作为库调用，不改它的代码 |

要知道的：social-auto-upload 发布成功后不返回帖子链接，要靠我们自己读创作者后台补上。

我们在固定版本上打了三处小补丁（`publisher/apply_patches.py`，安装脚本自动应用，每条写了原因）：抖音图文页标题框的定位（平台已改版，上游还没跟）；点发布无反应时限次重试、截图并报出页面提示（上游是无限重试）；发图文时遇到短信验证，替人点“获取验证码”并等人在窗口里输入（上游只在发视频时处理）。上游修复后提版本号、删补丁。

## WP05 的选型记录（2026-10-11）

没有引入新依赖。

| 方向 | 考虑过的 | 结论 |
|---|---|---|
| 客户跟进 | 开源 CRM（Twenty、EspoCRM、SuiteCRM 一类） | 不采用。它们都是自带技术栈和界面的完整系统，不能嵌进现有的 Express 服务，许可多为 AGPL/GPL；我们要的只是“一个企业、三个板块各一条跟进、一条时间线”，在已有的表上加接口就够。这次只参考了常见做法（阶段、负责人、下次跟进时间、时间线），没有逐个核对它们的最新版本和许可条款，以后真要引入时再核对 |
| 房源匹配 | 规则引擎（已有的 zen-engine） | 匹配只有面积、预算、明火三个条件，按“差多少”排序，用代码写（`matchPenalty`），没有上规则引擎 |
| 通知 | 第三方通知服务 | 本期只做站内通知，自建两张表；表结构按“发给人或角色”设计，WP06 的互动提醒和以后的企业微信渠道都从这里走 |

## WP04 的选型记录（2026-10-11）

没有引入新依赖。

| 方向 | 查到的 | 结论 |
|---|---|---|
| 高德地图接口的 Node SDK | 高德官方在 npm 上只有浏览器端的加载器（`@amap/amap-jsapi-loader`），服务端用的是 HTTP 的 Web 服务接口，没有官方 Node SDK；社区封装 `amap-sdk` 停在 1.0.1，2022 年后没有更新（npm，2026-10-11 查） | 直接调官方 Web 服务接口（`/v3/place/around`），用 Node 自带的 `fetch`，封装在 `src/discovery/providers/amap.js`，约 60 行 |
| 评分 | 仓库里已有 `@gorules/zen-engine` 和旧的评分框架 | 这一版规则只有四项加法，用代码写更直白（`src/discovery/scoring.js`）；旧评分框架的表结构绑定海外版的事实快照，没有沿用。规则变复杂、需要业务人员自己调时再迁到 zen-engine |
| 定时任务 | 已有的 pg-boss | 直接用它的定时功能，每天 7:30 一次 |
| 用量记录 | 已有的 `provider_usage_events` 表 | 该表必须关联旧的研究任务，用不了；新建了简单的 `api_usage_events` |
| 百度搜索、博查、工商数据、大模型 | 计划里列为预留 | 没有 Key，没有实现，只在 `providers/index.js` 里列了名字 |

## WP03 的选型记录（2026-10-10）

| 用途 | 采用 | 版本 | 来源 | 许可 | 维护状态（npm，2026-10-10 查） | 说明 |
|---|---|---|---|---|---|---|
| 登录会话 | express-session | 1.19.0 | https://github.com/expressjs/session | MIT | 2026-01 发布，Express 官方维护 | Express 的标准会话中间件 |
| 会话存储 | connect-pg-simple | 10.0.0 | https://github.com/voxpelli/node-connect-pg-simple | MIT | 2024-09 发布，功能稳定 | 会话存进现有的 PostgreSQL，不用另起 Redis；表由迁移 068 建 |
| 登录限速 | express-rate-limit | 8.7.0 | https://github.com/express-rate-limit/express-rate-limit | MIT | 2026-08 发布；8.7.1 是四天前刚发的，暂不跟进 | 限制同一来源的登录尝试次数 |
| 图表 | chart.js | 4.5.1 | https://github.com/chartjs/Chart.js | MIT | 2025-10 发布 | 总览页环形图；文件从本机 `node_modules` 提供，不走外网 |

密码哈希用 Node 自带的 scrypt（`node:crypto`），没有引入第三方库。没有采用整套的登录框架（Passport、Lucia 等）：只有账号密码一种登录方式，会话中间件加四十行代码就够。

页面样式按确认过的样稿手写（`public/assets/app.css`），没有加载 Tabler。Tabler 的两个依赖暂时保留，后面做表单和弹窗较多的页面时再决定用还是移除。

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
