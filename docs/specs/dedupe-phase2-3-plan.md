# 第二、三阶段去重实施计划

> For agentic workers: use superpowers:executing-plans or subagent-driven-development when available. Execute one independently testable task at a time; do not assume planning documents grant production access.

**Goal:** 同一活动同版只审核一次，并能安全、可逆地整理历史重复。

**Architecture:** 保留 offers/offer_proposals 作为现有展示与编辑投影；新增 subject、observation、candidate、terms、decision、case 作为持久身份与审核依据。服务端统一解析和CAS提交；历史整理采用经批准的逻辑合并，不删除原始记录。

**Tech Stack:** 仓库现有 Node 24、TypeScript、Hono、Drizzle、Cloudflare D1、Vitest、SQLite集成harness。

**Spec:** [dedupe-phase2-3.md](dedupe-phase2-3.md)。本文件只细化执行步骤，不代表功能已实现；规格有冲突先记录具体裁决，不得默默放宽验收。

## Global Constraints

- 工作只在独立分支；读取最新AGENTS.md、data-contract.md、learned-rules.md、operations.md和PR #2实际diff。PR #2未合并时以其已验证代码为前置，不重复实现第一阶段，也不自行合并main。
- 没有生产授权时只做代码、测试和明确的离线/本地演练。禁止部署、远端迁移、生产导出、真实模型评测、采集与消息发送；禁止默认读取.prod.secrets。
- 金额/单位/周期/池/资格/地区/产品/轮次不能被词面相似度绕过；模型sameAs只是候选。
- 未经批准不能修改公开版本；主动人工提案、历史审核、拒绝范围、通知unknown/pending都必须保留。
- 新schema使用增量迁移；第一阶段0016须先存在。读取当前migration编号后分配新号，禁止覆盖已存在编号。
- 保留已有Mistral原文身份、lead-scope和重置保护。每项先写实际行为测试、确认红测，再实现，再跑完整npm test。
- 框架/锁文件/部署流程不在本计划内升级。已有npm audit的high项另行评估，不能假装本去重PR已修复。

## Review Focus

1. 两份unknown不能因hash相同自动判同或拒绝；由任务1、4覆盖。
2. 不同ID并发同时判断“新活动”，以及旧人工卡片批准到不同对象；由任务5、7覆盖。
3. 没有offer的拒绝事项和一条lead部分候选失败；由任务2、6覆盖。
4. 合并后unknown送达、旧fragment链接、收藏与统计不能重推/重复计数；由任务8、11覆盖。
5. 合并后新增人工编辑使回滚失效，关闭resolver也必须保留canonical兼容读；由任务9、12覆盖。

## 执行记录与统一完成标准

创建 `docs/implementation/dedupe-progress.md`，逐项记录任务号、代码SHA、红测名/原因、绿测命令/结果、未执行验证、设计裁决。阶段2未开始时全部勾选为空，不预填通过。

每项最后都运行：`npm run typecheck`、`npm test`、`git diff --check`；涉及公开接口/前端再运行`npm run build:web`。测试期间只使用夹具地址、mock模型传输、本地数据库。真正业务函数/SQL不能mock成固定成功。测试失败必须列出，不跳过、不删断言。

下文命令指实施后新增的文件，**不是声称这些文件现在存在**。新增测试路径可按仓库测试扫描规则调整，但需同步记录映射。每项最后提交独立commit，建议提交信息见标题。

## 任务1：事实、证据与结果合同 — feat: define identity facts and resolution contracts

**Files:** 新建 `src/shared/identity/facts.ts`、`normalize.ts`、`outcomes.ts`；新建 `tests/identity/facts.test.ts`。

**Interfaces:** 导出 `Fact<T>`、`BenefitFactsV1`、`ResolutionResult`；`normalizeBenefitFacts(input: unknown): BenefitFactsV1`；`hashFacts(facts: BenefitFactsV1): Promise<string>`；`normalizeSourceUrl(input: string): {urlKey: string; safeUrl: string | null}`。使用Web Crypto以兼容Worker；Node测试运行相同实现。

- [ ] 先写 `normalizes_numeric_aliases_without_changing_units`：6万/60,000/60k同单位同hash；100/day与100/month、100credits与100tokens不同hash。
- [ ] 写 `does_not_treat_unknown_as_zero_or_known_equal`、`preserves_date_precision_and_and_or_eligibility`、`keeps_identity_queries_and_spa_fragments`、`redacts_credentials_without_guessing_identity`。
- [ ] 运行 `npx vitest run tests/identity/facts.test.ts`，记录缺失行为的失败；实现SPEC §4的Zod判别类型、规范化与稳定序列化。
- [ ] 检查单位币种歧义、池发行方、partial/full模型列表、URL追踪参数；key/标题/语言/估值不进入事实hash。
- [ ] 针对测试与统一检查通过后提交。

## 任务2：观察、候选、主体及一对一回填 — feat: persist dedupe observations and subjects

**Files:** 修改`src/db/schema.ts`；追加schema迁移；新建`src/worker/identity/repository.ts`、`scripts/dedupe/bootstrap-subjects.ts`、`tests/identity/persistence.test.ts`。

**Interfaces:** `saveObservation(db: D1Database, input: ObservationInput): Promise<ObservationReceipt>`；`saveCandidate(db, input: CandidateInput): Promise<CandidateReceipt>`；导出两类输入/回执类型，回执含id、created、revision；`bootstrapSubjects(db, options: {cursor: string | null; limit: number; dryRun: boolean}): Promise<BootstrapPage>`。BootstrapPage含nextCursor、created/linked/conflicts及inputHash。

- [ ] 建迁移测试：旧库升新schema、空库全部迁移、所有FK/unique/check有效、超过100绑定由harness报错。
- [ ] 写 `replays_observation_without_new_candidate`、`separates_two_benefits_on_one_page`、`bootstraps_rejected_offer_and_lead_only_rejection_without_publishing`、`resumes_bootstrap_without_duplicate_subjects`。
- [ ] 红测后实现SPEC §3全部基础表，offers.subject_id可空；同一旧offer只创建一个subject，保留ID、状态、日期和全部原文。
- [ ] legacy_offer_id需要**全局唯一**的confirmed别名索引，不能因为platform纠正就在两平台创建相同旧ID映射；通用强别名索引仍按platform/scope。旧ID原始归属保留，确认更正追加decision。
- [ ] 长正文按UTF8字节限制，body_complete=0不得用于旧条款消失推断；有决定引用的摘录/上下文不得清除。清理功能默认关闭。
- [ ] dryRun只返回计划，0写入；真实apply只接受显式传入的本地DB，不接生产默认值。运行针对与统一检查，提交。

## 任务3：包含拒绝历史的候选召回 — feat: retrieve all review states for identity matching

**Files:** 新建`src/worker/identity/retrieval.ts`、`src/shared/identity/aliases.ts`、`tests/identity/retrieval.test.ts`；必要FTS增量迁移。

**Interfaces:** `retrieveIdentityCandidates(db: D1Database, input: {candidateId: string; facts: BenefitFactsV1; limit?: number}): Promise<RetrievalResult>`；RetrievalResult固定包含subjects、catalogEpoch、complete、truncated、matchedAliasIds。subjects包含身份/条款版本、有效历史决定和证据，不包含全库。

- [ ] 红测 `retrieves_approved_pending_rejected_expired_and_no_offer_subjects`、`does_not_hide_exact_alias_beyond_top20`、`fails_closed_on_index_error_or_truncation`。
- [ ] 实现按产品/强别名优先、结构化阻断字段其次、FTS词面召回最后；默认20条，参数绑定和分页可控。
- [ ] 中文受控词/相邻字分词与多语确认别名参与召回；FTS匹配不得自行写入link/拒绝。
- [ ] 写20k主体/50k观察固定seed夹具查询测试，确认拒绝记录仍可命中，SQL有索引且无整库模型提示。
- [ ] 统一检查、记录实际查询指标并提交；不以该本地夹具声称线上性能。

## 任务4：主体比较、条款比较与拒绝范围 — feat: resolve identity and scoped rejection policy

**Files:** 新建`src/shared/identity/compare.ts`、`decision-policy.ts`；`tests/identity/compare.test.ts`、`decision-policy.test.ts`。

**Interfaces:** `compareIdentity(candidate: IdentityInput, existing: IdentityInput): IdentityComparison`（same_subject/different_subject/unresolved）；`compareTerms(before: BenefitFactsV1, after: BenefitFactsV1, evidence: EvidenceContext): TermsComparison`（same_terms/changed_terms/insufficient_evidence）；`evaluateDecision(decision: StoredDecision, context: DecisionContext): DecisionApplicability`（applies/reopen_candidate/out_of_scope/unresolved）。上述输入类型必须导出并在后续模块复用。

- [ ] 写跨语言已确认同版、同额不同资格/池/机制/代际、同日两次reset、转述日期变化、两份unknown、partial模型集合反例。
- [ ] 写同数字周期变化、明确关联的新官方公告、旧句仅缺失、A→B→A、补证而非新条款，以及active manual proposal保护。
- [ ] 写拒绝矩阵每行：paid_bundle换说法仍抑制，真实独立新赠额不被旧政策误杀；insufficient_evidence遇官方新证据只开一个重审case。
- [ ] 先红测，再实现逐字段依据/冲突的判别结构；sameAs、标题、数字、页hash不得单独硬判，A≈B≈C不得传递式合并。
- [ ] 固定X旧帖不变不重开；新公告明确指向旧计划才可能changed；证据权威/连续引用检查不能被模型绕过。
- [ ] 统一检查并提交。

## 任务5：统一解析服务与幂等CAS提交 — feat: commit identity resolutions atomically

**Files:** 新建`src/worker/identity/commands.ts`、`resolver.ts`、`routes.ts`；`tests/identity/commands.test.ts`、`resolver.test.ts`。

**Interfaces:** `resolveCandidate(env: IdentityEnv, request: {commandKey: string; candidateId: string; expectedCandidateRevision: number}): Promise<ResolutionResult>`；`readIdentityCommand(db: D1Database, key: string): Promise<ResolutionResult | null>`；IdentityEnv只含DB和明确注入的comparison/budget依赖，不能偷偷读生产secret文件。

- [ ] 红测同command同body重放、同command不同body409、旧candidate版本409、不同ID并发20请求同活动只一个subject/offer/case。
- [ ] 将候选召回/比较与提交分离；batch内按partition epoch/CAS建立本命令marker，所有后续write依赖marker；0行保护传递，SQL失败全回滚。
- [ ] 人工别名、产品更正、拒绝、合并都推进同一epoch；并发失败必须重新召回，不复用旧no_duplicate结果。
- [ ] 写失效epoch、数据库失败、写后响应丢失再读回、跨产品更正、别名环等测试。
- [ ] 模型comparison适配按SPEC限定1次/候选、最多8主体、30秒，保留其他未排除候选的不确定性；预算不足/解析错误deferred，不猜成功。单独测试prompt injection、非法targetId、伪造quote。
- [ ] 添加command读回API，确认重复不会重复入库/通知；统一检查提交。

## 任务6：所有采集入口与候选级进度 — refactor: route ingestion through canonical identity

**Files:** 修改`pipeline/run.ts`、`pipeline/offer-draft.ts`、`pipeline/lead-review.ts`、`pipeline/official-review.ts`、`src/worker/index.ts`、两类Worker复核文件；新建`src/shared/identity/lead-progress.ts`、`tests/identity/intake.test.ts`；扩展现有pipeline-workflow tests。

**Interfaces:** `deriveLeadProgress(results: ResolutionResult[], inputComplete: boolean): LeadProgress`，返回processingState、legacyStatus、resolvedCandidateIds、retryCandidateIds、caseIds、offerIds、decisionIds；接入任务5的同一resolveCandidate，无第二套判重实现。

- [ ] 写一篇6候选其中2重复/1技术失败，验证只重试失败候选；分段次序变化不抹掉以前完成的候选。
- [ ] 明确兼容状态：等待人工case的lead可仍显示reviewing，但已生成case的candidate不会再次初抽；全为无offer拒绝则lead rejected且有decision；有offer成功关联才填legacy offer_id，不能伪造ID；invalid保留阻塞诊断，不算业务拒绝或已完成。
- [ ] 原`/ingest/offers`适配legacy payload -> observation/candidate ->resolver；id/sameAs只是检索提示。未接新客户端不能绕过服务端。
- [ ] 保留第一阶段duplicateId终态修复、来源范围检查、官方原文资格检查和人工字段保护。
- [ ] 非完整原文不能证明旧条款取消，索引失败不回落空列表再建offer；所有多候选返回值保持可读回。
- [ ] 检查入口清单全覆盖，再跑针对测试与完整管线回归、提交。

## 任务7：统一审批、明确重开和原子决定 — feat: add versioned identity review cases

**Files:** 修改`src/worker/admin.ts`及审核CLI；新建`src/worker/identity/admin.ts`、`tests/identity/admin.test.ts`；按实际前端文件定位加入case卡片（先读目录，不猜文件名）。

**Interfaces:** `applyIdentityDecision(db, command: IdentityDecisionCommand): Promise<DecisionReceipt>`；命令包含commandKey、case/subject预期revision、action、reason、evidenceRefs、scope及目标版本；Receipt含decisionId、affectedCaseId、canonicalOfferId可空、newRevision。

- [ ] 红测旧卡片/旧版本409、身份link不自动approve、人工separate不覆盖原决定、已拒无offer重开、相同reopen重放只一case。
- [ ] `/manual`默认补充来源，不能把linked/rejected重置new；reopen需要明确决定ID、理由、版本和证据。CLI补链接显示已有决定与显式重开提示。
- [ ] approve/edit/reject/unpublish/official-result在提交前再次校验canonical身份和基线；保存决定/投影/case/audit为一致提交。
- [ ] 保留source权限/白名单/估值V1校验，身份明确不是自动上架许可。第一轮enforce对新主体强制pending；不能由语义比较自动启用autoPublish。
- [ ] UI展示历史决定、字段相同/冲突和原文；新来源仅补证不刷新materialRevision；使用现有审核版本与输入草稿保护。
- [ ] 完整测试、前端构建与提交。

## 任务8：canonical兼容读取与通知事件 — feat: make public views and notices canonical-aware

**Files:** 新建`src/worker/identity/canonical-read.ts`、`notification-events.ts`、`tests/identity/canonical-read.test.ts`、`notifications.test.ts`；修改公开API/RSS、admin.buildNotice、feishu相关使用点和实际前端ID解析。

**Interfaces:** `resolveCanonicalSubject(db: D1Database, subjectId: string): Promise<CanonicalSubject>`；`resolveLegacyOffer(db, requestedId: string): Promise<CanonicalOffer | null>`；`reviewEventKey(input: {caseId: string; materialRevision: number; channel: string}): string`。

- [ ] 红测旧ID读取已批准root、rejected目标404不泄露、旧管理写409、映射环拒绝；列表/平台页/日历/统计/RSS同活动计一次。
- [ ] fragment在浏览器解析后replaceState，不能只加服务器301；收藏兼容保留旧key映射。
- [ ] 通知key基于case/实质版本/channel；重复观察/翻译不新发，真变更经批准才产生changed事件。
- [ ] delivery receipt不可改写；成员已有sent不重复new，pending/unknown继续阻止发送，不能因batch指纹变化重试。日志只使用合成webhook测试，严禁live发送。
- [ ] canonical读独立于IDENTITY_MODE开关，未来历史合并后off也不重新公开loser。完整测试/build后提交。

## 任务9：golden语料、shadow模式及第二阶段收尾 — feat: add dedupe shadow evaluation and rollout gates

**Files:** 新建`tests/fixtures/identity/golden.json`、`tests/identity/golden.test.ts`、`scripts/dedupe/evaluate.ts`、`tests/identity/rollout.test.ts`；增加身份metrics/配置读取；更新相关运维和数据合同。

**Interfaces:** `evaluateCorpus(corpus: GoldenCorpus, resolver: OfflineResolver): Promise<EvaluationReport>`；Report包含输入/配置hash、每例期望/实际、falseMerge/falseSuppress、新case数、模型调用数；不含虚构生产指标。

- [ ] 120条同版变体、至少60条hard negatives/真实变化，人工审阅预期；纳入最近Mistral/重置/第三方错归回归，敏感数据不入夹具。
- [ ] shadow模式验证：只写模拟结果/指标，不改offers/proposals/leads或发通知；off不启用新解析；allowlist空不enforce。
- [ ] 数据库/模型异常不打业务拒绝标签；已终结观察0LLM/0新case/0新通知；不能把所有输入改uncertain凑零误合并。
- [ ] 完整检查与隔离D1验证说明。没有明确隔离D1授权时列为未执行，不冒充SQLite等同真实D1。
- [ ] 提交第二阶段PR与验收报告。至少7个实际运行日及100条可评估观察的生产shadow门槛由发布者后来执行，本任务不得擅自采集。

## 任务10：历史只读扫描和不可变合并计划 — feat: plan historical dedupe without data mutation

**Prerequisite:** 第二阶段主体一对一覆盖和兼容读测试通过；否则只用合成快照开发工具，不做真实合并。

**Files:** 新建`scripts/dedupe/snapshot.ts`、`scan.ts`、`plan.ts`；增量迁移merge plan/event/backfill表；`tests/dedupe-history/planning.test.ts`。

**Interfaces:** `scanHistory(snapshot: LocalSnapshot, options: ScanOptions): Promise<HistoricalScanReport>`；`buildMergePlan(report, selections: ApprovedGroupSelection[]): MergePlan`；`hashMergePlan(plan: MergePlan): Promise<string>`。ApprovedGroupSelection只是计划作者的选择，**不是管理员已批准apply**，实际批准单独记录。

- [ ] 红测dry-run0写、快照hash/版本清单、页间写入检测、所有状态及无offer拒绝主体扫描。
- [ ] 配对检查而非连通分量硬合并；同资格/单位/池冲突单列，不作为自动合并候选。
- [ ] plan记录成员版本、canonical建议、选定公开版本、人工字段/提案冲突、送达状态、引用数与回滚摘要；改plan导致hash变化需重批。
- [ ] CLI要求`--input <local file>`；禁止无参数连接线上。默认最多20组/批、10主体/组；超预算显式拒绝，不静默截断。
- [ ] 针对和统一检查后提交。

## 任务11：经批准计划的原子逻辑合并 — feat: apply audited canonical merges with checkpoints

**Files:** 新建`src/worker/identity/history-merge.ts`、`scripts/dedupe/apply.ts`、`tests/dedupe-history/apply.test.ts`；接入显式管理员计划批准/应用接口，不开放审核员批量合并权限。

**Interfaces:** `applyMergeGroup(db: D1Database, input: {planId: string; planHash: string; groupId: string; commandKey: string}): Promise<MergeReceipt>`；Receipt为applied/already_applied/conflict，含前后版本摘要和事件ID。环境/授权校验由调用入口强制执行。

- [ ] 红测计划未批/过期/改hash、旧版本、人工提案冲突、在途审核任务、pending/unknown送达：全部0写或明确conflict。
- [ ] 每组CAS加唯一marker、before/after审计、映射变更和必要兼容引用在短batch完成；0行传播，SQL失败回滚，跨产品按排序partition校验。
- [ ] loser原offer及review_state、review/revision作者日期、原文、reject范围和delivery payload不覆盖；新读经canonical聚合。不要自动拼接非空字段或相加估值。
- [ ] 写同command重跑、响应丢失、批次中断续跑、成员二次编辑冲突；不可先删后搬。
- [ ] 验证旧链接收藏、所有公开统计、new/changed通知不会在整理后重新触发；历史最高revision ID不得当新变化。
- [ ] 完整测试/build，提交离线apply演练报告；生产apply仍需单独授权。

## 任务12：可逆回滚、依赖冲突与第三阶段交付 — feat: reconcile historical merges reversibly

**Files:** 新建`scripts/dedupe/revert.ts`、`tests/dedupe-history/revert.test.ts`、`docs/dedupe-rollout-runbook.md`；补充历史resolver回滚路径。

**Interfaces:** `revertMergeGroup(db, input: {mergeCommandKey: string; revertCommandKey: string; expectedAfterHash: string}): Promise<RevertReceipt>`；结果reverted/already_reverted/conflict；冲突时返回后续变更摘要，不覆盖用户新操作。

- [ ] 红测可安全撤销后恢复映射/必要引用但保留merge+unmerge审计；已发送消息不撤回、不重发。
- [ ] 合并后新增审核/编辑/候选/送达使after不匹配时conflict，生成新处理计划而非强制rollback。
- [ ] 验证IDENTITY_MODE=off仍读canonical；发布runbook明确历史合并后不可降级到不懂映射的第一阶段Worker。
- [ ] 跑完整空库/旧库升级、批次重跑、故障注入、前端链接/统计测试；记录真实隔离D1测试是否执行及所有未验证项。
- [ ] 第三阶段PR包含扫描/计划/批准/apply/revert/checkpoint工具、离线演练、数据风险、生产授权门槛。没有生产快照就明确0条真实记录被整理。

## 交接完成条件

第二阶段完成代码不等于通过生产shadow门槛，第三阶段工具完成不等于历史数据已清理。每次交付列出：实际基线与提交、已实现任务、红/绿测试、失败或未执行项、schema部署顺序、回滚限制和实际外部副作用。不要把“减少待办数量”当唯一成功标准，必须同时证明没有误合并、误抑制真实新活动。
