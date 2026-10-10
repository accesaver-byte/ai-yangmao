# 去重第二、三阶段 · Codex 执行计划

> For agentic workers: 使用仓库可用的 superpowers:executing-plans 或 subagent-driven-development，逐任务执行；先读规格，再写失败测试，再实现。没有子代理能力时由当前执行器完成，不伪称独立审查。

**Goal:** 同活动同事实版本只审一次，保留真实变化和独立优惠；历史合并可审计、可恢复。

**Architecture:** 来源观察、候选、活动实体、条款版本、审核决定分离；所有入库与审核入口调用统一服务。D1原子命令和版本保护控制竞争；历史记录通过canonical关系逻辑归并，不硬删除或改写旧审核事实。

**Tech Stack:** 当前仓库Node.js 24、TypeScript、Hono、Drizzle、Cloudflare Worker/D1；保留现有预算和Actions。

**Specs:** [第二阶段完整规格](../specs/dedupe-phase2-identity-and-decisions.md)；[第三阶段完整规格](../specs/dedupe-phase3-history-consolidation.md)。两份规格是本计划的业务依据。

## Global Constraints

- 第一阶段修复在 `fix/dedupe-review-stability-20261010` / PR #2。开始前读取PR状态；若尚未合并，从该分支建立新的工作分支，不再次实现三个已修bug。若已合并，从最新main起步。
- 第一阶段测试代码SHA为 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`；343个Vitest+8个CLI是该次快照，不是可删减的测试目标。
- 第一阶段新增 `0016_rejection_decision_key.sql`，上线必须先迁移再部署。新增迁移按实际尾号分配；不修改已应用迁移，不重复生成已手写DDL。
- 阅读并遵守AGENTS.md、data-contract、learned-rules、operations及最新代码。后来的平台/证据范围修复不得回退。
- 本计划授权实施代码、测试、隔离环境验证和PR；不自动合并、不部署、不运行生产迁移/历史apply、不发送消息、不用真实生产接口测试。
- 不改估值算法、不自动批准、不把提案覆盖到公开版本、不改变tested权限。模型sameAs和高置信度均不能绕过服务端事实冲突检查。
- 默认IDENTITY_MODE=off；shadow不改变实际审核/通知/公开数据；enforce故障不回退旧写路径。
- 所有候选、决定、任务、状态提交需可重试且有明确outcome；未知不是无差异，丢字段不是取消。
- 任何未通过测试都记录；不得用skip、删除断言、替换真实集成测试为mock输出掩盖失败。现存依赖audit告警另列，不与业务修复混为一谈。

## Review Focus

1. 不同资格/模型/积分池的优惠被标题兜底误合并：任务B/C/H的独立优惠夹具必须挡住。
2. 文案去噪吞掉真实发放周期、资格、有效期变化：任务B/D的字段级事实差异必须被提案保留。
3. rejected lead没有offer、同URL多权益及批量部分失败：任务A/E/G必须覆盖。
4. 事务零行保护、重试响应丢失、并发管理员操作：任务C/D/H必须验证数据库内完整提交或回滚，不只验证HTTP状态。
5. 历史merge造成通知重发、旧链接失效、人工提案丢失、回滚覆盖后续写入：任务H/I逐项验收。

## 启动检查（不要跳过）

- [ ] 读取git状态，保留用户未提交修改；使用独立分支/worktree，不直接改main。
- [ ] 对照PR #2的已合并状态与代码差异，记录本次BASE_SHA。发现新提交先重新审查，不套用旧行号盲改。
- [ ] 使用Node24和仓库锁文件执行 `npm ci`、`npm run typecheck`、`npm test`、`npm run build:web`，保存退出码和输出。失败是基线问题，先记录并判断影响，不宣布全绿。
- [ ] 仅在本地测试库执行迁移；测试用虚构Vendor，不加载.prod.secrets/.dev.vars生产文件。
- [ ] 建立任务ledger，记录每任务测试红/绿、commit、范围决定、未完成项。已存在的完成commit不重做。

## 任务A / PR2-A：新增身份存储与兼容回填基础

**Files:** 新增 `src/shared/identity/types.ts`；修改 `src/db/schema.ts`；新增下一号migrations；测试 `tests/identity-schema.test.ts`。

**Interfaces:** 输出BenefitFacts/Known/Cadence/ResolutionReceipt的Zod与TS合同；实现第二阶段§5所有必需关系和唯一索引。offers新增可空entity_id/version_id，旧路径仍可读写。

- [ ] 先写迁移测试：空库全部迁移成功；旧0016库增量成功；旧offer和拒绝记忆不变；重复confirmed alias/command/open_key受约束；weak alias允许多候选；closed task的open_key可空；非法目标/环关系不能提交。
- [ ] 运行 `npx vitest run tests/identity-schema.test.ts`，确认因缺失schema/约束失败，而非测试环境错误。
- [ ] 实现迁移和schema，保持旧public response一致；增加必要JSON校验，检查Drizzle元数据与手写迁移关系。
- [ ] 原测试转绿，然后完整typecheck/test；提交本任务，PR说明回滚保留新增表。

## 任务B / PR2-B：可测试的规范化与差异比较

**Files:** 新增 `src/shared/identity/normalize.ts`、`compare.ts`；测试 `tests/identity-normalize.test.ts`、`identity-compare.test.ts`；脱敏夹具 `tests/fixtures/identity/`。

**Interfaces:** `normalizeBenefitFacts(input: unknown): BenefitFacts`；`hashBenefitFacts(facts: BenefitFacts): Promise<string>`；`compareBenefitFacts(before: BenefitFacts, after: BenefitFacts): {relation:'equal'|'changed'|'insufficient'; changes:FactChange[]; conflicts:FactConflict[]}`。FactChange/FactConflict须在types.ts定义field/before/after/evidenceRefs/reasonCode。

- [ ] 写失败测试：10 USD与10美元同币种统一；6万与60k统一；100/day与100/month为changed；calendar与rolling不同；unknown/omitted不删除；不同currency/token/credit/pool不得equal；证据引用不改变termsHash，事实改变必须改变hash。
- [ ] 运行上述两个test文件，确认红测。
- [ ] 实现纯函数，不读DB/不联网；规范decimal、集合和三态；限制未经证实的币种/产品映射。
- [ ] 加反例：同标题学生/企业、同产品不同轮次、同模型第三方发放；确保通用文本相似度无法越过conflict结果。
- [ ] 全量检查转绿，提交。不要此时修改线上入口。

## 任务C / PR2-C：候选召回、统一解析与原子提交

**Files:** 新增 `src/worker/identity/repository.ts`、`resolve.ts`；必要时 `pipeline/identity-assessment.ts`；测试 `tests/identity-resolver.test.ts`、`identity-transaction.test.ts`。

**Interfaces:** `resolveCandidate(candidateId:string, expectedCandidateRevision:number, commandKey:string): Promise<ResolutionReceipt>`。依赖通过构造参数/上下文传入，禁止模块导入时读取生产环境。repository提供generation读取、索引候选查询和原子command提交；具体SQL封装在该模块。

- [ ] 先写集成红测：approved/rejected/pending都被召回；同页面多优惠不合并；无offer拒绝可返回canonicalOfferId=null；强别名优先但有事实冲突进入identity_pending；检索失败返回deferred而不是new。
- [ ] 写数据库并发测试：两请求读取同G，一请求成功后另一必须重新召回；同command同payload回放相同receipt；不同payload409；审计异常和零行guard不能残留applied回执或半套实体。
- [ ] 实现第二阶段§7/§9；先G后检索，原子CAS并递增；所有影响身份的写入口都必须加入generation管理。
- [ ] 若需要模型，只作为受预算管理的判定建议；校验返回ID、原文、scope；输出uncertain是合法完成，不要无限重试。没有API key的离线测试必须可运行。
- [ ] 在SQLite和隔离Wrangler/D1执行事务行为测试。记录两种环境的差异，未跑真实D1不能写“生产验证”。
- [ ] 全量检查转绿，提交；外部模型/向量索引仍不作为硬依赖。

## 任务D / PR2-D：决定范围、真实更新和重开

**Files:** 新增 `src/worker/identity/decisions.ts`；修改admin/ingest审核适配；测试 `tests/identity-decisions.test.ts`。

**Interfaces:** decision命令至少包含commandKey、target、expectedRevision、scope、reasonCode、basis、reopenConditions；receipt包含decisionId/taskId和新revision。所有approve/reject/reopen均经同一提交服务。

- [ ] 红测：普通套餐拒绝跨语同版本拦截；证据不足补官方证据只生成一个reopen；无依据改写不重开；source_unavailable只deferred；旧duplicate拒绝不得覆盖主记录批准。
- [ ] 红测：同数字真实周期变化、明确资格调整进入提案；缺字段/改译法不覆盖已审值；active manualFields保留；新URL依据需核对；只有明确批准才更新公开版本。
- [ ] 实现不可变Decision与supersedes链、最窄拒绝范围默认值、同实体同问题唯一open_key；phase1拒绝batch保护不可退化。
- [ ] 通过API和实际DB验证403/409、无审批越权、无半套记忆；全量转绿并提交。

## 任务E / PR2-E：接通全部入口、审核界面与通知

**Files:** 修改 `pipeline/run.ts`、`pipeline/lead-review.ts`、`pipeline/official-review.ts`、`src/worker/index.ts`、`src/worker/admin.ts`、`src/worker/lead-review.ts`；先检查现有web目录再修改实际后台组件；测试 `tests/identity-workflow.test.ts` 和现有frontend/notification测试。

**Interfaces:** 新Observation/Candidate/resolve API；旧/offers适配；所有第一方调用方统一读取ResolutionReceipt.outcome；新增身份任务后台读/处理入口。

- [ ] 红测：三候选线索“重复、新候选、失败”逐项保存，只重试失败；有duplicateId但明确error仍不得算成功；身份任务不会一轮一张卡。
- [ ] 红测：/manual补相同URL不清resolution，显式reopen才重开；officialReviewJobId/leadReviewJobId过期仍拒绝；所有写入口无法通过sameAs绕过解析器。
- [ ] 红测：社区新来源不刷新官方核验时间；tested不可由ingest设置；私有理由/raw/memo不进入公开输出；更新lastSeen不改变通知key。
- [ ] 接入off/shadow/enforce和灰度平台；shadow只记录分歧、不制造人审/通知；故障不回退旧写入。
- [ ] 后台展示原文、候选主记录、上次决定与本次差异；同任务多版本并列，不能最后一条覆盖前一条人工提案。
- [ ] 完整typecheck/test/build:web，并用隔离浏览器走审核任务；提交并同步data-contract/design/operations。

## 任务F / PR2-F：评测、灰度与第二阶段交付

**Files:** `tests/fixtures/identity/`、`scripts/eval-identity.ts`、`docs/operations.md`；不写真实数据到fixtures。

- [ ] 建立SPEC规定的120对分族标注夹具；评测输出每例输入、预期、实际、依据，计算误合并、重复任务和真实变化漏报。
- [ ] 确定性场景全部通过；独立优惠误合并=0、真实变化静默吞掉=0、已确认重复重新开任务=0。未解决样本明确列为identity_pending，不算识别成功。
- [ ] 授权隔离环境模拟两个采集轮次，记录DB读写/token/费用与异常。无权限时交付模拟结果并明确线上灰度未执行。
- [ ] 编写启用/关闭enforce、兼容回退和迁移顺序。只有用户另行批准才生产灰度。

## 任务G / PR3-A：只读审计与一对一历史回填

**Files:** `scripts/identity-history.ts`、`src/worker/identity/history.ts`、下一号migrations；测试 `tests/identity-backfill.test.ts`。

**Interfaces:** audit/plan-backfill/apply-backfill/verify，manifest带schema版本、snapshot hash、scope、cursor和legacy fingerprints。

- [ ] 红测：缺manifest不写；默认dry-run；旧offers/rejected updates/无offer rejected leads均得到最窄映射；未知原因不得伪造历史审批。
- [ ] 红测：一次跑完与中断续跑相同；重跑两遍第二遍新增=0；200+记录不超绑定参数；源行并发改变→conflicted不覆盖。
- [ ] 实现稳定游标、批量20条回填、账本和权限；第一遍不merge、不改USD/lastVerifiedAt/公开状态。
- [ ] 副本验证旧public output在回填后相同，完整检查转绿，提交。

## 任务H / PR3-B：可批准manifest、合并与回滚

**Files:** `src/worker/identity/merge.ts`、历史CLI/API、下一号migrations；测试 `tests/identity-merge.test.ts`、`identity-rollback.test.ts`。

**Interfaces:** plan-merge/approve-plan/apply-merge/rollback；operationKey=planHash+groupId；expected generations/revisions/fingerprints；每组最多10实体。

- [ ] 红测：标题相似但独立优惠不能执行merge；弱pair不可传递闭包；未经批准/被篡改manifest拒绝；reviewer与ingest无权apply。
- [ ] 红测：approved+rejected duplicate不变批准；不同approved条款、manualFields/proposal、pending/unknown delivery默认阻塞；旧决定不改写。
- [ ] 实现root redirect/version equivalence、before/after-image、事务回执；必要后置条件在SQL事务内断言。
- [ ] 红测并实现：原子错误完整回滚；重复key不重复事件；没有后续写可回滚；有后续写则409/split任务，不盲覆盖新数据；redirect环/8跳上限。
- [ ] 完整测试与隔离D1验证，提交；不得拿实际生产ID试合并。

## 任务I / PR3-C：所有读取、旧链接、通知和最终演练

**Files:** public Worker路由、现有web详情/hash路由、通知构建、history verify；测试 `tests/identity-canonical-views.test.ts`、`identity-history-notifications.test.ts`。

- [ ] 红测：旧ID→正确canonical公开投影，不泄漏rejected/pending；列表/平台/RSS/日历/图表不重复计数，USD不因合并相加。
- [ ] 红测：历史reviews/revisions/leads引用可追溯原ID；新增解析能读成员旧版本/拒绝，不因redirect后找不到历史而重审。
- [ ] 红测：merge不重发new；实质新版本changed可发；日报按天仍允许；unknown发送不自动重试。
- [ ] 全量检查/build:web/浏览器回归；对脱敏副本依次audit→backfill→plan→approve→apply一组→verify→rollback→verify，保存报告。
- [ ] 完成交付表，区分代码/隔离测试/生产回填/生产部署；没有授权的生产步骤标“未执行”，不要填成功。

## 每个任务结束的证据

记录BASE_SHA/HEAD_SHA、变更文件、红测失败的断言、绿测命令/退出码/数量、全量测试结果、迁移版本、未解决风险。完成一次可独立审查的小PR后再进入下一任务；是否合并/堆叠由用户选择，不在本计划内自动合并。

最终交付：第二阶段所有入口一致；第三阶段干跑/计划/确认/执行/验证/回滚工具；清晰的未实施事项。没有真实数据审计时不声称“线上重复已清零”。

## 可直接交给 Codex 的任务文本

```text
请读取AGENTS.md，以及：
- docs/phase1-dedupe-fix-2026-10-10.md
- docs/specs/dedupe-phase2-identity-and-decisions.md
- docs/specs/dedupe-phase3-history-consolidation.md
- docs/plans/dedupe-codex-execution.md

先核实PR #2是否已合并：未合并从fix/dedupe-review-stability-20261010创建新工作分支；已合并从最新main开始。不要重复第一阶段已完成的三个修复，保留main后来新增的修复。先记录基线并运行现有检查。

按任务A至I分批实施，先测试后代码，每批保持可独立审查。当前先做任务A，后续按依赖推进；记录实际红绿测试与git提交。关键原则是身份/事实版本/审核决定分离、全入口统一解析、拒绝范围与重开条件、原子幂等、历史合并可逆，不能用更低字符串阈值或更多平台特例替代。

只改独立分支并提交PR；仅使用本地/隔离数据库。不得自动合并、部署、执行生产迁移、历史apply、真实采集、批准活动或发送消息。外部调用和生产操作需要另行授权。所有失败和未验证项如实报告。
```
