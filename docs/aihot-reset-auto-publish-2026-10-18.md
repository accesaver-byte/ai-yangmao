# AIHOT Codex reset 自动上架

管理员于 2026-10-18 明确授权：修复重置漏采，并将经 AIHOT 发现的 Codex reset 采集后自动上架；证据使用 AIHOT 文本中链接的 X 员工原帖。

## 执行路径

`aihot-resets` → 保存线索 → 读取原帖 → 程序生成独立重置字段 → 身份系统查重 / 建档 → 按版本自动批准 → 重算线索关联。

AIHOT 是发现渠道，原帖才是权益信源，证据仍为已登记的员工级别 `staff`。不把 AIHOT 升格为厂商官方站点，不新增员工白名单。程序不经模型研判队列，因而不受模型预算或待研判数量影响；原帖不可读仍保留线索与失败状态，不能拿摘要冒充正文。

- 开关沿用 `sources.auto_publish`，只为 ID=`aihot-resets`、kind=`aihot`、URL=`https://aihot.news/api/v1/codex-resets` 的启用信源增加管理员授权例外。其他线索源保留原门槛。
- `POST /api/ingest/aihot-resets` 仅接受已存在的 AIHOT 线索及绑定 ID/作者/正文哈希的 X 第一方抓取证明，且员工账号仍需登记在 OpenAI。不接受模型生成的条目字段。
- 主公告只在同作者 `reply context` 时仍找回主帖，完整原文优先；旧引用、其他作者和错误 ID 不冒充本轮主帖。每个事件仍只有一条线索。
- 单次重置或重置卡按美西事件日记录，发布时间另存原帖精确时刻；明确 tomorrow 时次日发放。同次进度回复不是新福利。复杂多次安排、只有进度、取消/不确定计划保留常规审核，不猜窗口。
- `GET /api/ingest/aihot-resets/pending` 在读取 AIHOT 前恢复持久化候选，不依赖临时列表或七日发现窗口；永久需人工处理的候选保留审核卡，不反复占自动队列。
- `POST /api/ingest/aihot-resets/:candidateId/advance` 分请求续传；每请求受 50 次 D1 查询预算约束。使用既有身份命令幂等、活动事务、拒绝记忆、版本校验及公开 generation；不直接 UPDATE 成 approved。
- 来源开关关闭后立即阻止后续阶段。自动候选不能覆盖人工作出的修改、拒绝、撤下或已批准字段；同日轮次不明确时留给现有审核。
- 自动批准署名为 `policy:aihot-codex-reset-v1`，审核理由记载本次长期授权。现有通知出站事件仍由正常通知流程消费，不另行手动发送。
- 原文未声明的套餐或免费模型不推断；明确付费账号或具体套餐资格时使用已核实的会员目录，无法映射的限制保留审核。美元按已授权的 Plus 月价四分之一规则尝试计算，缺价保持待核价，不影响已确认真实重置的时效发布。

## 运维

管理员启用：`POST /api/admin/sources/aihot-resets/auto-publish`，body 为 `{"on":true}`；关闭同一路径传 false。凭据只使用现有管理接口，不写进文档。

发布同时需要更新 Worker 与远端 main 采集代码。只开开关或只部署 Worker，都不能证明采集管线已经采用新行为。GitHub production 的人工运行审批仍保留，这一授权只改变活动审核，不取消 Actions 的环境保护。

## 验证与发布凭证

自动流程使用真实 SQLite / D1 适配器测试，覆盖批准、重复重放、同文不同日期、同日歧义、官方证明错误、仅进度、人工编辑保护、断点续传、50 查询限制、管理员开关与其他信源隔离。另有采集端演练、读取失败和续传测试。

2026-10-18 当次状态：

- 实现提交 `3befd14`（包含前次防漏提交 `46e97ba`）；后续合入远端 main 的 Actions SHA 固定配置，保留仓库现有安全保护。
- 本地 typecheck、1322 项 Vitest、11 项审核脚本测试、web 构建通过；27 项专项测试覆盖本次自动发布与恢复路径，独立审查及相关身份回归通过。
- Worker 已部署：`d7df9f70-c874-4947-9ef0-676c69b2a6ce`，tag=`3befd14`；没有数据库迁移。
- 管理接口已启用 `aihot-resets.auto_publish=1`，并读回；`aihot-items.auto_publish=0` 保持不变。OpenAI 的 Tibo 仍仅为登记员工账号。
- 真实 AIHOT 响应恢复 Day 13 主帖；调用专用生产流程重读已批准事件，结果无失败、无人工处理，沿用 kqze；新发现主帖线索 #7743 已 linked，生产同轮次仍只有一条活动。此验收没有伪造新的生产福利。
- [PR #96](https://github.com/accesaver-byte/ai-yangmao/pull/96) 已创建并推送；当次仍受仓库 CODEOWNERS / 一个批准保护，作者为所有者本人，尚未合并。远端 main 定时采集尚不能据此声称已经使用新流程；合并后才完成持续采集切换。
- GitHub production 的每次运行审批仍保留；未批准的定时运行不会采集。
