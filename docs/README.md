# 文档索引

当前文档校对：2026-10-15。按下面的职责找现役答案；带日期的记录仅证明当次操作与快照，不能据此批准活动或推断当前数量。

## 现役文档

| 要解决的问题 | 权威入口 |
|---|---|
| 字段含义、展示影响、审核与提案边界 | [数据合同](data-contract.md) |
| 收不收、如何分类、如何估值 | [通用规则](../pipeline/learned-rules.md)；由实际抽取请求加载 |
| 某个平台的官方渠道、资格、特殊口径 | [平台要点](../pipeline/platform-notes.md)；保留核验日期，变化后重新核实 |
| 系统组件、状态和整体数据流 | [架构](design.md) |
| 社区稿如何自动寻找官方出处 | [自动官方复核](official-review-workflow.md) |
| 命令、调度、故障、发布与回滚 | [运维说明](operations.md) |
| 逐条审核的操作流程 | [仓库审核技能](../.claude/skills/yangmao-review/SKILL.md) |
| 外部 Agent 查询与 MCP 接入 | [公开接入规格](specs/public-agent-access.md) / [公开 Skill](../integrations/agent/ai-yangmao-public/SKILL.md) |
| Hermes 的查询和管理操作 | [Hermes 接入模板](../integrations/hermes/ai-yangmao/SKILL.md)；安装副本需单独核对 |
| 最近一次知识与运行态核对 | [2026-10-23 整理凭证](closeout-2026-10-23.md)（前一次：[2026-10-22](closeout-2026-10-22.md)） |

## 方案与实施范围

- [线索筛选重设计](superpowers/specs/2026-10-12-lead-screening-redesign-design.md) / [实施计划](superpowers/plans/2026-10-12-lead-screening-redesign.md)：筛选在身份系统之前记录判定与紧急度；里程碑 1 为影子模式，不关闭、不重排、不发布。

- [20:05会员资格上线结果](membership-live-2026-10-11.md)：D1关联索引、0036–0038、目录与保守资格迁移及线上验证已完成。

- [选择式会员资格交付记录](membership-release-2026-10-11.md)：记录当时 D1 配额受阻的快照；之后的上线结果见[20:05会员资格上线结果](membership-live-2026-10-11.md)。

- [会员资格选择式录入与匹配设计](superpowers/specs/2026-10-11-membership-eligibility-design.md)：日常审核不再手写会员句子，采用标准目录、条件选择和结构化匹配；用户已确认并直接实施，生产结果见发布凭证。

- [去重第二、三阶段正式入口](specs/dedupe-identity-2026-10-10/README.md)：七个增量、九项任务已合并并发布；后续启用和历史数据边界见[身份启用验证](dedupe-activation-2026-10-11.md)。
- [主规格](specs/dedupe-identity-2026-10-10/SPEC.md) / [实施任务](specs/dedupe-identity-2026-10-10/IMPLEMENTATION.md) / [45 组验收](specs/dedupe-identity-2026-10-10/ACCEPTANCE.md)。旧草稿只供历史追溯。
- [交付证据](specs/dedupe-identity-2026-10-10/P3-C-EVIDENCE.md) / [发布与兼容回滚](specs/dedupe-identity-2026-10-10/RELEASE.md)：区分本地工程验证、尚缺人工语料的现场验收及生产授权。
- [第一阶段去重修复验证](phase1-dedupe-fix-2026-10-10.md)：三个具体缺陷及0016迁移的历史验收凭证；现役迁移台账以目标环境实时检查为准。
- [权益估值与存量字段补全方案 V1](plans/benefit-valuation-and-field-completion-v1.md)：V1月度比较窗口、创作者标准用量、多模型成本中位、公测未定价与字段结案的历史方案；53条管理员研判已承接到V2，现役规则以数据合同和通用规则为准。
- [权益估值与存量字段补全方案 V2](plans/benefit-valuation-and-field-completion-v2.md)：落实53条管理员研判，新增入门套餐、模型代理、保守算法及特殊用量参照；[逐条结果](valuation-v2-results-2026-10-11.md)记录数值和实际录入状态。

## 美元估值核查

- [2026-10-10 逐条核算报告](valuation-audit-2026-10-10.md)：234 条已上架记录的旧值、新值、公式和无价结论。
- [2026-10-10 管理员研判清单](valuation-judgment-2026-10-10.md)：待判断条目、核查入口、候选算式及条件估值限制；收到决定后继续核算。

## 发布、事故与工作流查证

- [Windows 开发兼容与公开 Agent 接入（本地）](agent-windows-2026-10-20.md)：两项兼容修复、PowerShell 安装器、按系统与客户端展示 Skill / MCP 配置，以及本地验证与未发布边界。
- [Windows 与 Agent 接入复查（本地）](agent-windows-2026-10-21.md)：兼容问题修复、回归结果、Codex / Claude Code 的 Skill 与 MCP 真实调用，以及尚未完成的桌面 GUI 和官网安装资产验收。

- [OpenRouter 官方模型证据与审核恢复](openrouter-evidence-recovery-2026-10-18.md)：官方短帖补证、误关恢复、负面学习纠正与平台要点。

- [AIHOT Codex reset 自动上架](aihot-reset-auto-publish-2026-10-18.md)：管理员授权范围、员工原帖证据、持久续传及发布凭证；2026-10-22 起以 AIHOT 事件与中文备注判定。

- [D1读取额度耗尽与网站恢复](d1-quota-recovery-2026-10-11.md)：公开快照恢复浏览、身份回填关联索引、配额恢复后的调度，以及尚待验证事项。

以下保留为有明确用途的历史凭证。实现机制在上表维护，旧版本号、测试数和状态不作为现役答案。

- [2026-10-07 整理凭证](closeout-2026-10-07.md)：早期本地、远端及生产差异。
- [2026-10-07 采集故障](incident-2026-10-07-collect.md)：D1绑定参数限制、迁移台账与采集失败。
- [抽取经验发布](extraction-lessons-release-2026-10-08.md)：规则加载和真实模型回归凭证。
- [第一轮工作流审查](workflow-audit-2026-10-08.md)：来源、通知、审核与输入性能修复。
- [第二轮恢复能力复查](workflow-resilience-2026-10-08.md)：活动错配、重试、人工竞争及数据恢复；真实回归分批验证记录。
- [已审核字段漂移修复](review-drift-fix-2026-10-09.md)：同源条款变更门槛、拒绝记忆、候选校验及16条噪声清理。
- [新建入口去重修复](new-offer-dedupe-fix-2026-10-09.md)：跨ID、来源、平台误归及四个真实案例重放；与字段漂移是不同入口。
- [WorkBuddy邀请审核](workbuddy-invite-review-2026-10-09.md)：邀请门槛、人工提案及最新审核元数据读取。
- [Higgsfield试用停止领取](higgsfield-ai-influencer-end-2026-10-09.md)：管理员实测结束与未知实际截止日期。

- [受阻线索复核闭环](lead-rescue-2026-10-09.md)：尚未形成条目的reviewing积压、自动重试及人工结案入口。

## 条目审核与厂商接入记录

这些文件是核验与操作记录，不能覆盖通用规则、平台要点或后台当前状态。

| 记录 | 查证用途 |
|---|---|
| [OiiOii 接入](oiioii-onboarding-2026-10-09.md) | 官方账号、语言入口、五个信源、三条待审和送达凭证 |
| [公开文案与内部审核分离](public-copy-cleanup-2026-10-09.md) | 公开字段边界、历史核验记录迁移与权限验证 |
| [Qoder 自营产品归属](qoder-owned-product-review-2026-10-09.md) | 公司、旗下产品与第三方领取渠道的区别 |
| [StepFun 发放归属](stepfun-provider-audit-2026-10-09.md) | 实际领取渠道与厂商转述的区别 |
| [Firefly 去重](firefly-dedupe-review-2026-10-09.md) | 既有条目、提案及重复处理 |
| [Codex 重置时间](codex-reset-time-audit-2026-10-08.md) | 独立发放与传播回复、事件日与公告时间 |
| [社区条目官方复核](community-official-review-2026-10-08.md) | 当次逐条核验与未解决证据缺口 |
| [Comprehend / Claude Startups](review-comprehend-claude-startups-2026-10-08.md) | 账单模式、资助与日期精度 |
| [Vidu 核验](evidence/vidu-2026-10-08/verification.md) | 管理员亲测与官网文字的边界 |
| [收录范围预审](pending-scope-review-2026-10-07.md) | 当次待审与建议，建议不等于批准 |
| [字段预审](pending-field-review-2026-10-01.md) | 早期字段补全情况 |
| [覆盖审计](coverage-audit-2026-10-01.md) | 早期信源覆盖与人工巡检缺口 |
| [社区入库](community-intake-2026-10-01.md) | 早期社区采集实现与快照 |

## 更新约定

现役机制就地更新，不追加一份平行说明。字段改变同步数据合同，调度/接口改变同步运维及架构；平台事实写平台要点，具体审核过程留在带日期记录。发布和生产读回分别留证；日期、审核状态、源启停和数量变动时重新读取，不能改写历史记录冒充新验证。

- [已批准活动重复入队事故](incident-2026-10-10-approved-review-drift.md)：语言/摘录漂移、固定公告别名与核验失败幂等。

发布凭证：[2026-10-10去重兼容发布](dedupe-release-2026-10-10.md)。
