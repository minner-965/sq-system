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

WP01 移除：`nodemailer`、`imapflow`（随发信收信功能删除）。

## 待评估（对应工作包开始时补全并做决定）

| 方向 | 工作包 | 候选 | 状态 |
|---|---|---|---|
| 数据库迁移执行 | WP02 | 现成的 Node 迁移工具（需支持纯 SQL 文件、按编号顺序、记录已执行） | 未评估 |
| 登录与会话 | WP03 | 现成的会话中间件和密码哈希库 | 未评估 |
| 图表 | WP03 | Chart.js（计划已选定，需本地打包） | 未登记版本 |
| 企业发现 | WP04 | 高德、百度开放接口的官方或社区 SDK | 未评估 |
| 客户跟进 | WP05 | 开源 CRM 的数据结构和界面做法 | 未评估 |
| 平台发布 | WP06 | social-auto-upload（计划注明 MIT，引入前核对） | 未评估 |
| 朋友圈发布 | WP08 | uiautomator2 | 未评估 |
