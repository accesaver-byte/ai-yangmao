# SPEC · 第二阶段：统一活动身份、条款版本与拒绝记忆

版本：1.0 · 2026-10-10 · 状态：待实施，不代表已部署

前置：[第一阶段修复与验证](../phase1-dedupe-fix-2026-10-10.md)。实施顺序和交付要求见 [Codex 执行说明](../plans/dedupe-codex-execution.md)。历史数据整理单独执行 [第三阶段 SPEC](dedupe-phase3-history-consolidation.md)。

## 0. 任务边界与权威来源

目标是“同一个羊毛只产生一个活动身份；审核同一事实版本一次；再次发现只补来源，实质变化才送审”。不是禁止重抓官网，也不是把所有类似优惠合并。

沿用 Node.js 24、TypeScript、Hono、Drizzle、Cloudflare Worker/D1、现有 Actions 管线。保留 offers 作为公开展示投影，保留 proposals/revisions/reviews 及人工字段保护。不先引入独立向量数据库、消息系统或全站重写。多语向量召回可以后续增加，不是本阶段上线前提。

必须先读 AGENTS.md、docs/data-contract.md、pipeline/learned-rules.md、docs/operations.md。收录规则与平台事实仍以上述现役文档为准，本 SPEC 不自动批准任何平台或活动。实际代码入口包括 pipeline/run.ts、pipeline/lead-review.ts、pipeline/official-review.ts、src/worker/index.ts、src/worker/admin.ts、src/worker/lead-review.ts、src/shared/dedupe.ts、src/shared/review-stability.ts、src/shared/lead-scope.ts。

本次授权只是提交第一阶段 PR 和本规格。实施第二阶段可以在新分支和隔离数据库进行；生产迁移、历史写回、外部模型调用、消息发送、合并和部署都需要届时明确授权。不得提交密钥、完整生产导出或真实用户数据。不可用生产 /collect、/approve 等端点作测试。

## 1. 必须保持的业务不变量

1. 同一活动的中文、英文、另一个页面、另一个模型 ID 不是新活动的充分理由。
2. 同一 URL 也不是同一活动的充分理由：一个价格页可以同时含注册礼、每日积分和学生优惠。
3. 产品/领取渠道按实际发放权益区分；同母公司不合并旗下全部产品，第三方供应同模型也不等于发放方相同。
4. 活动身份、条款版本、抓取观察和审核决定是四种不同对象。金额不能作为活动的永久主键。
5. 未知不是“没有”，遗漏不是“取消”；字段矛盾不能由标题相似度覆盖。
6. 已批准的公开版本在新版本通过前不变。身份合并不构成批准、亲测、重开、恢复上架或更新官方核验日期。
7. 拒绝覆盖已拒 offers、已拒更新，以及从未生成 offer 的已拒 leads。拒绝有明确对象、依据、范围和重开条件。
8. 检索/模型/数据库故障不等于“未找到重复”。保留候选并重试，不能在身份检查失败后直接创建可上架 offer。
9. 所有写入口经过同一个服务端身份解析与提交服务；模型 sameAs/fixedId、补录、官方复核都不能绕过。
10. 一个候选的已解决重复是成功终态，不重新排队；一条线索含多个候选时，只有未解决部分重试。
11. 通知针对稳定审核任务/实质版本，而不是 URL、抓取日期或数据库更新时间。
12. 自然语言身份可能无法确定。系统必须明确返回 uncertain，而不是承诺所有同义表达都能被自动合并。

## 2. 术语与关系

- Observation：一次可复用的来源内容版本。网页正文、最终 URL、抓取时间、哈希、原语言、可信度和原文片段。
- Candidate：从某 Observation 抽出的一个可能权益，包括不应收录但值得记住的事项。页面允许零个、一个或多个候选。
- BenefitEntity：现实中的优惠计划或独立发放事件。服务端生成不可变 UUID。长期计划和独立重置事件均可拥有实体。
- BenefitVersion：某实体的不可变条款快照。规范化事实变化产生候选版本，而非直接覆盖公开值。
- ReviewDecision：对实体、版本或未成稿候选的决定。追加记录，撤销/替代也新增决定。
- ReviewTask：需要人处理的一次问题。多个来源可以指向同一个任务。
- Offer：网站已经使用的条目/URL。是实体已审版本的展示投影，不再充当每次模型输出的身份容器。

关系：Observation 1→N Candidate；Candidate 可以关联 Entity/Version/Decision/Task；Entity 1→N Version；一个 Entity 最多有一个公开 canonicalOfferId。未成稿的已拒事项允许有 provisional Entity 而没有 Offer。

两个历史 Entity 是否相同由第三阶段人工确认，不通过第二阶段迁移静默合并。

## 3. 活动身份与条款变化的边界

### 3.1 稳定锚点优先，不拼接所有字段生成永久 ID

强锚点：经校验的官方 campaign/program ID、已确认的活动专用领取入口及其权益范围、管理员确认的实体别名映射。URL/帖子 ID 必须附权益范围；同一公告包含多个福利时不能共用一个唯一锚点。

弱信号：标题、模型生成 ID、金额、文案相似度、平台名、页面哈希、未经核实的 sameAs。这些只能召回候选或提供解释，不能单独建立硬合并/拒绝黑名单。

AI 生成的英文 key 不保证稳定，也不保证不会碰撞。别名必须注明 namespace、出处和资格范围；新的相同 key 遇到事实冲突必须进入身份核对，不能复用主记录后静默丢弃。

### 3.2 统一冲突规则

硬合并前检查实际发放产品、机制、积分池、适用模型、渠道、地区、资格和轮次。采用 known/unknown/explicit_none 三态。已知不同不能被最后的标题匹配分支覆盖。

冲突并不必然表示新 Entity：官方明确从“学生专享”调整成“所有用户可领”，可能是同一活动的新版本；官网同时并列学生项目和企业项目，则是不同 Entity。需结合活动锚点、官方替代声明、有效时间和来源解释。

### 3.3 示例（测试使用虚构平台，不代表真实政策）

| 输入 | 身份 | 条款/动作 |
|---|---|---|
| 注册送 $10 / signup bonus 10 USD / 注册赠10美元，其他条件一致 | 同实体 | 同版本，追加来源 |
| 同计划注册赠 $10 改为 $20，有官方变更证据 | 同实体 | 新版本提案 |
| 都叫“免费会员一个月”，学生认证 vs 企业申请，同期独立项目 | 不同实体 | 各自首次审核 |
| 每日100积分改每月100积分 | 同实体 | 周期变化，必须提案 |
| 常驻每日刷新又到了一天 | 同实体 | 不创建独立发放 |
| 官方额外补偿/重置两次，独立轮次有证据 | 不同事件实体 | 不按同日同金额合并 |
| 同次重置的预告、确认、进度回复 | 同事件 | 合并来源；不能仅看发布时间 |
| 学生一年会员，后来设备持有人也送一年 | 无共同计划证据时独立/uncertain | 不能只看一年或相同品牌 |

## 4. 规范化事实合同

在 src/shared/identity/types.ts 定义并用 Zod 校验。推荐接口必须具备以下信息，命名可以随既有代码小幅调整但需同步测试和文档：

```ts
type Known<T> =
  | { state: 'known'; value: T; evidenceRefs: string[] }
  | { state: 'explicit_none'; evidenceRefs: string[] }
  | { state: 'unknown' };

type Cadence =
  | { kind: 'one_time' }
  | { kind: 'calendar'; period: 'day' | 'week' | 'month'; timezone: string | null }
  | { kind: 'rolling'; seconds: number }
  | { kind: 'unknown' };

interface BenefitFacts {
  schemaVersion: 1;
  issuerProduct: Known<string>;
  mechanism: Known<'signup' | 'daily' | 'referral' | 'trial' | 'grant' | 'membership_gift' | 'reset' | 'free_access' | 'discount' | 'other'>;
  pools: Known<Array<{ poolKey: string | null; amount: string | null; unit: string;
    currency: string | null; cadence: Cadence; models: string[] | null }>>;
  eligibility: Known<string[]>;
  audience: Known<'new' | 'existing' | 'all'>;
  regions: Known<string[]>;
  channels: Known<string[]>;
  claimWindow: Known<{ start: string | null; end: string | null; timezone: string | null }>;
  creditValidity: Known<string>;
  occurrence: Known<{ programKey: string; roundKey: string }>;
}
```

金额用规范十进制字符串或定点整数，不能通过浮点运算造成哈希漂移。10 USD / $10 / 10美元在证据明确 USD 时可规范一致；模糊美元符号不能自动推定币种。6万、60,000、60k 可统一；100 credits 与100 tokens不可自动等价。不同产品的积分单位必须带产品命名空间，不做未经证实的价值换算。

models、资格、地区等集合排序去重；不能把不同免费模型当作相同集合，不能把未知模型集当成空集。地区词翻译需受控映射，保留原文。发放周期包含 calendar/rolling、时区、独立 pool，不能仅提取一组数字。

原文引用通过 evidenceRefs 指向 Observation 的片段与哈希。抽取字段必须附来源；模型解释不是官方事实。支持人工更正并记作者/版本，不反向改原文。

`termsHash = SHA256(stableSerialize({schemaVersion, normalizedFactsWithoutEvidenceRefs}))`。不包含标题、来源语言、URL、抓取日期、模型生成 ID、估值或内部备注。它仅是版本索引，不是独立身份判据；两个 unknown-rich 对象同 hash 也不能证明同一活动。

比较函数返回 equal / changed / insufficient，并列出字段和依据。缺字段只产生 insufficient 或补证，不从已审版本删除旧值；明确取消/替代需原文依据。新 URL 的可信官方更新可产生待核对提案，但不能自动当作 changed 或自动更新公开版本。

## 5. 持久化模型与约束

新增迁移编号从实际分支末尾分配，不假定0017永远可用。仅新增表/可空字段/索引，禁止删除旧数据。Drizzle schema 与实际迁移保持一致；检查 migrations/meta 与手写迁移管理，不能让 db:generate 重复生成已手写的变更。

### 5.1 核心表

| 表 | 最低字段与约束 |
|---|---|
| benefit_entities | id PK；platform_id FK；product_key；mechanism nullable；state provisional/confirmed/merged；canonical_offer_id nullable UNIQUE FK；redirect_to nullable FK自身；identity_revision INTEGER；created_at/updated_at。redirect不能自指、不能成环。 |
| source_observations | id PK；source_id nullable；normalized_url；final_url；content_hash；parser_version；language；trust_tier；sanitized_text；excerpts JSON；first_seen_at/last_seen_at。UNIQUE(normalized_url,content_hash,parser_version)。 |
| extraction_candidates | id PK；observation_id FK；extraction_version；local_key；raw_facts JSON；normalized_facts JSON；entity_id/version_id/task_id nullable；status unresolved/resolved/deferred；outcome；reason；next_attempt_at；attempts；revision。UNIQUE(observation_id,extraction_version,local_key)。 |
| benefit_versions | id PK；entity_id FK；schema_version；terms_hash；facts JSON；created_at；effective_from nullable。UNIQUE(entity_id,schema_version,terms_hash)。事实行不可变，审核状态从decisions/current指针推导。 |
| version_evidence | version_id FK；observation_id FK；candidate_id FK；field_refs JSON；PRIMARY KEY(version_id,candidate_id)。新增证据不改原版本事实。 |
| benefit_aliases | id PK；kind；namespace；alias_key；entity_id FK；strength confirmed/candidate；basis JSON；decision_id nullable；revision；active。只对active confirmed的(kind,namespace,alias_key)建立唯一索引；弱别名允许多匹配。 |
| review_decisions | id PK；command_key UNIQUE；entity_id nullable FK；version_id nullable FK；candidate_id nullable FK；action approve/reject/link_distinct/link_same/reopen/supersede；scope version/entity_policy/candidate_evidence；reason_code；reason；basis JSON；reopen_conditions JSON；policy_version；actor；created_at；supersedes_id nullable。CHECK至少有一个目标；父子归属要在提交中验证。 |
| identity_review_tasks | id PK；kind identity/new_offer/terms_update/reopen；entity_id nullable；candidate_ids JSON；proposed_version_ids JSON；open_key nullable UNIQUE；state open/resolved/cancelled；revision；decision_id nullable；created_at/updated_at。结案将open_key清空，新一轮有新task id。 |
| identity_commands | key PK；request_hash；platform_id；expected_generation；status applied；response JSON；created_at。只保存原子提交成功的回执，失败不能留下applied。 |
| identity_generations | platform_id PK FK；generation INTEGER。服务端身份集合变化、决定、别名和合并都必须递增，防止两个请求使用同一旧候选快照创建活动。 |

给 offers 新增 entity_id/version_id 可空 FK。旧记录暂可为空；实体 canonical_offer_id 指向既有或新建 offer。历史别名 offer可以指向同实体，但公开查询只返回canonical投影。不得把实体是否显示只放在前端过滤。

上述是必须实现的逻辑合同，不要求把表集中写进现有大文件。JSON字段必须在服务端schema校验；常用查询键必须是实际索引列，不能全表JSON扫描。

### 5.2 幂等与唯一性不混淆

Observation 唯一性解决同一次内容重放；Candidate 唯一性解决同一抽取版本重试；termsHash解决同实体同事实版本；open_key解决同一问题重复建审核任务；confirmed alias解决已确认身份重复；command key解决请求重试。没有任何单个哈希能够代替全部五层。

local_key由服务端规范化候选+证据范围生成；模型改写可产生另一候选，再由解析器统一身份，不承诺local_key解决语义去重。重复读取只更新last_seen_at，不重置status/resolution/next_attempt_at。

## 6. 统一服务接口与分层

建议模块：

- src/shared/identity/types.ts：合同、结果枚举、Zod。
- src/shared/identity/normalize.ts：纯规范化；无网络/数据库。
- src/shared/identity/compare.ts：事实相同、变化、证据不足、冲突判断。
- src/worker/identity/repository.ts：索引检索、分页、事务、代际控制。
- src/worker/identity/resolve.ts：服务端主流程；所有入口调用。
- src/worker/identity/decisions.ts：拒绝范围、重开、批准与撤销。
- pipeline/identity-assessment.ts：可选多语语义判断适配器，复用预算账本。

```ts
type ResolutionOutcome =
  | 'duplicate_approved' | 'duplicate_pending' | 'duplicate_rejected'
  | 'evidence_attached' | 'new_offer_pending' | 'terms_update_pending'
  | 'identity_pending' | 'deferred' | 'invalid';
interface ResolutionReceipt {
  inputId: string; candidateId: string; outcome: ResolutionOutcome;
  entityId: string | null; canonicalOfferId: string | null;
  versionId: string | null; decisionId: string | null; taskId: string | null;
  retryable: boolean; reasonCode: string; traceId: string;
}
```

`resolveCandidate(candidateId, expectedCandidateRevision, commandKey)`返回上述结果。canonicalOfferId可空：从未生成offer的拒绝也能完整结案。deferred为技术重试，identity_pending是已建立唯一身份任务，不再无限重复模型请求。

HTTP新增 `/api/ingest/observations`、`/api/ingest/candidates`、`/api/ingest/candidates/:id/resolve`，批量每次最多50个候选，逐项回执且包含inputId；输入对象结构错误400；并发/同command不同payload409；预算/依赖故障返回deferred或503并保留已保存候选。禁止把业务拒绝当技术异常重试。

保留 `/api/ingest/offers` 兼容适配器：将旧payload转换为候选并调用同服务。返回旧id/duplicateId/skipped仅为兼容，同时提供outcome；所有第一方调用者改为读取outcome。不给旧generated ID创建强别名。旧入口在enforce模式也不能绕过解析器。

## 7. 解析器算法（按顺序实现）

1. 读取候选、Observation、平台/产品信息。校验原文引用和可信度；不满足引用条件的模型输出仍是候选，不是假装官方事实。
2. 读取已成功command回执；同key不同requestHash返回409。
3. 读取当前platform generation G，然后检索候选；最终提交必须CAS G成功，否则重新读并重新解析，不能沿用旧答案。
4. 先查confirmed aliases和已关联的活动专用锚点；再用同发放产品/机制、官方入口范围、模型/积分池等检索。已批准、待审、已拒绝、撤回、已结束和provisional拒绝实体均不能排除。
5. 候选召回默认20条。强锚点命中不得被20条上限截断。其余按平台/机制过滤、索引关键词检索；超量且没有充分身份依据时identity_pending，不武断new。简单字段不要每次重新让模型提取。
6. 全部候选先通过统一冲突规则。明确不同保留distinct理由，跨语言可采用受控词表和已提取事实比较；对疑难关系调用受预算限制的模型重排。
7. 模型仅返回existingEntityId、same/different/uncertain、字段级理由、原文依据。必须校验ID在召回集中、片段存在、来源可信、条件无已知冲突。模型置信度或向量分数不构成硬合并依据。
8. 身份明确后做版本比较；未知/矛盾不能伪装equal。强身份匹配但证据不足时只挂证据/任务，不覆盖旧版本或延长官方有效性。
9. 应用历史ReviewDecision和收录规则。符合拒绝范围且无重开依据→duplicate_rejected；通过的同版本→duplicate_approved；待审同版本→duplicate_pending。
10. 真实变化形成一个terms_update任务，附新旧事实和证据；竞合候选版本都附同任务，不覆盖人工编辑。旧公开版本继续可见。已有evidence-only数据只能增加依据，不重复发卡。
11. 确认是新活动才创建Entity和新待审Offer。解析无法完成则建/关联identity任务；不确定对象间只可提示疑似关系，不能把一组模糊匹配视为传递闭包（A像B、B像C不等于A=C）。
12. 原子提交关系、决定/任务、公开投影（仅明确批准时）、代际递增、command回执；通知在事务成功后按任务身份派生。

FTS5可作词面召回；需实测中文分词/受控词表的效果，不能宣称SQLite默认词法天然解决中文或跨语义。向量检索非首版必需。缓存键至少含candidate facts/evidence hash、resolver版本、policy版本、候选实体identity revision；手动更正、重开、merge/split必须失效旧答案。

## 8. 拒绝语义与重新打开

| reason_code | 默认范围 | 允许重开的依据 |
|---|---|---|
| duplicate | 关联主实体/同版本 | 原关联被人工纠正，或新轮次证据；不是反复新增rejected副本 |
| paid_bundle/not_ai/ordinary_discount | entity_policy，须有明确事实/机制范围 | 独立赠送机制、收录政策改变或人工重开；换措辞/页面不算 |
| insufficient_evidence | candidate_evidence或具体版本 | 补足缺口的可信官方证据；同社区改写不算 |
| vague | 具体版本/候选 | 明确数量/资格等缺失事实得到证实 |
| expired | 已结束版本/事件 | 新轮次或可信延长公告，不能仅凭抓取时间 |
| wrong_platform/wrong_field | 当前候选 | 更正事实并保留纠错链，不能封杀该品牌全部优惠 |
| source_unavailable | 不是持久拒绝 | deferred技术重试，不进入永封 |

reasonCode不是自动规则本身。历史自由文本拒绝不能无条件翻译成宽泛entity_policy；默认按旧版本/旧证据范围迁移，需人工确认才能扩大范围。一个approved主记录旁边有rejected duplicate别名时，不能让别名拒绝推翻主记录批准。

重新打开是显式、有版本保护、有依据的新Decision。保存supersedes链，不删除旧决定。后台需要显示上次拒绝理由、日期、对象、作用范围、这次新增依据。普通“补充来源”不清空旧决策；`/manual`同URL不得自动new，新增独立`reopen`操作。

## 9. 事务、并发和失败处理

D1单条语句原子，batch中的SQL失败可整体回滚；零行UPDATE不是错误。不要把写入后的JS行数判断误当数据库回滚。

实现统一提交服务：使用platform generation和对象revision的CAS，只有本次command成功获得写资格后，后续全部INSERT/UPDATE/DELETE才执行。command_key唯一且对应request_hash。所有必要写入和最终回执在同一batch；若任一必要后置条件不成立，必须用数据库约束触发SQL失败使batch回滚。实现可用专用带CHECK(ok=1)的事务断言记录，或等效经测试的约束；禁止捕获错误后返回成功。

先读取G再召回，在CAS提交时验证G；另一个请求变更身份/决定/别名后G递增，本请求必须409/retry并重新召回。这样两个独立请求不会同时以“读到空历史”为依据提交两个已确定相同的实体。相同平台的语义模糊本身仍可能产生两个provisional实体，第三阶段或人工身份任务负责消解，不宣称CAS能解决未识别的语义关系。

bounded重试最多3次，之后deferred并记录冲突，不让一次HTTP请求无限循环。所有人工操作使用expectedRevision；不得收到409后自动刷新版本再提交同一批准/拒绝。定时核验只更新verification元数据，不无意义增加identityRevision。

失败策略：检索不可用→保留候选、deferred；模型预算不足→不重复预留/不抹候选；部分候选成功→保留逐项receipt；后续只处理未解决项；写commit超时→以同commandKey读回，不改key盲写。

## 10. 审核界面、通知与权限

在现有后台增加“身份核对”任务，不另建平行后台。展示建议主活动、批准/拒绝状态、差异事实、对应原文、信源数量和历史决定。操作：同一活动同版本、同一活动新版本、独立活动、拒绝/证据不足、仅补证；合并历史实体仍走第三阶段管理员专用入口。

同一任务增加更多来源只更新证据计数，不产生新卡片。通知key使用taskId+需要人重新判断的semanticRevision；updatedAt、lastSeenAt、来源数量不进入key。首次待审和条款更新分开。identity pending不得放入公开offer榜单或增加总价值。

管理员和审核员权限遵循现有设计；批量合并、实体重定向、宽范围拒绝规则、全局重开只给管理员。INGEST_TOKEN不能执行批准/实体合并/亲测。tested仅允许管理员明示；原文不能包含提示给模型执行的控制命令。外部文本按不可信数据处理。

## 11. 灰度、兼容与资源边界

配置 `IDENTITY_MODE=off|shadow|enforce`，缺省off；`IDENTITY_PLATFORM_IDS`用于灰度白名单。

- off：旧路径；新增表/字段存在但不改变公开输出。
- shadow：正常旧流程运行；新解析只记录影子结果/耗时/分歧，不新建真实审核卡、不影响通知/公开数据。
- enforce：灰度平台的所有入口使用新解析器；服务故障不能偷偷回退旧写路径。非灰度平台保持旧流程。

初始集合由第12节夹具及只读审计选择，不在SPEC里硬编码真实生产平台名单。迁移先于Worker代码部署；至少维持一个版本的旧入库合同兼容。回滚先恢复上一Worker/关闭enforce；新增表和决定保留，禁止DROP/清空拒绝记录。

默认每批50候选、单候选最多20普通召回、语义重排输入最多20k字符、复用现有模型预算；不是把全库送模型。为platform_id/status/entity_id/terms_hash/next_attempt_at建立索引，避免每条读全offers/reviews。记录真实rows_read、rows_written、tokens、费用，不在没有压测时承诺延迟。

source文本最大250000字符，片段保留原语言；不公开正文或内部推理。长文本保留哈希与相关片段，不能静默截断后声称不存在条款。生产原文保留策略先90天，其后可清正文但保留用于决策的引用/哈希/出处；个人信息需最小化和脱敏。持久决定、版本、别名不按此90天淘汰。

## 12. 验收测试与门槛

必须新增实际服务集成测试，不只测helper或mock返回值。使用迁移后的SQLite，并在授权的隔离Wrangler/D1环境验证batch、约束和并发语义。旧343个Vitest与8个CLI测试是第一阶段快照，不是未来固定上限；不能删旧测试达到通过。

最少以下夹具，每类含approved/rejected/pending和不同输入顺序的变体：

1. 三语言同注册礼、多URL、多ID→一个实体/版本/首次任务。
2. sameURL多权益→注册、每日、学生三实体不被压成一条。
3. 同数字不同周期；同数字不同货币/单位；滚动5小时与每天；积分池不同。
4. 学生vs企业、地区不同、设备代际不同、订阅档不同、邀请vs注册、同模型不同发放平台。
5. 同日两次独立reset保留；同次预告/确认不重复；常驻每日不是每天新活动。
6. rejected offer跨语改写拦截；rejected lead无offer跨来源也记住；已拒更新同版本不重开。
7. 证据不足后来找到官方依据→一个reopen任务；仅社区改写不重开；旧自由文本拒绝不扩大成全平台封禁。
8. omitted字段不删除、unknown不当none；verified/亲测时间不会因重复社区来源刷新。
9. 两并发请求同候选/不同ID同实体，最多一个活动/活动任务；CAS失败重新召回；审查时管理员更新→409。
10. 同commandKey同请求可重试；不同payload→409；写入中断、audit失败、零行guard、响应丢失→没有半套决定/提案。
11. 一条线索三候选（重复、有效新条目、失败）只重试第三项；已解决重复不再次发卡。
12. 索引服务失败不能建立新公开活动；模型不可用不清空记忆；恶意sameAs不得串改其他平台。
13. 活跃人工提案不被新抽取覆盖；新官方URL只送审不自动发布；同义改写不会制造变更。
14. 页面raw/内部memo/拒绝理由不得泄漏公开接口；所有公开入口和所有写入口均测试。

另建至少120对标注夹具：60对同活动同版本（至少20对跨语），30对独立优惠，30对真实变化/证据不足。按活动族划分开发/验收集，避免同模板泄漏；模型不作自己答案的裁判。验收集定义自动合并精确率、重复召回率、误合并数、重复人审任务数、真实变化漏报数，并保存逐例结果。

发布硬门槛：上述确定性回归全过；验收中独立优惠误合并=0、真实变化静默丢失=0、已确认重复重新建人审任务=0。未标注线上数据不能声称100%去重；未知案例允许identity_pending。影子观测至少覆盖两个完整采集轮次且无权限/回滚问题，再由管理员批准enforce。

## 13. 交付与不实施事项

每个PR交付迁移/schema、代码、测试、真实运行命令和结果、失败记录、兼容与回滚说明。同步data-contract、design、operations；本SPEC保持设计状态，实施后注明实际版本。

本阶段不自动合并已有重复offers、不重写历史审核、不重新发送旧通知、不修改估值算法、不增加未经证实的平台优惠规则。历史整理必须使用第三阶段的dry-run、人工确认、回滚合同。

## 14. 平台资料（实施时重新核对）

- D1 database/batch：https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1限制：https://developers.cloudflare.com/d1/platform/limits/
- D1 SQL/FTS5：https://developers.cloudflare.com/d1/sql-api/sql-statements/

以上支持平台使用方式，不代表本SPEC提出的业务算法已实现或已经线上验证。
