# 第二阶段 SPEC：统一活动身份、条款版本与拒绝记忆 V1

状态：待 Codex 实施的设计，不代表现役系统已具有这些能力。日期：2026-10-10。
前置：第一阶段 PR #2 的代码及迁移，或经核对等价的修复。代码基线为 main `7cea69d95d2c27e2c1ebd7641a94bab2a696901d`，已验证修复代码 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`；开工须读取实际 HEAD，不能覆盖后续修复。
相关：[第三阶段历史治理](dedupe-phase3-historical-reconciliation-v1.md)、[Codex 执行入口](../plans/dedupe-phase2-3-codex-handoff.md)、[第一阶段记录](../phase1-dedupe-fix-2026-10-10.md)。

## 0. 授权与边界

这份 SPEC 授权范围是设计交付。Codex 收到用户实施指令后，在独立分支编写代码和测试；生产部署、远程 D1 迁移、生产回填/合并、通知发送仍须单独授权。持有令牌不扩大授权。不得运行 seed --remote 重建生产库。

本阶段是持久身份与审核机制的增量改造，不重写网站，不改变收录口径、估值 V1 或管理员权限。现役业务规则以 `AGENTS.md`、`docs/data-contract.md`、`pipeline/learned-rules.md` 为准；这份 SPEC 只在新机制实现并启用后替代其中对应的去重机制描述。若后续规则冲突，先记录设计差异，不静默改收录标准。

本阶段包含：来源观察、标准化事实、全状态候选检索、统一身份解析、持久拒绝范围、幂等任务、并发保护、管理员身份核对、所有写入入口接入和公开/通知兼容。旧库一对一建档属于基础接入；多条旧记录真正合并属于第三阶段。

不包含：无监督批量合并存量、自动通过新优惠、额外购买向量服务、自动更新人民币/美元估值、把所有同品牌产品合并、将受保护数据发送给未配置的新模型供应商。

## 1. 目标与不可破坏的约束

目标：同一现实优惠可反复被发现，但同一事实版本最多产生一个未结审核任务；已批准或已拒绝版本不会因 URL、语言、标题、模型 ID 改变再次送审。真正的政策变化仍能进入提案，独立活动不丢失。

必须同时满足以下不变量：

1. 采集内容不是活动身份。一个网页可含多个活动，一个活动可有多个来源。
2. 主身份由服务端分配并持久保存；模型 `key`、`sameAs`、`sameOccurrenceAs` 仅为建议，必须验证，不能直接覆盖已有 ID。
3. 所有状态参与查重：pending、approved、rejected、expired、withdrawn、尚未形成 offer 的被拒线索。过期/撤回是生命周期，不等同审核拒绝。
4. 对已批准活动，公开字段始终来自最后批准版本；新事实未经批准不覆盖。补充来源不修改 `lastVerifiedAt`；只有通过现役官方核验条件或人工实测才更新它。
5. `UNKNOWN` 不等于相同、零、无限、无门槛；漏字段不等于官方删除字段。
6. 只因技术故障、无索引、检索超时、额度耗尽，不得判为无历史或新优惠。保存观察后延期；既不假成功，也不强行拒绝。
7. 拒绝决定有对象、版本/谓词范围、依据和重开条件。证据不足不是永久黑名单；重复拒绝应指向主对象。
8. 同一命令重试、并发采集、状态竞争，不得增加重复任务、重复决定、重复通知；返回成功前核对事务结果。
9. 保留所有人工修改、审核日志、旧链接、历史证据；不可把身份合并当作批准、实测或下架。
10. 相似度、向量距离、模型置信分数均不能单独授权合并。独立资格/产品/积分池/活动轮次的冲突必须先处理。
11. 母公司、模型提供者、发放产品、第三方使用渠道分开。平台关系不能将 Qoder、Qwen Code、第三方 Qwen 调用额度当成一项。
12. 审核统计只统计真实人工决定，重复关联不新增 approve/reject 准确率样本。

## 2. 术语及身份边界

- **Observation（来源观察）**：某 URL 在某一内容版本中出现的原文。重复抓取相同内容只更新 lastSeen/seenCount。
- **Candidate（抽取候选）**：从观察中抽出的一个疑似权益。不是公开活动，也不是审核决定。
- **Entity（活动实体）**：可指认的现实优惠计划或独立发放事件。即使被拒、未产生 offer，也能持有实体身份。
- **Version（条款版本）**：同一实体的一组业务事实及依据，内容不可变；展示改写、抓取时间不是新版本。
- **Decision（审核决定）**：人工或明确规则对一个对象/版本作出的决定；与暂存 proposal 的寿命无关。
- **Task（任务）**：首次审核、条款变化审核、身份核对或证据补齐的一项工作。相同对象同版本任务去重。

### 2.1 同一实体还是新实体

常驻免费计划：每日正常刷新仍是同一实体；额度从每日100改成每月100是新版本。注册奖励金额由10美元变20美元，在官方说明为同一计划修订时是新版本。独立注册礼与邀请礼即使金额相同也不同。

一次性赠送/重置：每次可独立领取的官方发放是独立实体，可用 familyKey 建立系列关系；日期只是线索，不是唯一身份。同一天可能两次发放，同一发放也可能跨天预告、确认和传播。无法确认 occurrence 时必须为身份待核对，不生成一个凭日期猜出的事件。

活动延期：官方明确延续原领取资格、原活动/兑换入口且并非新增领取机会，则同实体新版本。明确第二轮、用户可再领一次或设备代际权益独立，则新实体。帖子/页面 ID 变化本身既不能证明新轮次，也不能证明同轮次。

同一活动包含多个档位、模型、权益池：以现役人工确认的活动边界为准，facts 内表达多个 components；不能为每个模型机械拆实体。两个可独立领取机制仍应分开。

### 2.2 不要构造一个万能哈希当永久主键

entityId 为服务端 UUID；canonicalOfferId 复用保留的 offers.id。条款哈希只标识事实版本，不能标识现实活动。资格、金额有时发生版本变化，有时用于区分并行活动；变化必须先判断关系，而非直接用全部字段拼接身份哈希。

## 3. 规范化事实合同

新增 `src/shared/identity-contract.ts`，使用 Zod 验证输入和模型输出。导出下列类型与纯函数；不要将解析逻辑写进 Worker 路由。

```ts
type Fact<T> =
  | { state: 'known'; value: T; evidenceRefs: string[] }
  | { state: 'unknown' }
  | { state: 'not_applicable'; evidenceRefs: string[] };
type Relation = 'same_version' | 'changed_terms' | 'distinct' | 'uncertain';
type DecisionScope = 'version' | 'entity' | 'predicate' | 'evidence_gap';
type ResolutionOutcome =
  | 'duplicate_approved' | 'duplicate_rejected' | 'linked_pending'
  | 'new_pending' | 'update_pending' | 'identity_pending'
  | 'evidence_pending' | 'deferred' | 'conflict';
```

`BenefitFactsV1` 必须包含：schemaVersion='benefit-facts-v1'；issuerProductId；mechanism（signup_credit/daily_credit/free_access/referral/grant/subscription_gift/extra_reset/other）；components[]；audience；requirements；regions；claimChannels；modelScope；occurrence；claimWindow；creditValidity。每项使用 Fact 或同等显式未知联合类型。

component 必须明确 amount（规范十进制字符串）、unit（usd/cny/eur/tokens/credits/requests/images/videos/subscription_duration/other）、poolId 或未知、cadence（one_time/calendar/rolling/unknown）、cadence.interval、cadence.unit、calendar.timezone 或未知、付费/赠送条件。金额计算不得用二进制浮点四舍五入后作为身份依据。积分只在同一发放产品与已确认同积分池内可比，不能把不同平台 credits 兑换成统一积分。

规范化规则：NFKC；金额1,000/1k/一千可在明确语义下归一，千分位小数歧义保留未知；$没有币种依据时不能默认为USD；万/百万依据原文换算；1周和7天只在同样滚动时长语义下归一，calendar month不等于30天。周期必须保留：100/day与100/month不同。地区global、US、CN仅在明确原文或审核映射下填入；unknown不能推断global。模型别名使用人工维护的产品内映射，不删除型号/代际后缀；不同“Flash”“Flash Lite”不得猜成同模型。

资格使用受控谓词及 AND/OR 关系，兼容现役 requirements；[student,biz]不能自动解释为student OR biz。现役字段信息不足时用unknown。设备代际、订阅档位、渠道专享、独立奖池必须保留限定。适用对象 all/new/existing 与 student 等身份资格分开。

`normalizeFacts` 对集合排序去重；顺序有意义的步骤/条件不排序。`factsHash` = SHA256(stable JSON)，只包含规范化值和schemaVersion，不含证据URL、原文措辞、采集时间、展示标题或模型自报置信度。实体内唯一，不跨实体硬合并。

证据引用定义为 observationId + 原文区段（起止字符或明确引用片段）+ 字段路径 + originLanguage。引用必须可定位到由采集器保存的正文，模型不得自己提供sourceText作证。翻译为辅助字段，原文不替换。旧历史证据无正文时标记legacy_unverified，不假造引用，不以它自动推翻管理员。

比较器 `compareFacts(before, after)` 返回 relation候选、changedFields、conflicts、unknownFields、evidenceRefs。只比较双方可知、同口径的槽；缺字段是unknown，不制造“减少额度”提案。文字否定、资格解除、到期方式变化也须有对应证据，不能只用数字或关键词。

## 4. 存储设计：在现有表旁增加身份层

保留 offers 为已批准公开投影或待审草稿，保留 proposals、reviews、revisions及通知表兼容接口。新表使用TEXT UUID、UTC ISO时间、INTEGER revision；JSON用TEXT且CHECK(json_valid(...))。所有状态均CHECK约束，重要FK/索引必须写migration，不能只改Drizzle定义。数据库/应用联合验证跨表不变量。

以下是规范字段及约束，实施者可调整SQL排版，不可删除语义：

### 4.1 benefit_entities

`id PK, issuer_product_id FK platforms, kind(plan|event|provisional), family_key NULL, canonical_offer_id NULL UNIQUE FK offers, approved_version_id NULL FK benefit_versions, merged_into NULL FK benefit_entities, revision INTEGER NOT NULL DEFAULT 1, created_at, updated_at`。

canonical_offer_id不代表approved，公开性仍检查offer.review_state和平台准入。provisional允许记录被拒线索，不要求先造合法offer。approved_version_id必须属于本实体；通过共享事务校验。merged_into由第三阶段管理，禁止self-reference/环；解析异常为409并报警，不直接返回旧记录。

### 4.2 entity_offers

`offer_id PK FK offers, entity_id FK benefit_entities, relation(canonical|legacy), created_at`；entity_id索引；每实体至多一个relation=canonical的partial UNIQUE。offers.id保持不变。canonical_offer_id必须与该映射一致；第三阶段合并不重写历史原始FK，读取时解析root。

### 4.3 source_observations

`id PK, source_id NULL, origin, url, canonical_url, body_hash, body_text NULL, body_status(complete|truncated|unavailable|legacy), final_url, source_verified BOOLEAN, evidence_tier, first_seen_at, last_seen_at, seen_count, provenance_json`。

UNIQUE(canonical_url,body_hash)。hash由采集器/服务端对实际保存内容计算，不能采纳模型的哈希。body_text默认最多60,000字符，超过预算保存必要原文区段并标记truncated；不能把截断视为旧句不存在。先做SSRF/域名验证，再取正文；复用safe-fetch。不要缓存登录页面、token query、账号个人资料；只保留公开活动必要证据。记录url标准化规则版本。

URL规整：删除已确认追踪参数、标准化www/twitter别名、查询参数排序；保留内容ID、兑换码、地区参数。fragment只在确认非SPA内容路由时删除。语言URL是候选召回线索，不无条件合并成一个页面。规范化URL相同也只合并同内容观察，不能合并页面上所有优惠。

### 4.4 observation_candidates

`id PK, observation_id FK, extraction_revision, extraction_key, raw_candidate_json, facts_json, facts_hash, proposed_offer_id NULL, entity_id NULL, version_id NULL, task_id NULL, resolution_json NULL, status(unresolved|resolved|deferred|conflict), next_attempt_at NULL, revision, created_at, updated_at`。

UNIQUE(observation_id,extraction_revision,extraction_key)。extraction_revision由程序版本+抽取合同版本控制，不用每次抓取时间。raw model key只是提示；candidate key由服务端在同次抽取内稳定编号。重新抽取产生新candidate但仍经过实体层，不能重新上架。resolution_json保存明确回执而非仅skipped。

### 4.5 entity_anchors

`id PK, entity_id FK, kind(official_campaign|official_claim|human_alias|observed_alias), namespace, anchor_key, strength(strong|weak), evidence_refs_json, created_by, created_at, revoked_at NULL`。

仅strong且未撤销的(namespace,kind,anchor_key)唯一；weak只建检索索引，不作硬唯一。official_claim包含已确认的具体权益片段/活动范围，不只是URL；official_campaign需发放方真实活动ID及范围。模型生成的id和sameAs不能升级成strong，除非人工确认或已验证实体关系。旧offerId由entity_offers解析，不在文本别名表里碰运气。强锚点冲突返回conflict并保留候选，禁止择一覆盖。

### 4.6 benefit_versions + version_evidence

versions：`id PK, entity_id FK, facts_schema, facts_json, facts_hash, display_candidate_json, created_at`；UNIQUE(entity_id,facts_schema,facts_hash)。内容不可变，编辑生成新版本。

version_evidence：`version_id FK, observation_id FK, claim_refs_json, relation(supports|contradicts|supersedes|legacy), verified_by, created_at`；唯一键包含version_id,observation_id,relation和区段hash，追加而非覆盖。内容相同新来源只追加证据，不生成新版本。display_candidate_json不存内部审核memo或模型思维过程。

### 4.7 review_decisions

`id PK, command_key UNIQUE, entity_id FK, version_id NULL FK, action(approve|reject|link|reopen|supersede), scope, reason_code, predicate_json NULL, missing_facts_json NULL, reopen_policy_json, evidence_refs_json, actor, rule_version NULL, supersedes_id NULL FK review_decisions, legacy_review_id NULL UNIQUE, created_at`。

写后不可修改；撤销用新supersede/reopen事件。scope=version必须有version_id；predicate只能使用受控Fact路径和eq/in/contains-all等安全操作符，不执行自由SQL/正则/模型代码。默认拒绝scope=version。entity范围只由管理员明确选择。rule版本只属于规则型拒绝；更新规则不应使所有人工拒绝自动失效。决议作用对象归属必须在同一事务校验。

### 4.8 review_tasks

`id PK, entity_id NULL FK, candidate_id NULL FK, version_id NULL FK, kind(first_review|terms_update|identity_check|evidence_check), dedupe_key, status(open|checking|done|superseded), payload_json, manual_fields_json, lease_token NULL, lease_until NULL, attempts, next_attempt_at NULL, revision, created_at, updated_at`。

对status IN(open,checking)的dedupe_key建立partial UNIQUE。实体任务键为kind:rootEntityId:factsSchema:factsHash；身份不明任务键仅基于可信同观察同权益/已确认同簇关系，不能用平台+金额把独立候选归一。没有可靠同簇证据时允许多个待核对项，不能为达去重率硬吞；首次人工关联后保存别名/锚点，后续变体不重复问。

lease=10分钟，jobId/token加revision做CAS；超时允许重领，旧任务结果不得提交。技术错误最多5次自动尝试，退避1/2/4/8/24小时；达到上限只保留一个人工故障任务，不拒绝。管理员关闭或重开递增revision并撤销lease。

### 4.9 identity_operations

`command_key PK, kind, payload_hash, status(committed), result_json, created_at`，作为幂等命令回执，必须与业务写入在同一事务提交。命令失败不留下committed。重放相同key相同hash返回旧回执；同key不同hash返回409。不能仅靠内存Set或GitHub Actions concurrency。

检索可增加FTS5虚拟表/索引，不是权威状态。索引revision必须可验证；创建、编辑和决议变更需同步索引或写持久dirty标记。读失败/版本过期不能当空结果。

## 5. 统一解析服务及所有入口

新增共享服务 `src/worker/identity-service.ts`；路由只做鉴权、输入校验、调用。纯规范化/比较在shared，LLM调用继续由pipeline执行，不能把长模型调用塞进D1事务。

```ts
interface ResolveCommand {
  commandKey: string;
  inputId: string;
  candidateId: string;
  expectedCandidateRevision: number;
  resolverVersion: string;
  suggestion?: { entityId: string; relation: Relation; evidenceRefs: string[] };
}
interface ResolveReceipt {
  inputId: string;
  candidateId: string;
  canonicalOfferId: string | null;
  entityId: string | null;
  versionId: string | null;
  decisionId: string | null;
  taskId: string | null;
  outcome: ResolutionOutcome;
  retryable: boolean;
  nextAttemptAt: string | null;
  reasonCode: string;
}
```

必须接入：`pipeline/run.ts`官方页面/RSS/初抽/已有活动复核；`pipeline/lead-review.ts`；`pipeline/official-review.ts`；`src/worker/index.ts /offers`；`src/worker/lead-review.ts`；`src/worker/official-review.ts`；`src/worker/admin.ts`的manual/edit/approve/reject/resolve/unpublish。任何一条绕开服务创建approved或重复pending都算未完成。

普通known index不再截断到只有40字，需返回结构化facts、state、active decisions、scope、evidence refs、revision。全部历史可以分页检索，不把整个数据库发送给每次模型。已有`sameAs`需限定实际发放产品和活动范围，即使ID存在也不能直接信任。

## 6. 候选检索与判断次序

### 6.1 召回

先解析现有offerId和strong anchors；然后在实际发放产品内按机制、模型/池、资格、活动族、关键原文和规范化事实检索，默认topK=30、上限50。状态不得过滤掉rejected/历史，时间窗口不得让常驻活动61天后消失。对事件用窗口帮助排序，不用窗口排除强锚点。

FTS5与中文双字/分词可先满足词面召回；跨语言通过规范化事实与别名字典，无法召回时再用已配置模型生成受控检索词。向量召回为可选插件，不是V1发布依赖。每候选最多一次语义判定、一次有明确补充信息的重试；计入现有预算。不得在多轮审核中重复把同文本付费翻译。

记录 candidateIds/检索规则版本/数据库版本/候选覆盖情况。达到50上限且仍有大量等价候选，返回identity_pending而非凭排名第一硬合并。索引不可用时deferred；对强锚点可走数据库直查。

### 6.2 关系判定

A. 已确认具体活动strong anchor一致，事实无变化，继承已知entity/version/decision。

B. 无strong anchor但有唯一候选，且实际产品、机制、权益组件、领取资格/渠道、已知模型/地区、事件轮次都可明确比较，无任何硬冲突；同时存在官方跨页活动关系或足够具体且一致的完整事实证据，才可自动关联。常驻计划/注册计划须确认非并行专享活动；事件occurrence不明时禁止自动合并。

C. 先检查事实冲突，不让后续标题分支绕过：不同独立产品、设备代际、已知并行资格、独立奖池、不同可重复领取轮次均阻止same_version。若官方明确修订关系则changed_terms，不是distinct。

D. 对疑似同活动但无法证明同版本的情况返回uncertain：保存一个身份/证据任务，不能静默认为unchanged或直接新建公开活动。

E. 通过关系判断后，same_version只关联来源；changed_terms创建未批准version和一个terms_update任务；distinct创建新的待审实体/版本；uncertain不批准、不覆盖旧字段。

模型输出relation、matchedEntityId、字段对应与引用，不要求或保存思维链。不采纳模型自报0.99分数作为阈值。所有IDs、引用、字段和关系在服务端再校验。模型超时/格式失败走deferred。规则和候选范围相同、事实/证据相同且entity revision未变时缓存判定；模型/规则版本变化只重新解析，不自动重新审核已决定的版本。

### 6.3 跨页面政策变更

新官方页面可能改政策，也可能介绍别的活动。需要显式supersedes/extends关系、明确活动锚点或人工确认；域名相同不足。没有旧页面文本但新的可信公告明确修订时创建evidence/identity核对，不把它判no_change。固定推文不可自行改变其历史内容，但后续官方新帖可形成新版本的证据。tested条目自动流程不得降级/覆盖，转管理员核对。

## 7. 拒绝范围与重开策略

| reason | 默认范围 | 同描述重现 | 可重开依据 |
|---|---|---|---|
| duplicate | 指向主实体的link | 关联主对象，终态 | 证明为独立活动，人工纠正关系 |
| paid_bundle/not_ai | version；可人工选受控predicate | 条件仍成立则suppressed | 有独立赠送机制等明确新事实，或人工改规则 |
| ordinary_discount | version/predicate | 换表述不重开 | 额外赠送或符合现役例外的资格事实 |
| insufficient_evidence/vague | evidence_gap | 同缺口不重开 | 新官方证据补齐指定缺口 |
| wrong_platform/wrong_type/wrong_field | version待纠正 | 不等于永久拒绝实体 | 对应字段被有依据地修正 |
| expired | 版本/历史处理 | 同轮次保留历史 | 确认新轮次或官方延长；不用抓取日期 |
| other | version | 继承本版本决定 | 管理员明确重开，不从自由文字猜通用禁令 |

scope=predicate例：mechanism=ordinary_discount AND independent_bonus=false，仅限已确认产品及活动范围，unknown不得满足。不能编译“我不喜欢某品牌”成平台全封。

执行重开时先验证reopen条件，再写reopen决议+唯一任务；旧reject保持审计。不自动批准。未经批准的同一新证据反复抓取只更新已有任务。旧拒绝条款仍在新页面出现但同时新增真实权益，不得对整页一票否决，应按candidate/component分别判断。

没有offer的拒绝线索：建立provisional entity、facts版本（可unknown）和decision；不能仅存url。若事实太少无法语义归一，只抑制确切观察/已确认同簇重复，后续补信息走evidence_gap。

## 8. 幂等、批处理与并发

请求幂等和业务去重是两层。重复HTTP用commandKey阻止同命令重放；不同HTTP/different IDs靠entity/version/task约束。每批最多20个candidate，响应恰好一项对应一个inputId，永不凭数组长度猜成功。

事务模式：检索/模型在事务外；提交时重新读candidate/entity/task revision及主实体路径。用D1 batch保存身份关联、版本、证据、decision/task、operations receipt及投影。每条后续SQL均依赖本次成功占位的command key；不能读取上次命令行充当本次成功。guard=0必须返回conflict/deferred且所有后续写入为no-op。

多实体/版本约束失败或最后验证失败必须触发SQL异常回滚；不可batch已经部分提交后只在JS里return409。可在事务末使用临时校验记录+CHECK断言expected row counts/版本归属，或等效的单语句条件与外键设计；需要真实D1本地运行时测试证明。禁止只添加BEGIN/COMMIT到任意远程D1请求假装跨请求事务。

strong anchors、entity版本、open task、操作key各有唯一约束；竞争失败者重读赢家并返回其canonical ID。无可靠身份不能靠唯一约束解决语义问题，保留identity_pending；人工批准也必须执行最终身份冲突查询/guard。两个同时批准相同活动的请求至多一个成功，另一409并显示已有主记录。

多候选线索：每candidate独立持久化结果；duplicate_approved、duplicate_rejected、linked_pending为已解决，retryable仅针对失败candidate。整条lead只有所有candidate都有终态或唯一持久任务后才关闭初抽；允许其关联多个entity。将`leads.offer_id`保留为兼容首关联，完整关联从candidate关系读取。网络在事务提交后断开，重试返回原receipt，不新增任务。

## 9. 管理界面与接口

沿用Bearer admin/reviewer权限边界。以下新增接口均内部no-store，不公开原文和拒绝历史。

- `POST /api/ingest/observations`：写观察及candidate，要求ingest凭据、请求key、bodyHash；返回IDs与当前resolution。
- `POST /api/ingest/identity/resolve`：最多20个ResolveCommand；返回逐项ResolveReceipt。
- `GET /api/ingest/identity/candidates?candidateId=&limit=`：受限结构化召回，不暴露其他不相关平台数据。
- `GET /api/admin/identity/tasks?cursor=&limit=`：默认30，上限100，keyset分页；展示新来源、候选主记录、已知冲突/未知、历史决定及证据，不只给“相似85%”。
- `POST /api/admin/identity/tasks/:id/resolve`：action=link/new_entity/changed_terms/request_evidence；必须commandKey、expectedTaskRevision、expectedEntityRevision（存在时）、reason；link必须entityId；changed_terms须可核验差异。身份link不等于approve。
- `POST /api/admin/identity/entities/:id/reopen`：管理员限定；decisionId、补充依据或规则改变原因必填；reviewer不得解除entity-wide封禁。
- 既有approve/reject/edit增加兼容版本合同：读取当前task/version，保留expectedReviewVersion；不能将缺version的旧客户端自动视为确认最新内容。兼容过渡期回明确409及刷新说明。
- `/manual`改为补充观察，不默认将已处理URL状态改new；界面另设“基于新证据重开”，需要理由。普通补录同URL同内容返回已有状态。来源内容真变时建新观察，不无条件继承URL的永久拒绝。

编辑界面分列“已批准版本”和“候选事实差异”。只补来源/翻译不产生新审批。身份核对只显示一次；人工确认关联后保存持久锚点。所有新接口做鉴权、JSON大小、字段白名单、ID归属、CAS、CSRF/同源既有约束测试；不用字符串拼SQL。

## 10. 公开投影、通知和兼容

所有公共查询（offers列表/详情、platforms详情、RSS、日历/洞察数据）经`resolveEntityRoot`过滤，只输出准入平台+approved主投影。entityId、candidate原文、reject理由、internal memo不自动进入公开payload。旧offerId通过映射返回canonicalOfferId/requestedId，并按canonical公开性检查；被拒的旧记录不得被别名接口泄露全文。详情页hash路由要读canonical响应而非把HTTP redirect套在fragment上。

单纯duplicate不改discoveredAt或活动发布时间，不增加本周新增、价值总额、批准准确率、新上架推送。来源数可用于内部统计。tasks通知键按taskId/decision version，不按每次更新时间或抓取次数。

现有notifications/deliveries继续用，但新增“解析后的实体+逻辑事件+channel”去重查询：首次上架按entity，变更按已批准version/decision，临期按本轮claimWindow；正常每日常驻榜的重复展示不属于一次性new通知。历史pending/unknown delivery视为已占用，不能静默重发或标sent。要调整数据库唯一约束须提供迁移和对旧记录投影，不仅改内存键。

## 11. 迁移、开关和发布顺序

新增配置 `IDENTITY_MODE=off|shadow|enforce`，默认off；另有 `IDENTITY_WRITE_PAUSED=1` 只暂停相关身份写入，不影响公开读。off不访问新表；shadow在保存当前结果旁计算并记录新判断，但不新增公开/审核/通知副作用；enforce使用新服务。网络抓取与LLM预算仍走现有约束。

M2-1：编号从实施时最新migration之后开始；不要固定使用0017覆盖他人迁移。同步Drizzle schema、迁移日志/生成器基线的项目现有约定、测试fixture、docs合同。第一阶段0016必须已存在或等价迁移已核对。

M2-2：本地和隔离D1先新库全迁移，再旧库升级测试。增量建表、索引，不删旧列。现有offers每条一对一建立entity/entity_offers/version；保留approved/ pending/rejected原状态，不尝试语义合并。现有reviews及rejected_offer_updates只迁为可追溯legacy决议，缺scope/证据时默认最窄，不凭猜测升为实体封禁。无offer leads建立provisional仅在需要解析/已拒需记忆时进行。

M2-3：完整初始化并核对计数后shadow；不能在一半旧历史没有索引时enforce。支持暂停、分页断点和幂等种子键，详见第三阶段backfill原则。

M2-4：灰度enforce只选择明确平台allowlist；保留其余legacy写入适配层，所有客户端回执格式兼容。禁止跨两种模式使用同一实体而丢失决定；模式变更记录配置版本。

M2-5：生产迁移和部署单独授权。先备份/恢复演练、迁移、shadow核验，再切enforce。回滚优先写入暂停→shadow/off；保留新增表和拒绝证据，不逆删生产历史。第三阶段已做合并后不得回退到不认识canonical身份的旧Worker。

## 12. 测试与验收

第一阶段343个Vitest+8个CLI只是起点，不是新阶段固定总数。所有原测试保持通过；增加纯函数、Worker SQLite、真实本地D1和pipeline端到端测试，不用仅比较代码字符串。

必测矩阵：

| ID | 输入 | 预期 |
|---|---|---|
| P2-01 | 已批准10美元注册礼，中英/改写/不同官方与社区URL/不同模型ID | 一个entity、一个版本；无新审核、新上架通知 |
| P2-02 | 已拒普通折扣，换语言/来源 | 命中具体decision，duplicate_rejected；不进入reviewing循环 |
| P2-03 | 从未产生offer的被拒lead换来源 | 可证实同事项时命中provisional决定；不造offer |
| P2-04 | 因证据不足拒绝，新增明确官方依据 | 一项evidence/first_review任务；不自动批准 |
| P2-05 | 同标题同金额但student vs biz，两个独立入口 | 不合并；冲突字段可见 |
| P2-06 | 同金额不同产品、池、设备代际或模型范围 | 不合并 |
| P2-07 | 每天100改每月100；100 tokens改100 credits | 新条款提案；旧公开值保持 |
| P2-08 | 仅标题翻译、$10/10 USD、集合换序 | 不新建版本/提案 |
| P2-09 | 同日独立两次重置 vs 同次跨日预告确认 | 前者两entity，后者一entity；不明则身份任务 |
| P2-10 | unknown资格/遗漏额度/正文截断/仅新价格页 | 不证明相同、也不证明政策删除 |
| P2-11 | 同URL中两项独立优惠 | 两candidate正确关联，不整页封杀 |
| P2-12 | 官方sameAs指错ID、跨产品、模型提示注入 | 服务端拒绝关联，保留核对任务 |
| P2-13 | 同命令重放100次、同key不同body | 一次写入；body冲突409 |
| P2-14 | 20个并发different-ID请求，已证实同活动 | 一entity/version/open task；无unique异常泄露500 |
| P2-15 | 索引超时/过期、模型配额耗尽 | 保存观察、deferred；没有假新活动 |
| P2-16 | 已拒版本A→新版本B，后续又抓到A | A继续抑制；B不受旧决定误杀 |
| P2-17 | 同批准版本复测/备注刷新与reject竞争 | CAS冲突完整回滚；拒绝记忆不丢 |
| P2-18 | 多候选一条duplicate、一条失败，下一轮重试 | 只重试失败者；关联列表不丢 |
| P2-19 | 事务成功但响应丢失 | 相同命令返回同receipt，无重复审计 |
| P2-20 | 旧offer链接、RSS、日历、按模型、管理员详情 | 公开兼容、内部决议信息不泄露 |
| P2-21 | 抓取参数/URL规范化、SPA fragment、地区参数 | 不误合并内容，不泄露token |
| P2-22 | manual补录旧URL vs明确reopen | 前者不重开，后者一次重开且有理由 |
| P2-23 | A≈B、B≈C、A与C资格冲突 | 不能用传递相似度将三者自动合并 |
| P2-24 | 针对版本的reject和当前approved共存 | 只作用该版本，不封禁整个已批准实体 |

固定离线标注集最低120个例：40同活动同版本变体、40不可合并反例、20真实条款变化、20拒绝/补证/并发流程例。按真实活动家族拆开发与holdout，不能把同一原文改写同时放入调参与验收。标签由管理员确认或明确合成控制样例；线上私密数据脱敏。

发布门槛：所有must-not-merge控制例零误合并；holdout duplicate自动关联precision>=99%且逐例报告，不能把未识别当正确；候选召回率>=95%；语义变体未自动终结但归入已有身份任务计任务去重成功，单独报告auto-resolve与manual-group；人工确认重复审核任务数在回放中为0。样本量小不足以证明线上99%准确，必须给分母和置信区间，不宣传保证。

性能验收数据集至少10,000实体/100,000观察，topK<=50；记录每候选D1 rows_read/rows_written、模型tokens、p50/p95耗时和任务排队长度。强锚点及decision重放不调用模型，索引查询不得全表扫描；用EXPLAIN QUERY PLAN和D1元数据证明。不得仅以pending数量下降宣称成功。

## 13. 实施任务边界与文件职责

建议拆4个PR，各自红测→最小实现→全套测试→自审→提交，不一次重构所有路由：

P2-A：identity-contract、facts-normalize、facts-compare、迁移/schema、初始一对一回填、shadow读写基础；验证所有不变量，公开行为不变。

P2-B：candidate-retrieval、identity-service、decision-policy、幂等事务、预算/重试；legacy入口先shadow适配，测试P2-01至19。

P2-C：全部写入入口enforce适配、管理员身份任务/明确reopen、公开投影和通知幂等；更新web对应文件和CLI技能，保留现役权限。

P2-D：真实本地D1集成、holdout回放、迁移/回滚演练、运维文档、灰度开关；不自动生产发布。

每PR交付包含：设计要求→测试ID映射、实际命令/版本/结果、迁移前后计数、未覆盖风险、配置差异。实施者若更改数据模型/门槛，先写ADR说明原因及迁移影响，再继续；不得悄悄将本SPEC降格为加几个正则。

## 14. 技术依据与实施时复核

D1 batch按序执行并具事务回滚语义；但零行条件不是异常，因此仍需guard传播与结果核验。D1绑定参数和语句大小按实施时官方limits核对，分页/小批量设计不依赖无限制查询。FTS5仅作召回。

- Cloudflare D1 batch: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 SQL/FTS5: https://developers.cloudflare.com/d1/sql-api/sql-statements/

这些链接是实现依据，不证明本SPEC已经实施、迁移或部署。
