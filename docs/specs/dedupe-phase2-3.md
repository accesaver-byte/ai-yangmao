# SPEC：第二阶段统一活动身份与拒绝记忆；第三阶段历史重复整理

版本：1.0 / 2026-10-10。状态：供 Codex 实施的设计规格，**不是已实现或已上线能力**。

源码基线：`7cea69d95d2c27e2c1ebd7641a94bab2a696901d`。前置修复：PR #2，代码提交 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`，详见 [第一阶段验证](../phase1-dedupe-fix-2026-10-10.md)。执行前重新读取 main/PR，保留后续有效修改，不按旧 SHA 覆盖仓库。

配套：[实施任务](dedupe-phase2-3-plan.md)、[Codex 交接提示](dedupe-codex-handoff.md)。业务口径以 [data-contract](../data-contract.md)、[learned-rules](../../pipeline/learned-rules.md) 为准；本规格改变身份与流程，不自行放宽收录、证据或估值标准。

## 0. 目标、范围与授权边界

目标：同一优惠被不同页面、ID、语言、表达反复发现时，归到同一活动与条款版本；已批准或已拒绝的同版事项不再形成新审批。真正的新轮次、独立权益及有证据的条款变化仍可进入审核。

第二阶段负责新写入和既有对象的身份基础设施；第三阶段负责历史候选分析、经人工批准的逻辑合并、引用兼容及可逆整理。二者分别交付，不能用批量清库代替第二阶段。

本规格允许实施代码、测试、离线演练和提交分支/PR。**不授权合并 main、生产数据库迁移/导出/清理、部署、实际采集、付费模型调用或发送消息。** 有凭据不扩大授权。后续生产操作须另获管理员授权；脚本默认离线/本地且拒绝隐式生产配置。

不要求重写 Hono/Drizzle/D1、替换前端或引入向量数据库。暂不实现自动历史硬合并、全平台黑名单或依据模型相似度自动批准。

## 1. 不可违反的业务不变量

- I01：一条来源观察不等于一个优惠；一个页面可包含多个优惠，一个优惠可有多个页面。
- I02：主活动 ID 由服务端产生或从旧记录继承，模型 key/sameAs 只是假设，不能直接指定可信身份。
- I03：抓取日期、语言、标题、URL、估值变化本身不构成新活动或新条款。
- I04：同金额不等于同权益；单位、周期、独立积分池、产品、领取机制、资格、区域、模型和轮次必须参与判断。
- I05：未知不等于相同，也不等于冲突；缺少旧原文不等于官方取消旧政策。
- I06：已批准的公开版本在新版本批准前不被修改或下架；观察计数/lastSeen 不刷新 lastVerifiedAt。
- I07：被拒绝的活动版本与未曾生成 offer 的拒绝事项都能被检索；技术失败不能写成业务拒绝。
- I08：拒绝范围必须可解释、有版本；拒过一次不等于永久封禁该平台或所有相似权益。
- I09：同一候选的成功重复关联是处理终态；多候选线索只重试未解决部分。
- I10：并发/超时/重放不能产生重复活动、重复决定或重复审核通知；幂等键与业务身份是两套机制。
- I11：历史合并不删除原始证据、审核决定、修订或送达记录，不改变真实活动日期，不计为新增羊毛。
- I12：有事实冲突或来源不可信时只进入一个可追踪核对任务，不静默合并/拒绝/批准。
- I13：所有写入口服从同一身份服务；人工审阅可以明确裁决，但不能绕过版本竞争检查。
- I14：身份识别故障不影响已批准公开列表；不能把“索引读取失败”解释成“没有历史”。

## 2. 术语及固定架构选择

| 对象 | 定义 |
|---|---|
| subject（活动主体） | 一个现实优惠计划或独立发放轮次的稳定身份；即使不符合收录条件也可以存在 |
| observation（来源观察） | 一页/一帖的一个可辨认内容版本；保存来源、原语言证据及首次/最后发现时间 |
| candidate（候选） | 从观察中识别的一个权益或非权益事项；一页可产生多个候选 |
| terms version（条款版本） | 该活动的某组权益事实及证据；文案不参与身份，实质事实参与版本比较 |
| decision（决定） | 对主体、条款版本或身份核对任务的批准、拒绝、关联、分离或重开裁决 |
| case（任务） | 需要人工或后续自动核验处理的唯一工作项；多次发现可以补证，不重复建卡 |
| canonical（主记录） | 合并后对外读取和日常写入使用的根主体；不是某次模型生成的英文 key |

保留 `offers` 作为公开字段/待审草稿的现有投影，保留 `offer_proposals` 作为已批准条款的单一编辑区；新的身份、版本与决定表是持久依据。不得同时维护两个互不一致的批准状态源。

每个未合并 subject 最多对应一个 offer；没有合格羊毛的 rejected subject 可以没有 offer。常驻每日刷新属于同一计划；独立额外重置可单独建 occurrence。公司和产品不得混用：沿用平台白名单中的实际发放产品，第三方提供同一模型不与原厂优惠合并。

第一版使用 D1 普通索引 + 受控别名 + 结构化事实 + FTS5 候选召回；模型只处理有限候选的歧义。多语向量召回不是前置依赖，以后只能作为召回补充，不直接授权合并。

## 3. 数据模型与迁移要求

以下列名为实施合同；通用 ID 使用服务端 UUID，时间存 UTC ISO，JSON 用 Zod 校验后以 TEXT 保存。枚举加 CHECK，JSON 列加 json_valid；索引必须由 SQL migration 建立并与 Drizzle 一致。所有迁移增量追加，不改旧 migration。编号在实施时读取现有目录后分配，不能假定 0017 仍空闲。

### 3.1 主体、观察及候选

| 表 | 必需列与约束 |
|---|---|
| `deal_subjects` | `id` PK；`platform_id` FK platforms；`kind` 为 standing/campaign/occurrence/unclassified；`program_anchor`、`round_anchor` 可空且只有证据确认后填写；`state` active/merged；`merged_into` 可空 FK 自身；`identity_revision`、`content_revision` INTEGER NOT NULL DEFAULT 1；`approved_terms_id` 可空；`created_at`、`updated_at`。禁止 self merge，服务层拒绝环及跨未确认产品合并。索引(platform_id,state)。 |
| `source_observations` | `id` PK；`url_key`、`original_url`（清理凭据后，仅内部）；`content_hash`（原文 SHA-256）；`reader_version`；`tier`、`claimed_platform_id` 可空；`source_id` 可空 FK sources；`body_text` 可空；`body_complete` 0/1；`evidence_json`（原语言摘录/上下文/定位及可信检查）；`first_seen_at`、`last_seen_at`、`seen_count`；UNIQUE(url_key,content_hash,reader_version)。抓取失败另记 runs/健康，不伪造成功 observation。 |
| `intake_candidates` | `id` PK；`observation_id` FK；`candidate_key`；`kind` benefit/non_benefit；`raw_json`；`facts_json`；`facts_schema`、`extractor_version`；`state` unresolved/resolved/retry/conflict；`subject_id` 可空 FK；`terms_id`、`decision_id` 可空；`resolution_json`；`revision` INTEGER DEFAULT 1；`next_attempt_at`；UNIQUE(observation_id,candidate_key)。候选原文与归属证据不可因改写而覆写。 |
| `lead_candidates` | `lead_id` FK leads、`candidate_id` FK intake_candidates，联合 PK。一条线索多个候选，一个候选可被多个线索关联；最终关联清单不能只保存在 leads.offer_id 第一个值里。 |

`candidate_key` 是源观察内的分段标识：连续权益摘录、资格摘录的规范化定位与权益池标识的哈希；不是 activity ID。分段变化仍可产生新 candidate，最终由 subject resolver 消除业务重复。模型数组序号不能独立充当稳定键。

`body_text` 第一版最多128 KiB（UTF-8字节），完整原文超过上限时保存必要上下文并置 body_complete=0；不得从截断文本推导“旧条款不在原文”。内容哈希针对实际收到的完整正文计算，传输方原文与模型输出分离。正常原文可保留30天；参与人工决定的原语言摘录、上下文、哈希和来源定位长期保留。清理任务默认关闭，不能清理仍被未决任务引用的正文。证据缺失后必须退回不确定，不能仅凭 hash 宣称事实成立。

`offers` 增加可空 `subject_id` FK，并对非空值建 UNIQUE；第二阶段先对全部历史 offers 做一对一主体回填，不合并。旧 offer ID 不变。无法安全迁移的异常记录单独列出，未完成一对一覆盖的平台不能启用 enforce。

### 3.2 别名、版本、决定与任务

| 表 | 必需列与约束 |
|---|---|
| `subject_aliases` | `id` PK；`subject_id` FK；`platform_id`；`kind` legacy_offer_id/official_program_id/official_program_url/model_key/phrase；`value`、`value_hash`、`scope_hash`；`authority` human/verified_rule/model；`state` proposed/confirmed/revoked；`decision_id` 可空；UNIQUE(subject_id,kind,value_hash,scope_hash)。对 confirmed 且 kind 为前三类建部分唯一索引(platform_id,kind,value_hash,scope_hash)。官方URL只有明确单独活动及范围时才是强别名，pricing/FAQ不能整页独占。model_key/phrase 永远不是单独的硬判依据。 |
| `offer_terms_versions` | `id` PK；`subject_id` FK；`base_content_revision` INTEGER；`facts_schema`、`facts_hash`、`facts_json`；`offer_projection_json`（当时完整业务字段）；`evidence_refs_json`；`created_at`；UNIQUE(subject_id,base_content_revision,facts_schema,facts_hash)。内容不可变，批准/拒绝保存在 decisions，当前批准版本由主体指针表示。 |
| `review_decisions` | `id` PK；`subject_id` 可空 FK；`case_id` 可空；`terms_id` 可空 FK；`action` approve/reject/link/separate/reopen/merge/unmerge；`scope` terms/program_policy/case；`predicate_json`；`reason_code`、`reason`；`rule_version`；`evidence_refs_json`；`reopen_policy_json`；`supersedes_id` 可空 FK；`actor`、`actor_role`；`command_key` UNIQUE；`request_hash`；`created_at`。至少有subject/case之一；terms scope必须有terms_id。不可覆盖/删除旧决定。 |
| `review_cases` | `id` PK；`group_key`；`kind` initial/identity/terms/evidence/reopen；`subject_id` 可空；`base_content_revision` 可空；`state` open/resolved；`revision` INTEGER DEFAULT 1；`resolution_decision_id` 可空；`created_at`、`updated_at`。部分UNIQUE(group_key) WHERE state='open'。 |
| `review_case_candidates` | `case_id` FK、`candidate_id` FK，联合PK；同一 case 可以保留互相冲突的候选，不后到覆盖先到。 |

同一主体、同一公开基线只允许一个 open terms case：group_key=`terms:<subjectId>:<baseContentRevision>`。不同提取输出汇入该case，`offer_proposals`保存当前人工编辑投影。原来的疑似身份 group_key由排序后的候选主体集合和保守blocking key构成；集合变化时优先查旧case并附加候选，不自动新建多个同簇审批。没有共同可信特征时不能为了减少任务数强制并簇。

facts_hash 是条款的检索键，不是永久活动身份；未知值可有确定序列化形式，但“两份未知得到相同hash”不构成同版证明。A→B→A的政策回归由不同base_content_revision区分；是否再次审核还要检查有效决定与新的官方依据。

新增 `resolution_attempts`：id、candidate_id、resolver_version、input_hash、catalog_epoch、matched_subject_ids_json、outcome、reason_codes_json、field_comparison_json、evidence_refs_json、model_usage_json、created_at，UNIQUE(candidate_id,resolver_version,input_hash,catalog_epoch)。模型提示及网页中的指令均是非可信数据，不得影响工具权限。

新增 `identity_partitions`：platform_id PK、epoch INTEGER DEFAULT 0；新增 `identity_commands`：command_key PK、request_hash、candidate_id、result_json可空、created_at。epoch是并发提交的CAS版本，不是按时间猜的锁。每次相关主体/别名/决定/合并变动在同一事务内推进epoch。

### 3.3 历史拒绝的兼容

历史 reviews、offer_revisions、rejected_offer_updates、leads.resolution 全部保留。通过带版本的导入器建立 review_decisions，并记录 legacy table/row ID 于predicate或证据元数据，防止重复导入。

旧reason无法明确范围时只导入精确版本或原线索case拒绝，**不推导program_policy黑名单**。旧 rejected offer仍有subject；没有offer的已拒线索先建立保守unclassified subject/case，保存原拒绝理由，只有身份确认后才扩大关联。没有证据的历史标签不能自动变成强别名。

## 4. 结构化事实与证据合同

在 `src/shared/identity/facts.ts` 定义 `Fact<T>`：`{state:'known',value:T,evidenceRefs:string[]}`、`{state:'unknown'}`、`{state:'conflict',alternatives:...,evidenceRefs:string[]}` 的判别联合类型。不得用空字符串、0、none代表未知；真正0金额必须保留。

`BenefitFactsV1` 必须包含：实际platformId；mechanism（signup_grant/recurring_quota/model_free_access/membership_gift/referral_grant/extra_reset/application_grant/discount/paid_bundle/other）；programAnchor、roundAnchor；权益池数组；适用对象与资格逻辑；地区/渠道；领取窗口；获赠额度有效期；modelScope；有效证据状态。

权益池每项包含：poolKey或unknown、amount（十进制字符串或上下限）、unit（usd/cny/eur/credits/tokens/requests/images/video_seconds/membership_months/other）、currency可空、recurrence（one_time/daily/weekly/monthly/rolling/unknown，rolling另给时长及单位）、消费/模型范围、是否共享。积分必须带发行产品和池范围，不能跨平台换算成同一种货币。

资格使用可表达AND/OR的结构，而不是把“学生或教师”误写成“两者都要”。保留 rawText 及证据指针；消费触发、设备代际、账户新旧、企业/教育条件是事实，不是标题修饰语。

规范化规则：

- Unicode NFKC、空白和已确认品牌/模型别名统一；展示标题仍保持原有编辑文案。
- `$10`、`10 USD`、`10美元`在确认美元语境后统一；歧义`$`不得自动猜币种。
- `6万`、`60,000`、`60k`可数值统一；M/m只在原文明确数量单位时解析，不能把month当million。
- 单位、周期和池是金额的组成部分：100/day不等于100/month，100 credits不等于100 tokens，通用池不等于专属池。
- 日期保留精度和时区；月份、未知日不得补造日精度。领取截止与到账后的有效期分别比较。
- 模型数组只在明确“完整列举”时按完整集合比较；部分列举缺少一项不直接证明官方取消该模型。
- 事实hash序列化按字段名/集合排序；包含schema版本，排除语言、标题、发现日期、抓取hash、模型key、格式标点、估值和管理员备注。
- 每项known事实必须追溯到同一目标权益的连续原文或明确人工裁决；文档导航、登录墙、转售商宣传和旁边另一个产品不算证据。

继承 `officialTier`、`officialActivityMismatch`、`lead-scope.ts` 的保护。新系统不得回退main刚修好的Mistral误关联、第三方权益错归和重置变套餐问题。现有 `sameEvidenceBenefit` 可以当候选证据，但不能因为通用免责声明共享就覆盖两项有明确冲突的权益。

## 5. 第二阶段处理算法

### 5.1 入口与请求幂等

先记录观察和候选，后执行身份解析，再决定是否创建offer/case。重复请求的`commandKey`相同且requestHash相同，返回首次结果；同key不同请求返回409。正文只变语言/格式可产生新观察，但不能据此产生新活动。

URL规范化统一由一个模块提供：保留实际身份参数与显著fragment（SPA内容），去掉已知追踪参数；X/twitter同帖以已验证post ID及作者归一。禁止删除所有query、通配整个域名或把`/pricing`设为活动唯一键。重定向仍校验来源归属。含访问令牌/用户凭据的URL不得写日志/公开字段；无法安全清理且保持语义的URL仅保存不可逆内部键并要求安全证据入口。

同一文档内容无变化且所有candidate已终结时，只更新lastSeen/seenCount，不调用模型、不改审核版本。正文变了但不含目标权益变化时可复核观察，不重开业务审核。

### 5.2 历史候选召回

检索范围必须包含：approved、pending、rejected、结束/撤回历史，以及没有offer的拒绝主体。先按实际产品及强别名查，再按机制/权益池/模型/资格/时间召回，并辅以多语言规范化词和FTS5。

默认最多20个主体候选送入比较；精确强别名候选不因排名被截掉。返回`complete`及`truncated`，检索失败或截断后无法排除重要候选时，不允许认定“全新”活动。应保存候选、技术重试或身份case，不能重新走不带历史的旧入口。

不得逐候选扫描全offers/reviews，不给模型整库提示词。索引查询、分页和绑定参数上限由集成测试覆盖。中文FTS先做受控词/相邻字分词字段，不能假设默认英文分词器能解决中文或跨语言语义。FTS/向量只是召回，不能直接返回硬合并。

### 5.3 先判主体关系，再判条款关系

主体关系：`same_subject | different_subject | unresolved`。

- 强依据：已批准人工别名/合并映射、经过来源验证的官方活动ID、明确新公告指向旧活动并宣称更新、同一发放对象与足够独立具体的原文锚点。
- 同标题、同金额、同URL、同公司、同模型或sameAs单独都不够。
- 资格、地域、产品、独立池、机制、设备代际或独立轮次有明确证据冲突时，禁止通用相似度分支绕过。若新公告明确是旧计划改资格，则是同主体的新条款，而不是简单按冲突新建。
- 新旧日期不同可能是转述时间，不是新轮次；同日也可能有两次发放。无法辨认轮次则进入identity case。
- 不采用传递式模糊合并：A像B、B像C不能推导A=B=C；每个成员必须与拟定主记录逐对核对。

条款关系：`same_terms | changed_terms | insufficient_evidence`。

- SAME：关键事实已确认一致，新增来源/翻译/摘录/展示变化归入证据，不新建任务。
- CHANGED：同主体的金额、单位、周期、池范围、资格、期限、有效期、渠道等有可信实质替换。新原文和旧基线关联明确。跨页面变化不是默认false，也不能自动批准；进入同主体的单一terms case。
- INSUFFICIENT：不完整摘录、旧句缺失、未知字段、冲突来源、动态页面渲染不全，保留基线；技术故障走健康/重试。有具体新政策依据但无法裁定才生成唯一evidence/identity case。

纯模型抽取差异不能产生CHANGED。新材料只是填补同一事实的未知字段时，标注`evidence_enrichment`；是否重开由拒绝范围/已有任务决定，不当新活动。

### 5.4 模型比较的受控使用

仅比较召回的有限候选，输出上述主体关系、条款关系、逐字段依据、引用及反例；服务端校验枚举、candidate/subject ID和quote存在性。模型不能自选不存在的subject，不能输出可执行SQL或写权限。

默认每个候选最多一次比较调用、送模型最多8个最相关主体、超时30秒；其余候选由规则预筛或进入case，不因模型上下文限制当作不存在。复用既有modelBudget预留/结算，不能提高现有预算或绕过免费/付费限制。初期模型判同但没有强来源锚点只给审核建议；人工确认一次后持久化有scope的别名。

缓存键至少包含candidate事实/证据hash、参与比较主体的content/identity revision、规则版本及resolver版本。旧决策或基线改变要失效。数据库/模型/预算失败返回retry，不能推测成功。完整源正文与恶意指令作为数据隔离处理。

### 5.5 并发提交与数据库约束

解析可以在事务外做，但提交必须携带候选revision、主体revision及产品partition epoch。采用短D1 batch：先通过CAS占用本命令并推进epoch；后续subject/alias/version/decision/case/link写入只依赖本次成功命令标记。若epoch已变化，整条身份结论作废并重新检索，不能复用旧的“没有重复”结果。

所有会影响身份的入口（包括管理员合并/分离/改产品、别名、拒绝决定）都推进相应epoch。同产品两个不同ID请求在同一旧epoch下判断新活动时，只允许一个提交；另一个重检后关联。跨产品人工更正按排序后的两个partition校验，不建立全库长锁。

原子唯一键兜底包括request key、源观察键、candidate键、确认强别名键、单一open case键、offer.subject_id。语义身份不能只靠facts_hash UNIQUE。

D1 batch中0行不是SQL异常：保存记忆0行必须让后续audit/delete同样0行并返回409；真正SQL错误必须整个batch回滚。所有命令读回唯一commandKey确认结果；响应超时先查命令结果，不能换key盲目再写。不要用未经验证的通用ORM transaction假设代替D1 batch。

## 6. API与所有入口的兼容改造

新逻辑放在共享领域模块和Worker服务，不复制到各调用方。最少提供以下内部接口；全部使用现有Bearer角色体系。

| 接口 | 合同 |
|---|---|
| `POST /api/ingest/observations` | 接收可信采集原文/元数据与候选，逐项返回observationId、candidateId；最多50候选/请求，超限显式400，不静默截断。 |
| `POST /api/ingest/identity/resolve` | body含commandKey、candidateId、expectedCandidateRevision；返回下面的判别结果；无法完成持久化不返回resolved。 |
| `GET /api/ingest/identity/commands/:key` | 读回命令结果，未找到404；调用者不能借查询获得管理私密字段。 |
| `GET /api/admin/identity/cases` | 游标分页，默认50、上限100；按待办优先级，展示历史批准/拒绝、范围与反例。 |
| `POST /api/admin/identity/cases/:id/resolve` | expectedCaseRevision、decisionCommandKey、action link/separate/close、目标主体、理由及证据；版本竞争409；身份关联不等于批准羊毛。 |
| `POST /api/admin/subjects/:id/reopen` | expectedIdentityRevision、目标拒绝decisionId、明确重开理由/新证据、commandKey；仅创建唯一重审case，不自动批准。 |
| `GET /api/admin/identity/metrics` | 返回分类计数与积压，禁止用0掩盖读取失败。 |

统一结果 `ResolutionResult` 公共字段：`inputId, observationId, candidateId, commandKey, resolverVersion`。outcome与必需字段：

| outcome | 必需附加字段 | 是否重试同一候选 |
|---|---|---|
| duplicate_approved | subjectId、canonicalOfferId、termsId、decisionId | 否 |
| duplicate_pending | subjectId、canonicalOfferId、caseId | 否，等待原case |
| suppressed_rejected | subjectId、decisionId；canonicalOfferId可空 | 否 |
| new_pending | subjectId、canonicalOfferId、caseId | 否，等待首次审核 |
| terms_update_pending | subjectId、canonicalOfferId、termsId、caseId | 否，等待原变更case |
| identity_review | caseId，relatedSubjectIds | 否，不重复创建任务 |
| deferred | reasonCode、retryAfter、retryToken | 是，仅此候选 |
| invalid | reasonCode、可诊断字段 | 自动终止重试，保留来源并转有依据的技术/人工处理，不标业务拒绝 |

error与resolved互斥。匹配已拒无offer主体时，不能伪造canonicalOfferId。旧 `/ingest/offers` 保留兼容适配层，将sameAs当候选并委托resolver；不能成为绕过入口。暂时保留id/duplicateId字段供旧客户端读取，但由服务端result生成，不由调用方重猜。

必须接入：`pipeline/run.ts`初抽及官方页采集、`pipeline/lead-review.ts`、`pipeline/official-review.ts`、Worker `/offers`及官方复核result、管理员approve/edit/manual/unpublish/reject/resolve、仓库审核CLI。审批前再检查最新身份revision和条款版本；旧卡409，不能静默批准映射后的另一个活动。

一条lead的候选结果全部持久化后计算状态：全部成功关联/抑制/已建唯一case则结束初抽；有deferred只重试这些candidate；有未知平台/未完成分段保持可诊断状态。`lead_candidates`是清单，旧`leads.offer_id`仅兼容首个可见offer，不能作为完成条件。整篇文章换顺序或模型少输出一个候选，不得删除既有候选账本。

`/manual`默认补充观察/关联，不把已linked/rejected重置new。用户明确重开须走reopen接口并带理由；管理员贴回同一链接本身不是重开指令。旧CLI需提示已关联/已拒及显式重开命令。

## 7. 拒绝范围与重开矩阵

| 拒绝原因 | 默认作用范围 | 不应重开 | 可触发重开/新任务 |
|---|---|---|---|
| duplicate | 对应候选到主subject的link，不建立平台拒绝规则 | 新URL/新语言/新ID | 有具体证据证明其实是独立机制/轮次，走separate |
| paid_bundle / 普通折扣 | 已确认产品+套餐/机制的program_policy谓词；仅管理员明确确认可用 | 把套餐“内含”改写成“赠送” | 新的独立赠额/身份例外有官方依据；不自动沿用旧拒绝 |
| insufficient_evidence | 当前terms/case的证据不足 | 同一转述换表达、再抓同证据 | 新的可采信原厂材料确实补足缺口，创建一个reopen case |
| vague | 当前事实不明确的terms/case | 模型编造数字 | 官方给出可量化额度，或人工确认实际权益 |
| expired | 原轮次/具体版本，不是全计划 | 转发过期公告 | 新轮次有独立依据；旧活动属实但需要历史收录则人工批准历史 |
| wrong_platform | 原候选归属错误 | 对错误归属继续提案 | 确认实际发放产品后重新关联，不封禁正确平台 |
| not_ai / other | 精确case或版本；无法明确不扩大 | 同材料反复出现 | 实质事实变更或管理员明确重开 |

适用拒绝前必须同时满足主体确认、谓词范围匹配及对应条款/证据条件；只命中相似标题不得抑制。policy版本改变只使有关决定待重新评估，不能自动恢复批准。人工裁决保存reason、scope、evidence和reopenPolicy；程序不能因缺reason默认“永久”。

`rejected_offer_updates`继续兼容读；导入到review_decisions后按版本、事实和拒绝原因判断，不再要求新URL与旧URL完全相同。真实新证据与新的官方条款不同概念：前者可解除证据不足，后者才是权益版本变化。

## 8. 审核、通知与公开展示

后台case卡应展示：主活动；历史决定与拒绝原因；相同/不同字段；来源列表；本次新增事实；建议及证据。动作：关联已有、确认独立、继续补证、明确重开。不能把模型“建议通过”变成批准状态。

每个审核通知的稳定事件键基于`caseId + materialRevision + channel`，不得用URL、模型ID或每次updatedAt。附加相同来源只增加seenCount，materialRevision不变；新实质事实或人工重开才产生新事件。`new/changed/ending/ended`对外通知按canonical subject及已批准版本去重，保留当前claim/ack/unknown投递机制。

公开offers列表、详情、平台页、RSS、日历、时间线、统计、模型索引、用户收藏入口全部读取canonical映射；每个活动同版只计一次，不因合并重新增加discoveredAt。内部raw/决策/拒绝理由/待办不进入公开字段。

旧 `#offer-ID` 是浏览器fragment，不能靠服务器301处理：前端详情解析需读取canonical映射并replaceState到新ID，且保留返回导航。旧API ID可返回已批准主记录并附`requestedId/canonicalId`；主记录未公开则404，不泄露拒绝事项。旧ID的管理写操作返回409并要求刷新主记录版本，不能自动执行到不同对象。

## 9. 第三阶段：历史整理流程

### 9.1 输入与只读诊断

先完成第二阶段的一对一主体回填及兼容读；再整理历史。分析脚本默认输入本地SQLite副本或脱敏JSON，不自动加载`.prod.secrets`、不使用ym.ts默认生产地址。没有用户授权的生产快照时，只交付工具/夹具和演练结果，不伪造真实清理成效。

生成snapshot manifest：schemaVersion、代码SHA、规则/resolver版本、生成时间、各表记录数、最大ID/版本水位及SHA-256摘要。大库用分页一致性策略；分批读取期间有写入时必须捕获版本边界并重验，不能把不一致导出当同一快照。

扫描三类重复：approved↔approved、approved↔pending/rejected、rejected↔新线索/无offer主体。另列冲突组，不自动放入合并计划。相似图只用于候选，不做连通分量一键合并。

### 9.2 合并计划数据合同

新增 `dedupe_merge_plans`（id、snapshot_hash、plan_hash UNIQUE、status draft/approved/applied/expired/reverted、actor、approved_at、expires_at、payload_json），`dedupe_merge_events`（command_key PK、plan_id、group_id、before_json、after_json、applied_at、reverted_at），`dedupe_backfill_jobs`（id、input_hash、tool_version、cursor_json、counts_json、status）。before/after是审计数据，只给管理员。

每个group包含：memberSubjectIds、每个对象expectedIdentityRevision/contentRevision/offerUpdatedAt/proposalVersion、拟定canonicalSubjectId、配对依据与反例、状态/人工字段冲突、各类引用数、通知状态、选择的公开版本、字段处理策略、回滚快照摘要。

同一plan hash批准后不可变；修改成员/主记录/字段策略生成新plan并重新批准。默认有效期7天，过期或任何前置版本不符返回409，不自动刷新后继续。每批最多20组；单组最多10个主体、引用计数或SQL超预算则拆分为专门方案，不静默截断。

### 9.3 主记录选择及合并门槛

默认优先管理员明确指定的已批准主记录；其次给出“已有有效批准且人工维护完整”的建议；仅以最早ID/抓取时间排序不足以自动选择。实际合并必须经管理员批准具体plan。

以下组禁止直接合并：不同活动轮次/资格/产品/池的已证实冲突；两份互相矛盾的人工条款；无法确认正确公开版本；存在待审人工提案且未给定保留策略；存在pending/unknown送达或在执行的审核任务。先核对/结案，重新生成计划。两个历史approved只代表当时审核过，不证明两个活动相同。

合并决策只确认身份，不批准新条款。字段不得“选非空”自动拼出一个从未被批准的版本，估值更不得相加。不能把rejected胜出者自动改approved，也不能把旧rejected当成全主记录拒绝。

### 9.4 引用处理：逻辑合并，保留原始出处

| 数据 | 处理要求 |
|---|---|
| subject/offer | loser subject置merged并指向active root；保留旧offer行及review_state，不伪造reject；canonical投影保留已批准选定版本 |
| 原始observation/candidate | 保留原始ID/证据/来源；新的读取经映射到root，历史归属可追溯；活动身份更正另记decision |
| leads/lead_candidates | 完整清单保留，查询/后续处理resolve到root；兼容首offerId可受控更新并在before/after记录原值 |
| reviews/offer_revisions | 不改写历史offerId、作者、日期、内容；聚合读取附originalOfferId，禁止重算成新的批准记录 |
| rejected updates/decisions | 保留原terms及scope，通过root解析适用范围；不能把一个副本的所有拒绝无条件复制到整主体 |
| offer_proposals/cases | 不盲目覆盖两份提案；同事实可关重复case并记录关联，冲突保留人工核对；合并前明确唯一编辑目标 |
| notifications/deliveries | 原始receipt/payload不可改写或伪造sent；canonical去重查询联合成员历史。同渠道任何已有new送达即不再发new；unknown/pending阻止自动新发并阻止合并，除非独立人工结案 |
| 旧链接/收藏/索引 | 永久强别名、兼容读取及前端fragment处理；FTS等索引重建后只展示root，原始ID不404或指向无关活动 |
| 统计 | 基于canonical集合重算，原活动日期保留；合并动作不是新增或新上架，历史错误金额不能再次累计 |

新terms通知只来自cutover后实际批准的版本事件，不能拿合并组中最高revision ID当作新变化再推一次。历史送达记录映射必须区分channel/stage/version；保守继承已发送，不伪造本来未发送的收据。

### 9.5 原子应用、重跑和回滚

每组apply带planHash、groupId、commandKey及全部expected revisions。在同一短事务内验证plan批准/未过期/partition epoch、建立本次merge marker、写before快照、更新映射/必要兼容引用、写merge决定和事件。所有后续SQL由本次成功marker约束；发现任一版本冲突则该组0变更，记录冲突并跳过，不能强行继续。

重跑同commandKey返回同结果；进程在任一步失败、网络超时后，先读回dedupe_merge_events。批次部分完成通过checkpoint续跑，只处理未完成组。禁止全库事务或先删后搬。

回滚使用revert plan并校验合并后的当前版本等于after快照。若合并后有人审核、编辑、发送消息或加入新候选，不做盲目恢复；生成冲突报告由管理员决定拆分。可安全回滚时恢复映射和受控引用，保留merge/unmerge两条审计，不删决定、不撤回真实已发消息、不触发重复通知。

关闭语义resolver开关不关闭已有canonical映射。完成历史合并后禁止把Worker直接降级到不认识映射的第一阶段版本，否则重复行会重新公开；提供仍保留兼容读的回滚版本。D1整体恢复可能丢失备份后的其他写入，不可作为默认单组撤销方式。

## 10. 交付测试与验收门槛

测试使用真实领域函数、现有Worker SQLite集成及管线harness；HTTP/模型可替身，身份、状态机与SQL不能靠mock返回预设成功。至少保留现有343个Vitest及8个CLI测试，执行时以当前仓库新增测试为准，不能删除有效测试凑通过。

必须有以下命名用例组（各输入需断言主记录数、case数、决定/提案、公开值、通知事件与重试状态，而不只断言函数返回值）：

| 组 | 必测边界 |
|---|---|
| A 跨表达同版 | 同优惠中英/中法；品牌别名；不同ID；官网/FAQ/社区；追踪参数；数字格式；模型数组重排；同源新摘录；同社交帖不同域名 |
| B 不误合并 | student与biz；个人/团队；国内/国际；不同设备代际；同额不同池；credits/tokens；注册礼/邀请奖；不同模型模式；同日两次独立reset；不同月份独立轮次 |
| C 真实变化 | 同数字daily→monthly；币种/单位变；资格/领取渠道变；额度有效期与活动截止分别变；明确关联的新官方页面；A→B→A；完整和部分模型列表 |
| D 拒绝继承 | 已拒offer换语言；无offer拒绝线索换URL；paid_bundle改写；证据不足获得官方材料；普通折扣后来变独立赠额；other未知原因不得扩大；规则版本更新 |
| E 失败与并发 | 索引失败不能当空；召回截断；模型失败/越权ID/伪造sameAs；同key不同body409；20个并发不同ID同活动只一个主记录；事务0行；SQL失败回滚；写后超时读回；旧epoch重检 |
| F 审核与部分完成 | 一页6项，其中2重复、1失败；重试不重抽已解决项；人工提案不被刷新覆盖；旧卡不能批准新版本；manual补链不重开；显式reopen只产生一个case |
| G 历史应用 | 全dry-run0写；同plan重复运行；快照过期；成员中途编辑；带待审/unknown送达阻止合并；审批/审核引用完整；旧链接/收藏；统计不双计；不发送消息；可逆回滚与回滚冲突 |
| H 安全/性能 | 20k主体、50k观察固定seed夹具；索引查询无全库模型上下文；单SQL≤100绑定；批次中断续跑；源文本截断；提示注入；内部字段不公开；已拒ID不能泄漏 |

建立固定golden语料：至少12个优惠主体各10种同版变体（120条，包含至少中英与一种额外语言），另60条hard negatives/真实变更。期望标注由人工规则审阅，不能由被测模型自生成答案。加入最近Mistral等真实复现夹具时只用仓库已授权/脱敏数据。每个必须合并样例和不得合并样例都明确主record/case预期。

验收：全部确定性用例通过；golden中0误合并、0误拒；同版变体不新增业务审批；所有真实变更保持旧公开版本并产生恰当唯一提案/核对任务。对开放世界不能宣称100%语义识别；无法确认的case需要可解释，而不是漏掉后假装成功。

性能验收记录数据量、SQL次数、D1 rows_read/written、模型次数/tokens/费用及P50/P95；以基线对比，不能虚构生产QPS或账户配额。重复已终结观察要求0模型调用、0新case、0新通知。新的算法不能靠把全部输入标uncertain来“零误合并”。

## 11. 分阶段启用与运维

增加 `IDENTITY_MODE=off|shadow|enforce`，默认off；`IDENTITY_PLATFORM_ALLOWLIST` 默认空；`HISTORICAL_MERGE_APPLY_ENABLED` 默认false，仍不能代替本次授权。输入额度、模型预算与抓取策略不变。

1. 代码/迁移在本地或明确隔离D1上验证；先建立增量表，再上兼容读写代码。第一阶段0016须先部署，旧字段/数据保持可读。
2. 一对一回填主体与精确历史决定，发布前逐平台检查覆盖/异常；只改身份基础，不合并历史、不更改审核结果。
3. shadow只记录模拟resolve结果和指标，不改offers、proposals、leads状态，不发送通知，不扩大模型预算；与旧流程对照。
4. 至少7个实际运行日且100条可评估观察后检查shadow报告；低流量不足就继续采样，不降低验收。技术重放数据和实际观察分开统计。跨日期新轮次反例必须覆盖。
5. 经单独授权对少量平台enforce；只能在所有写入口已接入和回归通过后启用。出现误合并/误抑制立即关新解析，保留已有alias兼容读取，冻结历史apply。
6. 第二阶段稳定后才运行第三阶段dry-run及人工plan审批；production apply另授权并记录恢复点。历史整理全程关闭实际消息发送；恢复发送前读回所有unknown/in-flight及canonical送达映射。

观测指标：observations、resolved_duplicate_approved/pending/rejected、new_subject、terms_update、identity_case、retry_by_reason、false_merge/false_suppression抽检、reopen_by_reason、review_amplification（新业务case/真实新活动或变化，分母未知则null）、重复观察模型调用数、人工case年龄、merge conflicts、alias cycle errors。健康失败不按业务拒绝计数，不把历史导入计作模型准确率改善。

需要运行的检查：`npm ci`、`npm run typecheck`、`npm test`、`npm run build:web`、`git diff --check`；新migration在空库和旧快照分别升级测试，必要时追加真实隔离D1测试。测试通过≠部署成功≠生产验收。

## 12. 模块归属与实施交付

新增领域模块放 `src/shared/identity/`：facts、normalize、compare、outcomes、decision-policy；Worker目录 `src/worker/identity/`：repository、resolver、commands、routes、canonical-read；纯领域函数不能访问网络/数据库。

采集器输出observation/candidate，不再自行决定canonical id；两类复核和人工接口都消费统一ResolutionResult。历史工具放 `scripts/dedupe/`，测试放 `tests/identity/`、`tests/dedupe-history/`。从大index/admin文件提取被本任务涉及的逻辑即可，不进行无关格式化。

第二阶段PR交付：SQL迁移/Drizzle一致、统一领域/API、所有入口适配、后台核对/重开、通知稳定事件、golden夹具及失败/并发测试、shadow开关与运行说明。第三阶段PR交付：只读扫描/manifest、人工合并计划、原子apply与checkpoint、引用/链接兼容、冲突可逆回滚、离线演练报告。两个阶段每一小步须有自己的红绿测试与提交。

同步更新docs/data-contract、operations、相关审核技能及CLI用法时，必须区分“设计”“已实现”“已部署”。不要把本SPEC复制为现役事实，尤其不能声称向量/语义去重已经全面解决。

## 13. 技术参考与未验证事实边界

Cloudflare官方参考（2026-10-10查阅，执行时再核对）：

- D1 batch及session：https://developers.cloudflare.com/d1/worker-api/d1-database/ 。batch内SQL失败回滚，0行结果仍需应用层业务保护；session读取一致性不能替代写入CAS。
- D1 SQLite扩展/FTS5：https://developers.cloudflare.com/d1/sql-api/sql-statements/ 。FTS是召回工具，不提供语义判同保证。
- D1限制：https://developers.cloudflare.com/d1/platform/limits/ 。采用项目现有每条SQL最多100绑定的保守边界，实际账户限制与存储容量发布前核对。

未读取生产数据库；本SPEC不含线上重复数量、清理收益或误判率结论。没有凭据/数据时交付可复现离线工具和未执行清单，不伪造已回填、已合并或已上线。
