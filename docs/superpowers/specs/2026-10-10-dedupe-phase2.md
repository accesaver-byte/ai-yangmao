# SPEC v1.0 — 第二阶段：统一活动身份、条款版本与审核记忆

状态：待实施的产品/工程规格，不表示功能已经上线。日期：2026-10-10。
前置：第一阶段修复 PR #2；基线 main 为 `7cea69d95d2c27e2c1ebd7641a94bab2a696901d`。
配套：`2026-10-10-dedupe-phase3.md`（历史回填与合并）、`2026-10-10-dedupe-handoff.md`（Codex执行顺序）。

## 0. 目标、边界与已完成部分

目标是“允许同一羊毛被反复发现，只审核新的活动或实质变化”，不是禁止再次抓取。新网页、新语言、模型生成的新ID和措辞变化，均不能独自创建新的审核对象或新上架通知。同时必须保留不同产品、领取资格、独立积分池和独立发放轮次。

第一阶段只解决三处确定缺陷：初抽把已识别duplicateId当失败；同数字的真实周期变化被抹掉；拒绝提案的记忆/日志/删除不原子。第一阶段没有解决通用跨语言身份、全入口拒绝范围、不同ID并发、候选级部分失败账本、明确重开和历史合并。本SPEC实现这些后续能力，但不允许在实现代码时顺便操作生产。

继续使用TypeScript、Hono、Drizzle、Cloudflare Worker/D1、现有采集Actions和模型预算。第一版不强制引入向量数据库、消息中间件、另一套后台或新的付费供应商。现有offers继续作为公开的已批准投影，offer_proposals继续作为待批准更新；不重写估值V1、平台准入、领取状态或现有通知传输。

实施前读取AGENTS.md、docs/data-contract.md、docs/operations.md、pipeline/learned-rules.md。源代码与现役合同优先；本规格明确改变的审核/身份行为实施时须同步合同。先核对最新main及PR #2状态，不覆盖后来提交，尤其保留sameEvidenceBenefit、lead-scope、官方作者/帖子身份校验、人工字段和估值保护。

## 1. 必须保持的不变量

- I01：活动身份由服务端持久维护。模型key、sameAs、sameOccurrenceAs只是候选关系，不是写入授权。
- I02：一个实体至多有一个公开主offer。一个网页可以包含多个实体，一个实体可以由多个观察支持。
- I03：approved公开投影在变更获批前保持原样；关联来源不刷新lastVerifiedAt、不改变估值、不批准条目。
- I04：已拒决定不会因为换URL、语言、采集任务或模型而失效。是否重新打开由拒绝范围与具体的新依据决定。
- I05：没有证据证明不同，不等于证明相同；没有证据证明变化，不等于证明没变化。unknown与明确none、0、false不同。
- I06：资格/区域/模型/渠道/积分池/轮次的已知冲突不能被标题相似度覆盖。相同官方计划的资格变更也不能机械拆成新活动，需判断时间与更新关系。
- I07：媒体来源可以提供候选和引用，不能仅因匹配到approved而伪装成官方核验；tested只能由管理员明确亲测设置。
- I08：同一幂等命令重试返回同一收据；不同幂等键的同一活动仍须业务去重。两者分别测试。
- I09：任何索引、数据库、模型或抓取故障均不能被解释为“历史为空，因此是新活动”。保存观察，延后处理。
- I10：不同ID并发发现同一强身份，最多新增一个实体、一个审核任务。未确认身份的候选不自动上架。
- I11：重复成功是候选的终态；部分失败只重试未解决的候选，不把整个线索重新从头研判。
- I12：公开API、统计、RSS、榜单和通知使用同一主记录解析；内部身份判断、拒绝理由、原始候选和reviewMemo不泄露。

## 2. 领域对象与判定结果

### 2.1 四个不同对象

Observation：一次有来源身份及内容版本的观察。原网页再次读取但正文没变，更新lastSeenAt即可；不代表一次新优惠。
Entity：现实中的优惠计划/独立活动，如某产品的注册礼、常驻免费池、某轮独立重置。UUID由服务端生成，永不由标题重算。
TermsVersion：某实体的一组有依据的实质条款。不可变；包含金额/单位/周期/资格/领取/有效期等，而非营销文案。
Decision：对某实体、条款版本、身份任务或候选的审核决定，包含作用范围、规则版本、理由与重开条件。不可删除改写，用后续决定显式取代。

拒绝的非优惠事项也可有Entity但没有公开offer；这解决“线索被拒却从未生成offer”的记忆缺口。母公司、发放产品、第三方使用模型的平台是不同层级，不能全局合并。

### 2.2 身份和条款分别输出

身份关系：SAME_ENTITY、DISTINCT_ENTITY、UNRESOLVED。
条款关系：SAME_TERMS、MATERIAL_CHANGE、INSUFFICIENT；只在SAME_ENTITY下有意义。

SAME_ENTITY不等于允许更新；MATERIAL_CHANGE不等于自动批准。不同帖子可以描述同一轮活动，同一天也可以发生两次独立发放。常驻每日刷新不建立每日新实体；独立额外重置可建立新实体并保留其独立事件依据。

## 3. 规范化事实合同

新增`src/shared/identity/types.ts`，所有API与pipeline共用Zod schema。设计下列核心类型，未知字段不得由模型猜成默认值：

```ts
type Fact<T> = { state: 'known'; value: T; evidenceRefs: string[] }
  | { state: 'unknown' };
type Cadence =
  | { kind: 'one_time' }
  | { kind: 'calendar'; count: number; unit: 'day'|'week'|'month'|'year'; timezone: string|null }
  | { kind: 'rolling'; seconds: number };
type Condition =
  | { op: 'all'|'any'; items: Condition[] }
  | { op: 'atom'; kind: 'new_account'|'student'|'teacher'|'business'|'region'|'plan'|'device'|'invite'|'payment'|'other'; key: string; value: string };
interface BenefitFacts {
  schemaVersion: 'benefit-facts-v1';
  issuerPlatformId: string;
  productKey: Fact<string>;
  mechanism: Fact<'signup'|'recurring_quota'|'referral'|'trial'|'free_access'|'identity_gift'|'grant'|'extra_reset'|'other'>;
  programKey: Fact<string>;
  pools: Fact<Array<{ poolKey: string|null; amount: string|null; unit: string; currency: string|null; cadence: Cadence|null; cap: string|null }>>;
  eligibility: Fact<Condition>;
  channels: Fact<string[]>;
  models: Fact<{ completeness: 'complete'|'partial'; ids: string[] }>;
  modalities: Fact<string[]>;
  claimWindow: Fact<{ start: string|null; end: string|null; timezone: string|null; endKind: 'date'|'standing'|'unknown' }>;
  creditValidity: Fact<{ kind: 'duration'|'date'|'never'|'unknown'; value: string|null }>;
  occurrence: Fact<{ issuerOccurrenceKey: string; evidenceRefs: string[] }>;
}
```

规则：

1. 数量用规范十进制字符串，不用浮点拼接哈希；1,000、1k、0.001M在单位相同且规模有依据时统一为1000。100元与100美元、100积分与100tokens不合并。美元估值不是身份事实，不以usdEstimate做查重。
2. 单独`$`无法确认币种时currency未知，不擅自填USD。月不等于30天；每5小时滚动窗口不等于每天固定刷新；不同poolKey不混成单一总额。
3. 字符串NFKC、空白规范化；受控枚举小写；产品/计划/模型别名通过版本化字典或人工确认映射，不通过删除任意后缀实现。版本号、设备代际、fast模式、区域和独立API渠道必须保留。
4. 数组仅在集合语义明确时去重排序。资格保留AND/OR结构；学生或教师不等于学生且教师。
5. 空models不能解释为覆盖所有模型。partial模型列表不足以证明删掉了未提及模型。未知日期/资格不覆盖已批准事实。
6. factsHash为稳定JSON序列化后的SHA-256，包含schemaVersion，排除标题、文案、URL、抓取时间、翻译语言、reviewMemo和估值。只对相同schemaVersion比较；升级规范化不得静默重算历史决定。
7. factsHash用于条款和候选比较，不是全球实体唯一键。两个独立活动可能拥有完全一样的事实。
8. evidenceRefs必须引用本次可信观察中的原语言摘录/位置；服务端验证摘录存在和源身份。翻译可用于语义比较，不冒充原文。

新增`normalizeBenefitFacts(input): NormalizationResult`与`compareBenefitFacts(a,b): { relation, changedPaths, conflicts, unknownPaths }`。字段变化只能在对应事实有证据时成立；单纯缺字段返回INSUFFICIENT，而非MATERIAL_CHANGE。

## 4. 持久化设计

迁移均为增量，编号取执行时下一个未使用编号；不要假定0017仍空闲。每张表有明确主键、外键、时间与必要索引。以下是数据合同，不是要求一次PR建完全部表。

| 表 | 关键列/约束 | 责任 |
|---|---|---|
| benefit_entities | id UUID PK; issuer_platform_id FK; product_key nullable; mechanism nullable; current_approved_version_id nullable; state active/merged; merged_into_id nullable FK; revision INTEGER NOT NULL; timestamps | 稳定主体；无公开offer的拒绝事项也可存在 |
| offer_identity_links | offer_id PK/FK offers; entity_id FK; role primary/alias; epoch INTEGER; timestamps | 旧ID与实体关联；对entity_id建立WHERE role='primary'的部分唯一索引 |
| source_observations | id PK; observation_key UNIQUE; source_id nullable; origin; original_url; normalized_url; fetched_url; content_hash; snapshot_id nullable; source_attestation JSON; first_seen_at,last_seen_at | 来源/内容版本，不直接决定活动身份 |
| ingest_commands | command_key PK; principal; body_hash; state received/committed/retryable; result JSON; revision; timestamps | 请求幂等、最终收据与事务提交标记 |
| ingest_candidates | id PK; command_key FK; input_id; observation_id FK; extractor_version; raw_payload JSON; facts JSON; facts_hash nullable; entity_id/version_id/task_id nullable; outcome; revision; error; timestamps; UNIQUE(command_key,input_id) | 每个候选的独立进度与重试 |
| entity_anchors | anchor_key PK; entity_id FK; kind official_campaign/reviewed_evidence/reviewed_alias; namespace; scope JSON; basis_decision_id nullable; active BOOLEAN; revision | 已验证身份锚点与可撤销的人工别名 |
| benefit_versions | id PK; entity_id FK; transition_key UNIQUE; base_version_id nullable; facts_schema_version; facts_hash; facts JSON; effective_from/to nullable; order_status known/unknown; provenance; timestamps | 不可变条款与版本谱系 |
| review_decisions | id PK; command_key; target_kind; entity_id/version_id/task_id/candidate_id; action; scope JSON; reason_code; reason; actor; rule_version; reopening JSON; supersedes_id nullable; at; UNIQUE(command_key,target_key) | 持久审核决定，目标字段CHECK恰好符合target_kind |
| review_tasks | id PK; task_key UNIQUE; kind first_review/terms_change/identity_check/reopen_request/source_check; entity_id/version_id nullable; status open/checking/completed/cancelled; revision; generation; reason; timestamps | 一个业务问题一个任务；任务与抓取job分开 |
| review_task_candidates | task_id FK,candidate_id FK; composite PK | 同一任务附加多个来源，不重建任务 |
| identity_write_state | platform_id PK/FK; revision INTEGER NOT NULL | 同平台身份提交的乐观并发栅栏 |
| business_event_receipts | event_key,channel composite PK; entity_id; version_id/task_id nullable; kind; legacy_delivery_id nullable; status pending/sent/unknown/released; timestamps | 业务通知幂等；复用已有deliveries实际传输 |

约束与兼容性：

- current_approved_version_id必须属于同一entity；primary offer必须与同一版本投影一致，在受版本保护的batch中更新并有集成测试。
- `transition_key = SHA256(entityId, baseApprovedVersionId|null, factsSchemaVersion, factsHash)`。不把(entityId,factsHash)设为终身唯一：条款A→B→A可以是真实恢复。来源若只是旧文重现则不自动形成回退，必须核对生效顺序。
- observation_key由规范来源身份与内容hash构成；X等固定帖子采用已验证postId+author，不是抓取端CDN地址。一个观察允许多个候选；不能对normalized_url或content_hash设置“唯一实体”约束。
- anchor namespace包含实际发放方/产品及活动作用域。裸URL、模型slug、标题和模型返回的sameAs永远不是强锚点。已确认页面上的某个权益摘录组合可作为reviewed_evidence，不能把整页都锁到该活动。
- raw_payload及source_attestation仅管理员可读。原文正文尽量引用现有snapshot，不默认永久保存250KB正文副本；截断明确标记，不能拿不完整正文推断旧条款消失。禁止存密钥、cookie、登录态或客户数据。
- 先有schema和兼容reader，再backfill映射，最后切换业务。未回填旧行仍按legacy路径展示，但不能在强制身份模式下绕过身份闸门写入。

## 5. URL、来源身份及候选召回

### 5.1 来源规范化

复用并增强normUrl；只去掉经过批准的追踪参数。保留内容参数、语言页身份、fragment中实际标识内容的部分（有证明才移除）；统一已验证的twitter/x别名，记录重定向链。www/协议等规范化不代表证据主机可信，官方归属仍由officialTier及已有source identity检查决定。

同URL旧页面内容变化新增Observation；同内容多URL可共享摘要，但不能自动关闭所有候选。手工提交已存在URL默认附加备注/来源，不清空resolution，不重置为new。明确重开走第8节接口。

### 5.2 候选召回范围

输入：实际issuer、product、mechanism、来源锚点、规范事实和用户已确认别名。
历史范围：approved、pending、rejected、ended/withdrawn及没有offer的拒绝Entity；不设“最近60天”之类身份失忆窗口。拒绝理由完整读回，不只取最近10条corrections。

顺序：强锚点/别名精确召回 → 相同产品与机制/积分池/资格的结构化候选 → 词面索引补充。默认最多25个候选进入一次判断，分页游标必须可继续；达到上限且仍可能漏掉相关候选时返回truncated，不得当作“无重复”。标题和valueText不截成40字再作最终判断。

D1 FTS5可以用于词面补充；中文使用显式分词或字符n-gram辅助列。FTS不是跨语言语义解决方案。第一版多语言主要由规范事实与已确认别名召回；可选多语embedding仅用于候选召回，需独立预算与评估，不能取相似度阈值直接合并。

索引是可重建投影，不是事实主库。索引版本落后、查询错误或预算耗尽时，保留候选为deferred，不能catch后设置existing=[]继续创建。

## 6. 统一身份解析器

新增共享服务`resolveCandidate(input, context): Resolution`，供所有写入口调用。Worker处理确定性校验与最终提交；pipeline的`identity.ts`负责预算内语义判断，不在D1事务内调用LLM。

执行顺序：

1. 验证幂等键和请求bodyHash，保存观察/候选；服务端生成候选ID，保存输入ID作为诊断信息。
2. 验证来源、归属和facts schema。现有lead-review job有效性、作者/帖子绑定、官方补证匹配、tested限制继续执行；命中别名不能绕过它们。
3. 召回完整范围内的历史候选，携带实体revision、批准版本、拒绝决定及来源，不只给模型标题。
4. 计算已知事实冲突。不同issuer或独立产品、独立pool、同时存在的资格/渠道/模型范围、已确认不同轮次，禁止仅凭文字匹配自动合并。
5. 强身份且相同条款 → SAME_ENTITY/SAME_TERMS。强身份且有可信实质替换 → SAME_ENTITY/MATERIAL_CHANGE。资格冲突若被同一官方计划的新版本明确替换，是变更，不是独立活动。
6. 没有强锚点时，以完整事实、同一明确计划/免费池、唯一兼容候选及官方来源关系判断。factsHash相同但活动轮次或计划未知，仍不得硬合并。
7. 仍不确定才调用语义判断。每次最多12对，使用现有modelBudget，复用同一候选事实对+证据hash+规则版本的判断缓存。模型只能从提供的候选ID中选择，输出关系、事实差异、证据引用和unknown项，严格校验JSON。
8. 模型输出是建议。只有可验证身份锚点/同一计划依据、关键资格无冲突、证据完整且候选唯一时才自动关联；纯语义高分不够。首次含糊跨源关系进入一个identity_check，人工确认后持久保存适用范围内的alias，后续不重问。
9. 提交前重新核对实体、决定和平台身份revision。事务竞争返回retryable并重读，最多本轮3次；不能用旧候选列表继续写。

判定记录保存：matchedEntityIds、chosenEntityId、evidenceRefs、conflictPaths、unknownPaths、resolverVersion、normalizerVersion、来源判断及判断方式。不要把内部模型推理长文保存/公开，保存可复核的事实理由即可。

旧findDuplicate/sameBenefit的调用不能继续各自决定写入。迁移期间可把它们作为召回信号，但它们不能覆盖统一的冲突与权限闸门。包括同ID路径也必须核对身份；不能通过猜到某个existing ID改写另一活动。

## 7. 状态路由及任务去重

| 当前决定/关系 | 候选outcome | 动作 |
|---|---|---|
| approved + SAME_TERMS | duplicate_approved | 关联观察与版本；不改公开值、不生成任务或new通知 |
| pending + SAME_TERMS | linked_pending | 附加到现有任务；不额外建卡 |
| rejected且决定仍适用 | duplicate_rejected | 关联决定与实体，候选结束 |
| 同实体真实变化 | proposed_update | 保留approved投影，创建/复用条款提案及任务 |
| 决定因新依据可能失效 | needs_reopen | 创建/复用reopen_request，不自动批准，不换ID |
| 完整召回后确认新实体 | created_pending | 新实体、新草稿、一个首次审核任务 |
| 身份不足 | needs_identity_review | 创建/复用identity_check；尚不新建可上架offer |
| 技术故障/索引不足 | deferred | 保存进度，进技术重试/健康列表，不假装新优惠 |
| 输入不合法 | invalid | 返回具体字段原因，保留关联的输入诊断 |

任务key：terms_change以entityId+baseApprovedVersionId+factsHash；first_review以entityId；reopen以被挑战decisionId+补足证据的语义签名；identity_check以候选实体集合+完整冲突/范围签名；generation仅在显式重开决定后增加。标题、翻译、观察时间和普通jobId不进入业务taskKey。

没有足够事实形成安全identity_case key时，先按确切观察权益片段建临时case，不把全平台未知线索混为一组。后续出现与现有case明确兼容的候选可加入该任务，但各候选独立解决；人工“不同活动”必须可拆分case且持久保存negative relation。不得声称所有未知跨语言事项都能零人工准确归一。

同一线索包含多个权益时，ingest_candidates逐项保存outcome与引用。只有所有候选resolved且没有未知平台/解析错误/未处理证据，才把lead置linked或closed。一部分解决时保留remainingCandidateIds，下轮只处理这些。legacy lead.offerId保持首个主offer兼容，resolution中完整IDs由服务端主记录映射产生，不因失败丢掉先前成功项。

## 8. 审核决定与明确重开

拒绝不是全局永久黑名单。`Decision.scope`与`reopening`需可机器判断：

| 理由 | 默认范围 | 可以产生重开请求的新依据 |
|---|---|---|
| paid_bundle / ordinary_discount / not_ai | 特定产品、机制、适用规则版本 | 官方明确出现独立额外赠送；或管理员变更收录规则 |
| insufficient_evidence / vague | 当前候选或当前条款版本 | 新官方材料补足此前明确缺失的事实 |
| duplicate | 被拒别名到主Entity的关系 | 发现独立计划/轮次/领取范围的反证 |
| wrong_platform | 当前归属断言 | 官方发行主体的可靠纠正；不能把原拒绝扩大到正确平台 |
| expired | 特定活动轮次及当时有效性 | 官方确认新的独立轮次；旧URL重新传播不是新轮次 |
| wrong_field | 被拒提案版本中的具体字段 | 有依据的新字段事实或管理员纠正，不封禁整个实体 |
| other | 默认exact_version | 先由管理员说明范围，不自动推广为通用政策 |

旧拒绝无法推断范围时导入exact_version/legacy_unknown，禁止按品牌全禁。规则版本变化仅触发受影响候选的重开评估，不全量清空决定或自动重审所有记录。

管理员新增动作：关联同一活动、确认不同活动、确认新条款、补充证据、请求重开。都有expectedRevision、reason及当前对象快照。requested actor由服务器鉴权确定；reviewer可按现有权限审核，但历史批量合并/撤销合并仍仅admin。

批准更新时在同一受版本保护提交中：写Decision、更新currentApprovedVersion和公开投影、处理proposal/task、记录revision与业务事件。拒绝时同样原子保存Decision/兼容rejected_offer_updates并结束任务；同一命令重试返回收据，不重复增cleanStreak或记录审核。

## 9. API合同和兼容迁移

新增版本化接口；旧入口先作为适配器，不能一夜删除所有脚本：

```ts
interface IntakeV2 {
  requestId: string;
  schemaVersion: 'intake-v2';
  observation: ObservationInput;
  candidates: Array<{ inputId: string; extracted: unknown; facts: BenefitFacts }>;
}
interface CandidateReceipt {
  inputId: string;
  candidateId: string;
  outcome: 'created_pending'|'duplicate_approved'|'duplicate_rejected'|'linked_pending'|'proposed_update'|'needs_identity_review'|'needs_reopen'|'deferred'|'invalid';
  resolved: boolean;
  entityId: string|null;
  canonicalOfferId: string|null;
  versionId: string|null;
  decisionId: string|null;
  taskId: string|null;
  retryable: boolean;
  reasonCode: string;
}
```

- `POST /api/ingest/v2/candidates`：最多50候选，inputId在请求内唯一；幂等头与requestId一致。重复键不同bodyHash返回409；同内容重试读回相同receipt。
- `GET /api/ingest/v2/commands/:requestId`：有权限的任务读取提交收据；不得通过未鉴权公共接口读取。
- `GET /api/ingest/v2/identity-candidates`：按issuer/product/机制分页召回，响应indexVersion、truncated、游标，不提供无界全库提示词。
- `POST /api/ingest/v2/identity-results`：自动语义判断建议，包含taskRevision、candidateRevision、支持证据；后端再次校验，不能绕过规则直接上架。
- `GET /api/admin/identity/tasks`：分页身份/条款/重开任务，明确与技术重试分组。
- `POST /api/admin/identity/tasks/:id/resolve`：same_entity、different_entity、new_entity、request_terms_change；必须reason与expectedRevision。
- `POST /api/admin/identity/decisions/:id/reopen`：新增重开决定及任务，不删除旧决定。
- 现有offers、official-reviews、lead-reviews、manual、edit、approve/reject、unpublish、withdraw必须适配统一service。unknown skipped不再用于表达duplicate终态。

总体响应可保持200并逐候选给outcome；认证400/401/403、版本/幂等冲突409、系统暂不可用503与字段invalid明确区分。网络超时不得盲目重发非幂等旧写请求；先查receipt。旧客户端兼容窗口至少覆盖一个完整发布周期，以实际调用日志确认后移除。

## 10. 并发、事务与通知

LLM和网页读取在事务外。最终数据库提交使用D1 batch、唯一约束和条件写：

1. 读取identity_write_state与相关entity/task/decision的revision。
2. batch首条只在这些revision仍匹配且本命令未committed时登记本次提交标记。
3. 所有后续写入依赖该提交标记；成功后递增平台revision、保存实体/锚点/版本/任务/候选/收据。零行匹配不能继续产生副作用。
4. 相同强anchor的UNIQUE冲突重新读取已存在实体，不生成另一个ID。不同ID但同语义的并发，竞争平台revision后必须重新解析，而不是仅更换幂等键重试INSERT。
5. 所有新增offer/决定入口都参与revision，禁止旧适配器绕过。跨平台纠正要检查涉及的全部平台revision，按稳定排序处理；无完整证据时人工任务，不跨平台自动合并。
6. 同一D1一致性上下文读写；重试从权威数据重新读取，不依赖落后索引。集成测试必须包含真实SQLite约束与D1 staging批处理行为，不能只模拟返回值。

通知：复用deliveries/notifications发送机制，引入稳定business event key：新上架由entityId+首次批准epoch，条款更新由entityId+versionId，审核提醒由taskId+generation；再加channel。措辞/来源/job变化不生成事件。收据pending/unknown仍阻止盲重发，外部发送无法保证exactly-once时明确保留unknown人工对账。

飞书常驻榜每日重复展示是有意功能，不能被永久去重抹掉；其业务key包含明确的digest日期。日常榜单重复展示和同一条优惠被再次当成“新上架”是两回事。

## 11. 前端、读取与审计

新增“来源/别名”折叠区，展示主活动、关联来源数、之前决定、为什么相同/不同/变更以及具体字段差异。默认审核列表按任务而不是原始候选行计数。一个新来源只增加来源数，不刷新用户正在编辑的表单。

后台提供“确认同活动”“确认独立活动”“有新条款”“沿用拒绝”“新依据请求重开”，每次显示作用范围。不能以一个泛化“删除重复”按钮隐含永久拒绝或物理删除。

所有公开列表/详情/RSS/平台页/按模型/日历/洞察通过`canonicalOfferQuery`与`resolvePublicOfferId`；未通过平台和条目继续不公开。GET旧别名ID返回已批准主记录及requestedId/canonicalId，SPA用history.replaceState更新hash，不触发第二次审核/发送。详细别名与拒绝原因仅admin接口可见。

分开lastSeenAt、lastVerifiedAt、decisionAt、termsEffectiveAt、rowRevision。来源附加不使审核内容版本失效；真正的用户可见条款/提案改动才推进对应taskRevision。

## 12. 实施拆分与文件职责

S2-A 数据合同与增量schema：`src/shared/identity/types.ts`、`src/db/schema.ts`、新migrations；测试schema约束、旧数据可读、空值语义。
S2-B 规范化和事实比较：`normalize.ts`、`compare.ts`；纯函数测试跨语言量纲、周期、资格AND/OR、模型版本、未知/缺失。
S2-C 数据仓库与召回：`src/worker/identity/repository.ts`、`retrieval.ts`；含历史/拒绝主体、分页、版本、故障关闭及可重建索引。
S2-D 统一解析和命令提交：`resolver.ts`、`commands.ts`、`routes.ts`；条件batch、强锚点UNIQUE、候选级收据与多请求竞争。
S2-E pipeline适配：`pipeline/identity.ts`、run.ts、lead-review.ts、official-review.ts、offer-draft.ts、llm.ts；复用预算、异步判断建议、只重试未解决候选。
S2-F 管理状态机：`src/worker/identity/decisions.ts`、现有admin入口、reviewer权限、旧脚本与仓库审核技能；决定范围、明确重开、人工保护。
S2-G 公开投影与通知：`projection.ts`、worker/index.ts/admin.ts/feishu.ts及web实际对应模块；统一计数、旧ID解析、event receipt。
S2-H shadow/readiness：指标、评估、feature flags、合同和运维文档。逐项小PR，每项先红测再实现，整个项目测试绿后才接下一项。

执行方先检索web当前文件结构和脚本调用方，再给出准确改动清单；不得假设所有前端只在单一文件。新增模块应分职责，不把整套解析继续堆到index.ts或admin.ts。

## 13. 验收矩阵

测试fixtures要包含输入、既有状态、原语言证据、预期实体/版本/任务数/通知数和理由，不只断言一个相似度。至少120对标注用例，其中60对同活动变体、60对独立或变化的对照，跨至少5种不同优惠机制；中文/英文为必测，多语言扩展记录实际覆盖，不能声称已支持所有语言。

必须逐项通过：

| ID | 用例 | 预期 |
|---|---|---|
| A01 | approved注册礼换ID、语言、官网FAQ与社区转述 | 同Entity，无新offer/task/new通知；媒体不升级核验 |
| A02 | rejected普通折扣换来源/措辞 | 沿用相同范围决定，不重审 |
| A03 | leads阶段拒绝、从未生成offer | 新变体命中拒绝Entity |
| A04 | 同URL同时有注册礼、每日积分、学生权益 | 三个正确实体，不整页合并 |
| A05 | 同标题、同金额，学生与企业/国内与国际/不同设备 | 独立或待身份核对，绝不静默合并 |
| A06 | 每天100变每月100；单位/周期/有效期改变 | 同Entity的变更提案；旧公开版本不变 |
| A07 | 删除字段、无关导航变化、原摘录换句、数组顺序 | 不产生条款变化 |
| A08 | 官方新公告明确修改旧计划；旧公告晚抓到 | 新公告进有依据提案；旧公告不把政策回退 |
| A09 | 同一天两轮额外重置及同轮预告/确认 | 两轮分开，同轮合并；没有轮次依据留判断 |
| A10 | 免费层和付费套餐/邀请奖励与充值奖励 | 按机制与现役规则区分，拒绝范围不扩大 |
| A11 | 初次证据不足，后来补齐官方证据 | 一个reopen_request，不新ID或自动批准 |
| A12 | sameAs伪造、同ID指另一产品、冒充tested | 拒绝越权写入，保留诊断 |
| A13 | 相同请求重试、相同key不同body | 同receipt；不同body409 |
| A14 | 不同ID并发同活动、候选列表过时 | 最多一个实体和主任务；输者重读关联 |
| A15 | 三候选两已解决一失败，进程中断重跑 | 仅重试剩余候选 |
| A16 | 审核/编辑/拒绝/提案/通知竞争，SQL中途失败 | 无部分提交、无丢决定、无双通知 |
| A17 | 索引不可用/分页截断/模型额度耗尽 | deferred，不当作无历史 |
| A18 | 标准化规则升级或收录规则变化 | 显式版本评估，不全库失忆/重审 |
| A19 | 来源/别名附加时正在编辑后台表单 | 草稿不丢失，reviewVersion不无故变化 |
| A20 | 从所有公开入口读旧ID和主ID | 只见一项有效主记录，无内部信息泄漏 |
| A21 | 定期常驻榜与new/changed业务事件 | 日报正常；别名不重复变成new |
| A22 | Mistral原文双锚、source scope等基线回归 | 原有保护全部继续通过 |

运行`npm run typecheck`、完整`npm test`、`npm run build:web`和新增端到端/迁移测试。真实D1 staging与真实模型评估需明确环境和授权；普通CI使用合成/脱敏fixtures，不接生产服务。

## 14. 上线门槛、指标与回滚

feature flag `DEDUPE_V2_MODE=off|shadow|enforce`默认off。shadow保存隔离的解析诊断，不改变现行队列/公开状态/发送，不把shadow决定当正式拒绝记忆。enforce只在所有入口适配、旧数据基本映射和唯一约束验证后启用。

建议评估门槛（工程目标，不是已测生产效果）：标注集所有关键误合并/漏掉真实变化用例为0；同活动变体召回率至少95%，不足时保留人工判断而不是降低硬合并保护；shadow至少覆盖7天与500个候选，样本不足不能声称达到生产准确率。管理员可明确记录更小规模试点决定，不得静默跳过门槛。

记录created/duplicate/changed/unresolved/deferred数量，按机制/来源/语言拆分；人工确认的误合并、重复审核比例、真实变更漏报、每候选模型成本、D1读写量和p95耗时。分母必须包括全部该阶段输入，不能把拒绝/失败排除以美化准确率。不承诺任何有限样本证明未来零错误。

发布顺序：备份/恢复点确认 → 增量schema → 兼容代码off → 第三阶段的基础映射backfill（不合并） → shadow → 审查指标 → 单独授权enforce。所有变更和mode变更留审计；存在旧writer时禁止开enforce。

回滚：先关闭新增自动决策/发送，保留观察、决定和alias账本；回滚兼容代码，不DROP新表。若已经执行第三阶段合并，不得切回会重新展示所有旧行的legacy reader；使用保留alias过滤的兼容模式，或先执行受控unmerge方案。任何回滚不得抹掉拒绝记忆或自动重新发送历史事件。

## 15. 参考与交付要求

源码基线：src/shared/dedupe.ts、review-stability.ts、lead-scope.ts、src/worker/index.ts/admin.ts/lead-review.ts、pipeline/run.ts/lead-review.ts、schema与现有测试。第一阶段验证说明位于`docs/phase1-dedupe-fix-2026-10-10.md`。
技术依据：Cloudflare D1 batch事务文档 https://developers.cloudflare.com/d1/worker-api/d1-database/ ，SQL/FTS文档 https://developers.cloudflare.com/d1/sql-api/sql-statements/ 。实施时核对届时API和账户限制，不把本规格默认批量大小当作供应商配额事实。

完成交付必须包括：增量迁移、API兼容说明、fixtures、红/绿测试记录、全套CI、实际覆盖与未覆盖清单、shadow报告模板、发布/回滚手册，以及更新后的data-contract/operations/审核技能。没有生产授权，不执行部署、生产迁移、线上重抽、通知发送或批量合并。
