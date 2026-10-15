# 本地开发

使用 Node.js 24。Windows 可直接使用 PowerShell；网站构建不再依赖 Bash。完整测试里的 Shell 安装器测试使用 Git for Windows 自带的 Bash，自动从 Git 安装位置查找。

## 日常启动

```powershell
cd E:\Codex\work\ai-yangmao
npm.cmd run dev
```

保留终端运行，访问 http://127.0.0.1:8787/ 。停止时在该终端按 Ctrl+C。

后台入口：http://127.0.0.1:8787/#admin 。使用本机 `.dev.vars` 中 `ADMIN_TOKEN=` 后面的值登录；不要复制到聊天、截图或提交 Git。2026-10-15 初始化时已生成随机本地密钥。

`dev` 明确使用 `--local --ip 127.0.0.1`。本地数据库保存在 `.wrangler/state/v3/d1`，与线上 D1 数据独立；数据库目录和 `.dev.vars` 均已被 Git 忽略。

## 新电脑第一次准备

```powershell
npm.cmd ci
if (-not (Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
npm.cmd run db:migrate:local
npm.cmd run seed:local
npm.cmd run seed:demo:local
npm.cmd run dev
```

示例配置只适用于本地开发，可将两个示例密钥替换为自己的随机本地值。

`seed:local` 导入平台与信源，平台默认待准入，不复制线上活动、审核结果或运行状态。`seed:demo:local` 仅写入虚构平台、两条公开活动和一条待审草稿，标题均带“本地演示”。该命令固定本地模式、拒绝额外参数，重复运行不会覆盖已修改的演示条目。已导入真实公开快照的环境应跳过演示数据命令。

本地配置未接入模型、GitHub 调度和消息渠道；网页与后台可用，不代表自动采集、快速上架模型补全、通知推送已验证。身份与筛选开关为 `off`；后续测试这些功能需专门准备数据与配置。

## 检查

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build:web
```

Windows 测试限制为两个并发 worker，并为含模块加载的测试保留 15 秒；Shell 安装器多轮集成测试上限 30 秒。Linux CI 沿用默认并发和普通测试超时。

构建入口是 `scripts/build-web.mjs`；`web/build.sh` 只保留兼容转发。`.gitattributes` 固定 Shell 与公开 Skill 包文本的 LF 换行。平台要点解析同时兼容 LF / CRLF。

## 本次验收（2026-10-15）

- 本地 0000–0042 共 43 个迁移完成，基础种子与三条演示活动已导入。
- 浏览器实测首页、图表、详情页、管理员登录与待审队列；控制台未记录错误。
- 健康接口返回 200；公开列表只返回两条已批准演示活动；管理员身份接口鉴权后返回 200，未登录返回 401。
- 未连接生产数据库，未推送、部署或发送消息。
- 验证通过：typecheck、build:web、112 个测试文件 / 1218 项 Vitest 测试、11 项审核 CLI 测试。

## 公开数据快照导入（2026-10-15 21:54 北京时间）

本机当前已用线上公开快照替换上述三条演示活动：242 条活动（含历史）、119 个公开平台、34 个会员产品、98 个会员套餐。仅访问 `https://ai-yangmao.com` 的公开 GET 接口，没有管理凭据、线上写入或部署。

快照与导入记录放在被 Git 忽略的 `.wrangler/public-import/2026-10-15/`。导入前完整 SQLite 备份为该目录下 `before-import.sqlite`；D1 常规 SQL 导出不支持本库的 FTS5 表，因此使用 SQLite 在线备份。`import-report.json` 记录来源与数量，`verification.json` 记录本地公开接口与快照逐字段对比结果：零差异。

导入工具 `scripts/import-public-local.ts` 只读取本项目 `.wrangler/public-import/` 内的离线快照，只写本项目 `.wrangler/state/v3/d1/` 内唯一的活动数据库，不读取密钥、不联网、不接受远端数据库参数。插入操作使用事务，核对数量和外键后才提交；仅当本地没有非演示活动时执行，避免今后重复导入覆盖开发修改。

```powershell
# 仅用于已准备完整公开快照、尚未导入真实活动的本地库
node --import tsx scripts/import-public-local.ts .wrangler/public-import/2026-10-15
```

保留活动原始 ID、金额、资格、官方证据和审核通过状态；4 个缺少本地信源配置的公开 sourceId 仅建立禁用关联行，不编造采集配置。会员目录与活动一起导入。

这仍不是线上后台的完整副本：未导入私有审核记录、待审任务、访客留言、采集运行历史及日报发送状态。下载的公开日报、覆盖说明和采集时间只留在快照中，不写成虚假的本地运行记录。因此本地“最近一次抓取”仍为 `—`，自动采集和推送仍未接入。线上后续变化不会自动覆盖本地。

本次验证：242 条活动和119个平台所有返回字段、完整会员目录与线上快照一致；浏览器首页显示真实羊群、月度估值及活动统计；类型检查与差异格式检查通过。
