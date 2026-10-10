# SPEC-02：持久活动身份、条款版本与拒绝记忆

版本：1.0 · 2026-10-10 · 状态：待 Codex 实施的设计规范，不代表功能已上线。

配套：[第三阶段历史回填与合并](2026-10-10-dedupe-phase3.md)。第一阶段：[PR #2](https://github.com/accesaver-byte/ai-yangmao/pull/2)、[修复与验证记录](../phase1-dedupe-fix-2026-10-10.md)。基线为 `7cea69d95d2c27e2c1ebd7641a94bab2a696901d` 加第一阶段修复；执行前必须获取当前 main/PR 状态，不能覆盖后续提交。

本文的 MUST / 必须是验收要求；标为后续可选的内容不得成为首版依赖。本文授权边界是开发、测试、PR；生产迁移、部署、历史数据应用与发送消息仍须管理员单独授权。

## 1. 目标与不做事项

目标：同一个羊毛可以被多次发现，但同一事实版本不反复创建活动、人工审核任务或首次上架提醒。必须同时避免误合并独立权益，并保留真实政策变化的审核入口。

成功不是待审数量下降，而是：已批准/已拒绝/待审/历史记录都能成为身份候选；重复有明确关联去向；实质变化有可解释差异；技术失败不会伪装成无历史或无福利；人工决定可追溯。

首版不重写网站、不换数据库、不改变收录口径、不新增自动批准权限、不要求向量数据库或付费搜索服务、不把所有历史记录发给模型、不批量删除旧活动。沿用 Worker、D1、Hono、Drizzle、现有预算控制及模型提供方。

## 2. 必须保留的现有行为

先阅读 AGENTS.md、docs/data-contract.md、pipeline/learned-rules.md、pipeline/platform-notes.md、docs/operations.md，以及当前仓库审核技能。业务收录标准以现役规则为准；本文只改变身份和流转，不扩大收录范围。

- 原始证据保留原语言；模型不得提供或提升可信级别，不得写 tested。
- 平台准入不等于活动批准；人工审核前保留公开的已批准版本。
- 公开 title/valueText/steps/creditValidity 不写核验过程和去重理由，内部记录不进入公开接口。
- 保留最新 Mistral 原文身份锚点与 lead-scope 保护，避免把第三方卖家线索替换为搜索命中的无关学生福利。
- 已审核估值不是模型自由更新的字段；不能在去重时取最大美元值、求和或重新估价。
- 重置事件与常驻月度额度不能互换；同日可能有独立两次发放。
- 第一阶段修复必须保持：duplicateId 是已解决结果、同数字发放周期变化可以形成提案、拒绝提案的记忆/审计/删除原子提交。

## 3. 术语与数据身份

| 名称 | 含义 | 不等于什么 |
|---|---|---|
| observation 来源观察 | 一个来源在一次内容版本中说了什么 | 活动或审核任务 |
| candidate 候选 | 一次抽取中一个独立权益主张 | 模型给出的英文 key |
| entity 活动实体 | 现实中一个优惠计划或独立发放事项的持久身份 | 标题、页面、金额拼接哈希 |
| terms version 条款版本 | 同一实体的一组已知权益事实 | 翻译文案或整页内容哈希 |
| occurrence 独立轮次 | 有证据支持的再次独立发放 | 新帖子日期、采集日期 |
| decision 审核决定 | 对特定身份/版本/规则范围的人工或系统处理依据 | 永久域名黑名单 |
| task 审核任务 | 需要人的一个具体判断 | 每个新来源或每次模型运行 |

新 entity ID 使用服务端 `ben_` 加 UUID，不从模型 key、URL 或 title 生成。新公开 offer ID 可用合法格式 `offer-` 加 UUID；旧公开 ID 不改。数据库、API、路由对内部 entity ID 与公开 offer ID 分别校验。

同一个长期注册礼从10美元变为20美元，一般是同实体新版本。注册礼与邀请礼即使同为10美元，也是不同机制。每日自动刷新不每天创建轮次；额外发一张重置卡可能是独立 occurrence。每轮实体可用 seriesKey 关联同系列，但 seriesKey 不能代替独立身份。

地区、资格、设备代际、产品、模型、独立积分池、领取渠道是区分权益的重要维度。它们也可能在同一计划中被官方修改，因此不能把全部维度固定拼成永久 ID：已知冲突阻止“同版本自动合并”，有计划连续性证据时可进入“同实体新版本”判断。

## 4. 不变量

I01：同来源观察重放不新建候选；不同来源同权益不新建公开活动。

I02：同一 entity/条款版本/任务类型最多一个有效审核任务。同版本重复被拒不再重开。

I03：身份判断、条款判断、发布批准是不同步骤；模型 sameAs、分数或自述不能直接改变公开批准状态。

I04：未知不等于相同；未知不等于冲突；来源缺失不等于官方取消。

I05：同 URL 可以对应多个候选；同整页 hash 不证明是同一福利。

I06：身份库不可读或召回不完整时，不能按空历史创建新活动。先保存观察，返回 deferred/needs_identity_review。

I07：批准/拒绝/合并的状态、决定、任务收束、命令回执必须一致提交。过期任务结果必须拒绝。

I08：添加证据不刷新官方核验时间、不改变业务审核版本、不重发任务提醒。

I09：保留已批准公开投影和人工字段；新事实只能成为待审版本，不静默覆盖。

I10：身份关系必须可撤销、可审计。弱相似关系不能做传递闭包；A似B且B似C不推出A=C。

## 5. 结构化事实合同

新增 `src/shared/benefit-facts.ts` 与运行时 Zod 校验。以下是规范接口；Codex 必须实现并为其建立单元测试，不把 TypeScript 类型当运行时校验。

```ts
type Known<T> =
  | { state: 'known'; value: T; proofIds: string[] }
  | { state: 'unknown' };

type Cadence =
  | { kind: 'one_time' }
  | { kind: 'calendar'; unit: 'day'|'week'|'month'; every: number; timezone: string|null }
  | { kind: 'rolling'; seconds: number }
  | { kind: 'unknown' };

interface BenefitFactsV1 {
  schemaVersion: 1;
  issuerProductId: Known<string>; // 实際发放产品，不只是母公司
  mechanism: Known<'signup'|'recurring_quota'|'trial'|'referral'|'identity_grant'|'extra_grant'|'reset'|'free_access'|'application_grant'|'ordinary_pricing'>;
  programKey: Known<string>; // 经证据确认的计划/活动编号，无则unknown
  occurrenceKey: Known<string>; // 仅有独立发放证据时填写
  poolKey: Known<string>; // 通用池、专属池不得混合
  quotas: Known<Array<{ amount: string; unit: string; currency: string|null; cadence: Cadence }>>;
  eligibleAudience: Known<string[]>;
  requirements: Known<string[]>;
  regions: Known<string[]>;
  channels: Known<string[]>;
  models: Known<string[]>;
  devices: Known<string[]>;
  claimWindow: Known<{ start: string|null; end: string|null; endKind: 'date'|'unknown'|'standing'; timezone: string|null }>;
  creditValidity: Known<string>;
}
interface FactProof {
  id: string;
  observationId: string;
  fieldPath: string;
  quote: string;
  quoteStart: number|null;
  trust: 'official'|'staff'|'media'|'admin_tested';
}
```

金额为规范十进制字符串，不用浮点计算后的展示值做身份键。NFKC、千位分隔符、大小写、已明确单位的 k/m/万可以归一；保留币种和池的所有权。美元/USD/$只有来源已确认美元时统一，不能把所有 `$` 推断为USD。积分不能跨平台按同一 unit 直接比较。20000 tokens与2万tokens可一致，但100/day和100/month必须不同。

字段集合去重并稳定排序。产品/模型别名只使用受审核的映射；不删掉模型版本、fast mode、地区、设备代际等限定词。none和unknown不同。输入缺字段保留unknown；不得用上一活动日期填充新轮次。

`factHash = SHA256(stableJSON({schemaVersion, semanticValuesAndKnownMask}))`。不包含标题、文案语言、URL、原文措辞、proofIds、抓取时间、模型版本和估值换算。hash只用于一个entity内的版本去重，不是通用entity身份证明。未知转已知可能是补证，而非新政策，必须由比较器解释，不能仅因hash不同重审。

接口：
```ts
normalizeBenefitFacts(input: unknown): BenefitFactsV1;
compareBenefitFacts(a: BenefitFactsV1, b: BenefitFactsV1): {
  relation: 'same'|'changed'|'insufficient';
  changes: Array<{fieldPath:string; before:unknown; after:unknown}>;
  conflicts: string[];
  missingIdentityFields: string[];
};
```

已知字段全部一致仍不必然证明同一entity；两家活动可有相同事实。身份需要第7节的锚点。仅原文受支持的事实可用于“确认相同”或“确认变化”。模型未给proof/错引原文的字段降为unknown并记录校验错误，不能提升为确定值。

## 6. 持久化模型与迁移

采取增量模型。旧 offers 继续作为公开已审核投影，旧 reviews/revisions 继续是审计来源，不在一次PR中替换全部表。下表为必须提供的逻辑字段和约束；实际SQL字段使用snake_case、显式FK/CHECK与JSON校验，Drizzle和迁移同步。迁移编号取执行时尚未使用的下一个编号，不能覆盖0016或其他人的迁移。

| 表 | 必须字段/索引 | 约束与职责 |
|---|---|---|
| benefit_entities | id PK, issuer_product_id nullable, state(provisional/confirmed/merged), canonical_offer_id nullable UNIQUE FK offers, merged_into nullable FK本表, identity_revision整数, current_version_id nullable, publication_seq整数, first_seen_at,last_seen_at | id永久稳定；provisional不公开；current_version必须属于该实体或明确合并成员；禁止自环/环；只有人工批准改变current_version和publication_seq |
| offer_identity_links | offer_id PK FK offers, entity_id FK, created_at | 原有offer的归属；历史合并先保持原归属，通过实体root解析；不抹去历史来源 |
| source_observations | id PK, source_key, original_url, final_url, normalized_url, content_hash, source_id nullable, origin, provenance JSON, excerpts JSON, first_seen_at,last_seen_at | UNIQUE(source_key,content_hash)；复抓只更新last_seen；保存原URL；正文只在受限私有存储，来源快照不能成为公开字段 |
| observation_candidates | id PK, observation_id FK, extraction_id, ordinal, lead_id nullable, input_id, input_hash, extracted_facts JSON, proofs JSON, entity_id nullable, version_id nullable, decision_id nullable, task_id nullable, state, retry_at | UNIQUE(extraction_id,ordinal)；一次提取先持久化完整输出/候选数量，再逐个处理；同次失败重试不重新生成ordinal；内容改变产生新提取，通过身份层关联 |
| benefit_versions | id PK, entity_id FK, fact_schema_version, fact_hash, facts JSON, created_at | UNIQUE(entity_id,fact_schema_version,fact_hash)；事实快照不可变，证据通过候选/proofs关联追加；已批准版本原文不因新来源改写 |
| identity_aliases | id PK, namespace, kind, alias_key, entity_id FK, strength, state, supporting_decision_id nullable, provenance JSON | 已确认的强键 UNIQUE(namespace,kind,alias_key)；弱键仅是检索提示，用独立索引非唯一；弱键不可写进强键表；旧offerID为强别名；普通URL和模型生成key不是强键 |
| identity_relations | low_entity_id,high_entity_id,relation,decision_id,at | 排序后的pair唯一有效关系；支持keep_separate，自动匹配不得忽略它；历史冲突保留决策记录 |
| review_decisions | id PK, command_key UNIQUE, entity_id nullable, candidate_id nullable, version_id nullable, action, reason_code, scope JSON, reopen_when JSON, policy_version, actor, at, supersedes_id nullable, proof_refs JSON | 至少一个entity/candidate主体；append-only；撤销用新决定，不覆盖旧决定；系统判断不能伪装人工；通用拒绝范围必须经管理员明确确认 |
| identity_tasks | id PK, task_key UNIQUE, entity_id nullable, candidate_ids JSON, kind, state, actionable_revision整数, payload JSON, payload_hash, job_id nullable, lease_until nullable, attempts,retry_at | kinds identity/new_offer/update/evidence_recheck；同语义问题复用task_key；证据追加不增加actionable_revision；worker结果须匹配job_id和输入版本 |
| identity_commands | command_key PK, payload_hash, status, result JSON, committed_at | 同命令同payload返回相同回执；同命令不同payload409；提交标记和副作用同事务；HTTP超时可查询，不盲重建 |
| identity_locks | bucket_key PK, token, fence整数, lease_until | 仅最终身份落库短临界区；过期token不能提交；不能把模型调用放进锁里 |

`source_key`采用平台帖子的真实稳定post ID或经过保守URL规范化的来源身份，不依赖模型。可变同URL内容必须保存不同hash观察，避免价格页变化被URL唯一约束吃掉。

provenance至少记录采集器、获取方式、原URL/最终URL、信源归属检查结果、正文hash、抓取时间。正文存储首版可复用snapshots或受限JSON摘录；不要求新对象存储服务。必须保存足以重放身份判断的原句与内容hash；正文截断要标记，不得以截断部分缺失证明旧条款消失。

长期拒绝记忆、人工别名和keep_separate关系不得随快照清理删除。重复原始大正文可以按运营保留策略清理，但必须保留关联、证明片段与审计依据。

## 7. 统一身份解析算法

所有自动入口使用一个服务端决策器。职责拆分：Worker负责取候选、校验身份/来源、版本和写入；pipeline负责可选模型语义比较。不得让Worker import带node:fs、进程环境或Node依赖的pipeline/llm.ts。

### 7.1 解析阶段

1. **持久化输入**：保存observation、完整extraction及candidate，返回稳定candidateId。原始失败/invalid记录可追踪，不静默丢弃。
2. **强别名查找**：解析旧offer ID、人工确认别名、带产品和权益范围的官方活动编号。传入sameAs只作提示，不能绕过来源范围和事实冲突。
3. **召回历史**：包含pending、approved、rejected和已结束/merged成员；包含未生成offer的已拒候选。按产品、机制、program/pool、关键资格、范围和有效时间建立索引；年份不得作为常驻活动的硬截止。
4. **多路取并集**：强别名、结构化槽位、规范化词面/中文分词或bigram召回。可用D1 FTS5；不能只靠英语词面解决跨语言。单位和资格受控词表提供跨语言连接；品牌未知时保留待识别。
5. **比较**：先判断来源范围、keep_separate和已知冲突；再判断实体连续性和条款版本。不使用“前一个专门规则失败、后一个宽松标题规则又自动通过”的OR链。
6. **语义补充**：仍模糊时创建有lease的身份任务，用现有预算中的模型比较候选与少量历史。结构化输出包括same_entity/same_version/different_entity/uncertain、候选ID、字段差异、证据引用和理由。模型分数不作为数据库写权限。
7. **最终重读与提交**：结果校验通过后，持有短锁重读当前实体/版本/决定/任务，再原子关联或创建。输出第9节明确outcome。

召回首版上限每候选50个记录，其中最多20个交模型；优先所有强锚点和人工关系。超出限制且有遗漏风险时标记truncated=true，继续分页或needs_identity_review，禁止把“top20没找到”当作确定新活动。模型总输入首版上限32000字符，不含无关正文；每候选最多1次正常语义调用，服务故障遵循现有退避与预算规则。缓存键包含candidate事实hash、候选entity及identity_revision/版本/决定revision、比较器及提示词版本；任一变化使旧缓存失效。

### 7.2 自动关系判定

| 情况 | 允许结果 |
|---|---|
| 已确认别名/同官方活动编号且没有来源、轮次或资格冲突，条款一致 | same entity + same version |
| 多语言、不同页面，但独立权益锚点与结构化事实一致且有官方互链/人工关联等连续性依据 | same entity + same version |
| 只有同标题/同金额/向量接近/同母公司 | 只召回，不自动合并 |
| 一个是学生礼另一个企业礼，分别有官方资格证据 | different entity或needs identity review，不能same version |
| 新旧资格不一致但同计划官方公告明确替换条件 | same entity + changed version，仍待审 |
| 同一天同金额两个重置公告，没有独立发放或同次活动证明 | needs identity review，不能凭日期合并或拆轮 |
| 已确认同一活动的预告/确认/进度回复 | 同entity/occurrence，不因发布时间不同拆条 |
| 已结束活动后来真的新一轮发放，有新的领取窗口或活动编号证据 | 新occurrence实体，保留seriesKey关系 |
| 抽取缺资格、地区或模型范围 | unknown/insufficient，不自动抹掉已知限定 |

模型与确定性证据冲突时保留不确定任务；不自动采信“置信度99%”。第一次完全缺少实体线索的跨语言输入不能保证立即识别，首版要求它们不先发布、可归并成一个核对任务，归并后持久记忆，不能宣传100%语义识别。

### 7.3 无法确定时的任务聚合

同一强来源锚点或已确认候选关联的输入复用identity任务。仅弱文本近似时不得为了减少任务数量把互不相关权益强行归一；可在UI显示候选组，但保持独立候选状态。管理员确认“同一活动”后持久保存别名/决定并收束相关任务。确认“独立活动”写keep_separate，避免下轮再次询问同一配对。

## 8. 条款变化与拒绝范围

### 8.1 三态条款比较

`same`：事实一致或只有展示漂移，关联来源；不创建提案。

`changed`：同实体、新事实有可信官方依据，产生版本和一个更新任务；公开投影仍是旧批准版本。比较金额、单位、周期、资格、模型范围、领取期限、额度有效期和领取方式，不再把creditValidity等永远冻结。

`insufficient`：旧文缺失、页面改版、跨页面没证实连续性或新事实不受支持。记录补证任务/健康故障，不自动标记same，也不无证据发布变化。

跨页面新公告可以支持真实变化，但须先证明与旧计划的关系和新条款适用范围；不能简单删去sameEvidencePage保护。固定X公告本身与新的更正公告分别保留，后者可作为同实体更新依据。人工实测基线必须走明确人工复核，不由普通抓取覆盖。

模型重写展示字段不构成新版本；UNKNOWN变已知但已批准事实未变，作为证据补全。新证据会影响可领取资格或纠正已批准值时仍须单独任务。已存在manualFields的提案不得被模型更新覆盖，新的冲突附到该任务供人决定。

### 8.2 拒绝决定必须记录原因与作用范围

scope采用受控结构，不执行模型生成代码或正则表达式：

```ts
interface DecisionScope {
  kind: 'candidate'|'entity_version'|'entity_policy';
  entityId?: string;
  versionId?: string;
  candidateId?: string;
  predicates?: Array<{fieldPath:string; op:'eq'|'contains_all'; value:unknown}>;
}
type ReopenCondition =
  | 'manual_only'
  | 'new_official_evidence'
  | 'material_terms_change'
  | 'new_occurrence'
  | 'policy_revision';
```

entity_policy仅管理员能创建；predicates字段白名单、schema校验，并绑定policyVersion。不能把“这个域名”“这个平台”“包含免费”等过宽条件自动变成拒绝规则。候选未知字段不能被当作满足拒绝谓词。

| reasonCode | 默认作用范围 | 重新判断条件 |
|---|---|---|
| duplicate | 已确认实体关联，不是内容本身被禁止 | 跟随主实体，不能把主实体批准改成拒绝 |
| paid_bundle / ordinary_pricing | 已确认版本；管理员可确认精确机制范围 | 真正额外赠送或独立新活动不被该规则吞掉 |
| insufficient_evidence / vague | 当时主张与证据缺口 | 新官方证据实际补足缺口才重开，不是换标题 |
| expired | 该独立轮次 | 新一轮有证据可建新实体；旧历史不重复上架 |
| wrong_platform / wrong_field | 被拒的错误主张版本 | 官方依据证实的纠正进入纠正任务，不永久禁止真实福利 |
| other / 缺理由历史记录 | 原candidate或明确同版本 | 不推断宽泛永久规则，必要时一次性人工定界 |

被拒线索没有offer时也要保存candidate/decision。新的同义线索匹配后引用该decision结束；不得为了记住拒绝而生成一个公开不合规offer。

权限和作用域都满足后，系统可以创建reopen任务，但绝不自动批准。每次重开保存触发条件和新增证据delta；同一delta重复到来复用任务。`manual_only`不会因为模型声称有新证据自动失效。

## 9. API合同与旧调用方兼容

新增 `src/shared/identity-contract.ts`：以下是v2语义，使用Zod判定联合并验证每个outcome的必需字段。

```ts
type ResolveOutcome =
  | 'duplicate_approved'|'suppressed_rejected'|'linked_pending'
  | 'proposed_update'|'created_pending'|'needs_identity_review'
  | 'deferred'|'conflict';
interface ResolveResult {
  inputIndex: number;
  inputId: string;
  candidateId: string;
  entityId: string|null;
  canonicalOfferId: string|null;
  versionId: string|null;
  decisionId: string|null;
  taskId: string|null;
  outcome: ResolveOutcome;
  retryable: boolean;
  reasonCode: string;
}
```

`duplicate_approved/linked_pending`需要canonicalOfferId；`suppressed_rejected`需要decisionId但不强制存在offer；`created_pending/proposed_update/needs_identity_review`需要稳定taskId；deferred需要明确重试原因，不写“已解决”。返回顺序对应inputIndex，不能只用输出ID反查输入。

新增 `POST /api/ingest/candidates`：`{requestId, observation, extractionId, candidates:[{inputId,...}]}`，一次最多50个候选，每个结果单独返回。相同requestId不同payloadHash返回409；相同payload复用已完成结果，未完成的继续，不重复副作用。数据无效400，鉴权失败401/403，状态竞争409，依赖不可用503或候选deferred。

新增 `GET /api/ingest/identity-jobs`、`POST /identity-jobs/:id/claim`、`POST /identity-jobs/:id/result`。参照现有lead-review租约，但绑定candidate facts hash、entity identity_revision、task actionable_revision和jobId。过期结果409，不能自动刷新后重放同一个批准/合并动作。

旧 `POST /api/ingest/offers`必须成为同服务适配器，不能长期保留另一个写入旁路。滚动升级先让旧接口内部走resolver并返回旧字段加新outcome；v2客户端必须完整读typed result。只有确实存在主offer时才提供旧duplicateId；无offer的suppressed_rejected不能伪造ID，旧客户端应得到可重试兼容结果，直至所有caller升级。

普通官方抓取、RSS、triageLeads、runLeadReviews、runOfficialReviews、人工补录、审核通过均检查同一身份结果。人工批准不是简单调用旧sameBenefit；身份存在阻断冲突则409，除非管理员先完成有审计的link/keep_separate处理。

手动补链接默认是attach source，不把原lead置new、不清resolution。新增独立的reopen操作：必须提供expectedVersion、reason和目标decision，服务端确认权限并记录新的决定。reviewer可以进行现有权限内的审核，实体跨历史合并及宽范围拒绝策略只给admin。

## 10. 原子写入、并发与幂等

D1 batch提供SQL事务，SQL失败回滚；条件零行并不抛错。因此不能只把原来的几条语句塞进batch就宣称一致性。每个命令先以完整前置条件插入/更新本次command标记，所有后续语句依赖该标记；版本、alias归属、lease token和fence不匹配时全部不写并返回409。审计插入失败必须使整个批次回滚。

最终创建/关联采用产品bucket短租约：锁30秒，fence递增；仅在提交阶段持有，不跨模型/搜索请求。获取后重新读取候选范围和当前决定，提交batch同时验证未过期token/fence。超时不确定先查identity_commands，不生成另一个entity。

强身份键唯一约束阻止同一强锚点双写。两个不同模型ID同时输入、并且结构化/锚点足以证明同一活动时，必须在锁后重检得到一个实体和一个task。未知产品不能各自猜不同bucket然后自动新建，先进入身份确认。跨产品确需合并仅走第三阶段，不强行升级自动权限。

主实体的审核决定/条款投影更新须CAS；task结果无法覆盖管理员在处理中做的修改。正文追加和健康核验应使用独立revision，不能让last_seen更新使每张审核卡片无效。发布序列publication_seq只在一次真实批准转移时递增；旧政策恢复也有新的批准事件，不被历史factHash永久吞掉。

无论Actions是否串行，测试必须覆盖两个独立API请求，因为用户补录和其他采集器不受collect并发组约束。

## 11. 通知与UI

审核提醒使用 `task:<taskId>:<actionableRevision>`，首次发布使用 `entity:<rootId>:published:<publicationSeq>:<channel>`。来源语言、URL、抓取jobId变化不生成新事件。管理员面对同一任务能看到已有主记录、各来源、逐字段相同/差异/未知、历史决定及可选动作。

公开列表、统计、RSS及平台页最终只读canonical公开投影。字段采用公开DTO白名单；新增身份候选、拒绝理由、内部原文和proof路径不得因当前withStatus的对象展开而泄露。

现有notifications/deliveries保留为真实发送回执。pending/unknown继续阻止重发，不把unknown自动当failed。飞书常驻榜本来允许每天推荐，这与首次发布去重不同：同榜单内不重复，不能为防重永久取消每日推荐。第二阶段先统一新事件键，历史回执对齐按第三阶段执行。

## 12. 代码落点和分批实施

新文件路径是本SPEC要求实现的目标，不代表现在已存在：

| 文件 | 职责 |
|---|---|
| src/shared/benefit-facts.ts | 事实结构、规范化、稳定hash输入与三态比较，纯函数 |
| src/shared/identity-contract.ts | 输入/结果/decision scope schema和类型 |
| src/worker/identity/service.ts | 单一解析入口、前置验证和状态机 |
| src/worker/identity/repository.ts | 索引召回、CAS、锁和command batch，不做LLM调用 |
| src/worker/identity/routes.ts | ingest/identity-job/admin接口和权限 |
| pipeline/identity-review.ts | 使用现有预算/模型的有租约语义任务 |
| src/worker/identity/publication.ts | 投影批准和任务/通知事件一致更新 |
| tests/identity-*.test.ts | 各纯函数、Worker/D1、pipeline/通知/隐私回归 |
| scripts/identity-eval.ts | 标注样本离线评估，不读生产密钥、不发通知 |

修改src/db/schema.ts和新增迁移；接入pipeline/run.ts、pipeline/lead-review.ts、pipeline/official-review.ts、src/worker/index.ts、admin.ts、lead-review.ts、official-review.ts及实际后台页面。先定位真实web文件，不凭名称新建第二套管理页。

实施拆成四个可独立审查的PR：

P2-A：事实合同、存储、索引、纯比较器、迁移兼容。仅影子记录，不改变公开行为。先加失败测试，再实现。

P2-B：统一resolver、命令幂等、并发/租约、所有自动入口adapter、候选级进度。必须测试强别名与同ID错误复用。

P2-C：拒绝范围/显式重开、语义job、人工identity任务、keep_separate与审核批准前闸门。包含多语言黄金样本。

P2-D：任务提醒键、公开DTO和canonical读取准备、运营指标、shadow对照、发布/回滚说明。第三阶段开始前必须完成。

每个PR都运行typecheck、完整npm test；涉及web时运行build:web。补充本地Wrangler D1迁移/事务集成，不能仅靠SQLite mock。真实网络模型不作为单元测试必要条件；模型输出使用原文支持的合成fixtures，另行授权才进行有费用评估。

## 13. 验收矩阵

至少实现以下固定回归，测试名称直接包含编号；对相同输入进行两次及乱序重放：

| 编号 | 输入/条件 | 必须断言 |
|---|---|---|
| ID01 | 已批准注册10美元，英文/中文/改写/不同URL和ID | 1entity、1offer、0新review、0首次发布事件 |
| ID02 | 同上但rejected且有entity_version决定 | 新candidate引用同decision，不回reviewing |
| ID03 | 被拒lead无offer，换来源同一主张 | 不为记忆创建offer；同decision收束 |
| ID04 | 已有pending，新增5个证据页 | 1task，actionableRevision不因附件增长 |
| ID05 | 同一价格页学生与企业各送1个月 | 两个独立candidate，不被相似标题合并 |
| ID06 | 同额度不同产品/池/模型版本/地区/设备代际 | known conflict不可自动same_version |
| ID07 | none与unknown、缺资格/模态 | 不把未知当相同或无门槛 |
| ID08 | 100/day→100/month、credits→tokens | changed提案，公开旧值和人工提案保护 |
| ID09 | 20000 tokens→2万tokens、空白/顺序/翻译 | 不产生条款变化 |
| ID10 | 新官方页面明确同计划变更 | changed或证据待审；不直接no_change或自动批准 |
| ID11 | 正文缺失/截断/503、索引服务不可用 | deferred，不能空库创建或永久拒绝 |
| ID12 | 同日两次独立重置；同次活动进度回复 | 分别保留独立轮次/合并同轮，不只看日期 |
| ID13 | 常驻每月额度被误标reset | 不产生新轮次 |
| ID14 | insufficient_evidence后补官方证据与只有改写两种输入 | 前者可创建1个reopen任务；后者不重开 |
| ID15 | paid_bundle被拒，后来真的有独立bonus | 不被过宽拒绝规则吞掉 |
| ID16 | 已结束活动新一年独立发放 | 新occurrence，旧历史/拒绝保留 |
| ID17 | 伪sameAs、无关平台、模型编造候选ID/proof | 不关联、不批准，保留原线索 |
| ID18 | 50个并发请求不同inputID同强权益身份 | 1entity/1task，所有回执可读；无孤儿候选 |
| ID19 | 相同requestId不同payload；提交成功响应丢失 | 前者409；后者返回已提交结果无重复副作用 |
| ID20 | batch第一条零行、审计失败、过期lease/fence | 全部状态一致，无孤立决定/任务删除 |
| ID21 | 多候选2成功1失败，重试 | 已成功者不重建，仅未完成者处理 |
| ID22 | 人工编辑期间模型结果返回 | stale409或附加证据，不覆盖人工字段 |
| ID23 | A似B、B似C、A与C有冲突 | 禁止弱关系传递合并 |
| ID24 | keep_separate后同样输入 | 不重复询问同一身份配对 |
| ID25 | 追加来源/重复技术故障/换jobId | 不重复提醒同一个人工任务 |
| ID26 | pending/unknown投递与每日飞书榜 | 前者不重发；每日榜仅按原产品规则去重 |
| ID27 | 所有公开API/详情/RSS | 不泄露decision、raw、proof、内部身份字段 |
| ID28 | 旧client及新client交错写入 | 同一resolver、同一历史，不能利用旧入口绕过 |
| ID29 | 相同条款回到曾批准旧版本 | 经一次真实批准产生新publication_seq，不错误消音 |
| ID30 | 拒绝scope来源仅有模糊other历史记录 | 只精确记忆，不自动变成整个平台永久拒绝 |

验收集：至少100组明确重复正例和150组困难非重复/真实变化负例，覆盖多个平台和语言；拆分开发集和独立保留集，不把保留集案例写进提示词。合成样例不得宣称生产真实案例。

发布硬门槛：上述固定测试全部通过，保留集已知硬冲突误合并为0，重复召回率目标≥95%；同时报告实际分母、误合并/漏合并/不确定率，不以缩小召回范围伪造通过。达不到目标先shadow，不强行上线；这不是对任意未来文本的准确率保证。

## 14. 发布、性能与回滚

`IDENTITY_MODE=off|shadow|enforce`，初始shadow；off保留旧路径，shadow只记录身份候选决策，不改变发布/拒绝/提醒结果。enforce必须所有调用方共用resolver；模式切换不是自动部署授权。

shadow至少覆盖3次常规采集和24小时（取更长），检查重复抑制、真实更新召回、误合并、不确定任务量、每100候选模型费用和D1 rows_read。样本不足必须报告不足，不把空流量视为验收。费用继续受现有日/月预算控制，新模型功能默认不能打开付费兜底。

每次入库禁止全库select和整库prompt；10,000条合成历史、100个候选的基准需记录rows_read/耗时/模型次数，不以本机耗时代替线上承诺。批处理每条SQL不超过当前D1绑定参数上限；在测试harness维持100参数约束，使用分批或json_each而非任意长IN列表。

发布顺序：验证迁移→加表/索引→兼容Worker→shadow→验收→批准enforce。回滚解析逻辑可以回shadow；第三阶段发生实体合并后，canonical读取/通知归属解析不能随IDENTITY_MODE关闭，否则旧重复会重新公开。提供独立、始终识别已合并root的兼容读取层。

开发过程中同步docs/data-contract.md的字段/身份合同及operations.md。本文提到的新增命令/接口都要由实施者完成后才可使用，禁止把SPEC当现有功能调用。

## 15. 技术依据与交付清单

技术依据（实施时再次核对当前文档）：[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1限制](https://developers.cloudflare.com/d1/platform/limits/)、[SQL/FTS5支持](https://developers.cloudflare.com/d1/sql-api/sql-statements/)。SQLite事务测试不能替代对实际Wrangler D1绑定行为的验证。

交付必须包含：schema与迁移、纯函数/服务/API/全部caller接入、失败再通过的回归证据、合成黄金样本及评估报告、shadow结果、功能开关、兼容/回滚说明、未解决问题清单。任何生产数据和令牌不得提交到repo。第三阶段依赖这些接口和不变量，不能提前用字符串相似度脚本清理生产重复。
