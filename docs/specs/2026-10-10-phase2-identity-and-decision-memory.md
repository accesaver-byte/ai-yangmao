# 第二阶段 SPEC：统一活动身份、条款版本与持久审核记忆

状态：实施规格，尚未实现。版本：v1，2026-10-10。

配套：[第三阶段：历史回填与合并](2026-10-10-phase3-history-backfill-and-merge.md)、[Codex 执行入口](../plans/2026-10-10-dedupe-codex-handoff.md)、[第一阶段修复凭证](../phase1-dedupe-fix-2026-10-10.md)。

基线：main `7cea69d95d2c27e2c1ebd7641a94bab2a696901d`，加第一阶段 PR #2。执行者必须重新读取实际分支，保留之后的新修复，不能用本规格覆盖别人的代码。此规格是后续开发要求，不证明当前网站已经具备下述能力。

## 1. 目标与边界

业务目标：同一现实优惠无论被不同页面、语言、模型 ID 或转述发现多少次，只对应一个活动主体；审核针对事实版本，而不是每次发现。已拒事项的决定可被复用；真正改变金额、周期、资格、有效期等政策时仍能提交审核。

交付必须同时满足：

- I01 同一来源重放具有请求幂等性；跨来源重复具有业务身份一致性，两者不能混用。
- I02 同活动同版本已批准：只关联证据，不创建活动、提案或新审核通知。
- I03 同活动同版本已拒绝：关联有效拒绝决定，不回到人工队列。
- I04 同活动同版本待审：补充原任务，不创建第二张卡。
- I05 同活动真实条款改变：保留当前公开版本，只产生一个对应版本的更新任务。
- I06 不同产品、独立机制、发放轮次、模型池或资格优惠不能因为文案/金额相似而静默合并。
- I07 身份或条款不确定必须显式保留，不伪装成相同、不伪装成新活动、不直接上架。
- I08 拒绝、批准、关联、提案和审核任务的状态写入必须可审计、幂等、原子；并发保护不能只在内存中检查。
- I09 抓取、模型、索引服务失败不是拒绝依据；索引不可读不是空索引。
- I10 用户的审核/手工字段、实测身份、历史记录、通知收据不得被模型静默覆盖。

沿用 Cloudflare Worker / D1、TypeScript、Hono、Drizzle、Node 24 和现有采集 Actions。不引入 PostgreSQL、Redis、独立向量数据库或新付费服务作为必需依赖。不重写公开站点，不调整收录政策，不提高模型预算，不自动合并已有活动；存量合并在第三阶段。

## 2. 现有代码必须接入的位置

| 当前文件/入口 | 后续职责 |
|---|---|
| `pipeline/run.ts` 初抽、官网抓取与验证 | 送观察/候选，逐候选消费明确结果，不能自行决定新 ID |
| `pipeline/lead-review.ts` | 复核已有未解决候选，复用决定；保留最新 lead-scope 和来源校验 |
| `pipeline/official-review.ts` | 官方证据发现；不得因同域名就认为是同一活动 |
| `src/worker/index.ts` `/offers`、`/leads`、`/offers-index` | 旧协议适配器，统一调用 identity service |
| `src/worker/admin.ts` 审核、edit、manual、resolve | 决定和状态转换；批准前再次核对身份版本 |
| `src/worker/lead-review.ts`、`official-review.ts` | 任务 claim/result 使用 fencing token 和版本保护 |
| `src/shared/dedupe.ts` | 现有 matcher 作为候选信号/回归基线，不再独立修改业务状态 |
| `src/shared/review-stability.ts` | 同源确定性事实变化能力保留，升级为三态条款比较 |
| `src/db/schema.ts`、`migrations/` | 增量新表/索引；不覆盖0016或之后的迁移 |
| `buildNotice()`、`src/worker/feishu.ts` | 按稳定任务/版本通知，不按线索URL或更新时间重复通知 |
| `web/` 实际后台入口、`scripts/`、审核技能 CLI | 同一后端命令；所有批准入口具有相同身份门槛 |

建议新模块：`src/shared/identity/{types,facts,urls,compare}.ts`（纯函数）；`src/worker/identity/{repository,resolver,decisions,tasks,routes}.ts`（持久化和状态）；`pipeline/identity-review.ts`（受预算控制的模型比较）。不要继续把整个子系统塞进 index.ts/admin.ts。

## 3. 领域定义

### 3.1 活动、来源与版本

- **活动主体 benefit entity**：一个可独立领取的真实活动，或一个持续存在的免费计划。服务端随机生成稳定 UUID。模型 key/sameAs 不是主键，也不是授权。
- **来源观察 observation**：某个 URL 的某个内容快照。一个页面可以描述多个活动；同一活动可以有多个页面。
- **抽取候选 candidate**：从观察中抽出的一个待识别事项；即使最终不属于羊毛，也可保存为拒绝记忆的主体。
- **条款版本 benefit version**：同主体的一组规范化事实。公开文本、翻译和措辞不是身份。
- **审核决定 decision**：对主体/版本/候选的有范围决定，包含理由、依据、规则版本及重开条件。
- **身份任务 identity task**：不确定是否相同的关联问题，与“此优惠该不该通过”的审批任务分开。

母公司不是实际发放产品。沿用 `platformId` 作为已登记产品/发放方标识，后续可另加母公司分组，但不得把 Qoder、Qwen Code、第三方调用 Qwen 的平台视作同一身份。

### 3.2 轮次与政策延续

常驻每日刷新不每日新建活动；一次额外重置发放可以是独立活动。同日两次发放也可能不同，不能以日期唯一化。转载发布时间/抓取时间不等于 claimStart。存在明确官方 campaign ID、领取批次 ID、官方说明的延续/取代关系时，才可确定轮次或同活动更新。

“注册赠金 $10→$20”在政策延续成立时是新版本；“注册赠金$10”和“邀请奖励$10”是不同机制。“学生与企业各送一个月”是并存优惠；“同一已知计划从学生扩大到所有人”可为版本变化。不能简单把资格字段拼进永久活动ID来代替判断。

## 4. 结构化事实合同

在 `types.ts` 定义 `Fact<T> = { state:'known'; value:T; evidenceRefs:string[] } | { state:'unknown'; reason:string }`。缺失与否定不同；只有原文明示没有限制时才写 known 的空约束。`unknown` 不能当成相同或冲突。

`BenefitFactsV1` 必须含 schemaVersion=1、issuerProductId、mechanism、productScope、modelScope、eligibility、channel、region、occurrence、benefit、claimWindow、creditValidity。每个已知事实都能定位私有原文引用；不能用翻译文段冒充原文。

- mechanism：signup_grant / first_use_grant / recurring_quota / referral / extra_reset / temporary_free_access / membership_gift / application_grant / independent_bonus / ordinary_pricing / unquantified_free_plan / unknown。兼容现有 type，但二者不互相推断等价。
- benefit：一个或多个实名额度池，包含 unit、amount/min/max、currency、period、poolKey、适用范围。amount 使用规范十进制字符串；不使用浮点金额作为哈希基础。
- period：one_time / calendar_day / calendar_week / calendar_month / rolling_hours / campaign / unknown；rolling_hours另带hours；日历周期带时区或unknown。自然月和30天不自动等同。
- eligibility：新老用户、学生/教师/企业、套餐/设备代际、身份验证、付费条件等结构化谓词及原文。区分AND/OR；`student AND new`不能排序后变成OR。未知条件不能自动补none。
- claimWindow：起止时间、时区和精度。仅日期不能捏造UTC零点；使用半开区间需明确转换规则，与现有lifecycle一致。
- occurrence：standing / identified_round / unresolved；identified_round需要发放方稳定标识或人工决定，不采用模型猜测的日期后缀。
- modelScope：显式模型集合/全计划额度/unknown；别名规范化必须有已批准映射，不能去掉版本数字。

规范化：NFKC、单位映射和集合排序；$10/10 USD/10美元仅在USD已确认时等价；60,000/6万/60k在同单位时等价。不同平台积分不可兑换比较；tokens与credits不等价；pool不同不可相加；100/day与100/month不同；单向折扣表达不能不经语义确认换算。

`canonicalFacts()`输出稳定键序JSON；factsHash=SHA-256(schemaVersion+canonicalFacts)。哈希排除title、valueText、来源URL、抓取时间、模型ID、证据引用ID，但包含unknown的字段位置（不含自由措辞reason）。相同哈希只代表相同规范化内容，**不是活动身份的证明**；两个全unknown候选不能合并。证据充分性单独计算，不因哈希相同自动升级。

## 5. 持久化模型（增量表）

以下列名为实施合同，额外内部索引可添加但需测试。`*_json`为TEXT且通过Zod校验。所有时间UTC ISO；版本号用INTEGER，不以毫秒时间戳充当唯一fencing token。新表外键启用；禁止生产清表重建。

| 表 | 必需列、约束与索引 |
|---|---|
| `benefit_entities` | id PK；issuer_product_id FK platforms；identity_state provisional/confirmed；canonical_offer_id nullable UNIQUE FK offers；accepted_version_id nullable；merged_into nullable FK本表；revision INTEGER；created_at/updated_at。索引(issuer_product_id,identity_state)。禁止自指/环；accepted_version必须属于本entity或经人工确认的合并成员 |
| `benefit_offer_links` | offer_id PK FK offers；entity_id FK；linked_by；linked_at。保留原始归属，第三阶段通过root解析合并，不重写历史offerID |
| `benefit_versions` | id PK；entity_id FK；schema_version；facts_hash；facts_json；created_at；UNIQUE(entity_id,schema_version,facts_hash)。版本不可原地编辑，修正生成新版本 |
| `source_observations` | id PK；source_id nullable；origin；requested_url；final_url；normalized_url；normalizer_version；content_hash；renderer_version；transport；authority_json；retained_text；truncated BOOLEAN；first_seen_at/last_seen_at；seen_count；UNIQUE(normalized_url,content_hash,renderer_version,normalizer_version)。只在同一安全归一化规则下共享观察，authority每次验证不得被低可信来源抬高 |
| `extraction_candidates` | id PK；observation_id FK；extractor_version；payload_hash；payload_json；facts_json；entity_id nullable；resolution_json；state unresolved/resolved/deferred；attempts；next_attempt_at；lease_token nullable；lease_until nullable；revision；UNIQUE(observation_id,extractor_version,payload_hash)。同页多项权益各一个候选 |
| `version_evidence` | version_id FK；observation_id FK；claim_key；quote；field_paths_json；UNIQUE(version_id,observation_id,claim_key)。原文引用只在内部可读 |
| `identity_anchors` | id PK；namespace；anchor_key；entity_id FK；basis_decision_id nullable；evidence_json；revoked_at nullable。对未撤销(namespace,anchor_key)部分UNIQUE；只有官方稳定活动标识或人工确认别名能硬绑定 |
| `review_decisions` | id PK；idempotency_key UNIQUE；subject_kind entity/version/candidate；subject_id；action approve/reject/link/reopen/distinct/supersede；scope_json；reason_code；reason；policy_version；basis_json；supersedes_id nullable；created_by；created_at。subject存在性在同一事务校验；索引(subject_kind,subject_id,created_at) |
| `review_tasks` | id PK；task_key UNIQUE；kind identity/new_offer/terms_update/evidence_gap；entity_id nullable；candidate_id nullable；target_version_id nullable；state open/claimed/resolved；revision；lease_token/lease_until；resolution_decision_id nullable；created_at/updated_at。重复来源不递增通知revision |
| `identity_pair_decisions` | lower_entity_id；higher_entity_id；relation same/distinct；decision_id FK；input_versions_json；PRIMARY KEY(lower_entity_id,higher_entity_id)。同主体比较不落此表；distinct避免两项独立优惠反复询问 |
| `identity_mutations` | command_key PK；payload_hash；action；status；result_json；created_at。持久命令收据，重放返回原结果；相同key不同payload返回409 |

`review_decisions`是不可删改事件流；当前有效决定通过supersedes关系及明确作用范围求得，不能简单选择“全站最近的10条”。禁止把临时模型建议写为管理员决定。

观察 retained_text 上限200,000 UTF-8字节，保留支持事实的原文和必要上下文；截断时truncated=true，不能据此判定旧条款已从页面消失。已关联决定、版本的观察不可按普通临时缓存自动删除。无引用观察可在90天后由单独保留策略清理；自动清理不是本阶段必做功能。

现有 offers 仍是公开展示投影，proposals仍是待批准变更容器，reviews/revisions继续兼容旧客户端。新决定、旧审核日志和投影变更在同一命令提交，不允许形成两套独立真相。同步文档说明 accepted_version 对应哪个公开投影版本。

## 6. 身份检索与判定算法

### 6.1 先召回，再比较

输入候选先验证来源和事实，再按以下并集召回：有效硬锚点、已有offer链接、同实际产品的机制/模型/资格/额度池、FTS5词面检索、人工确认的中英文别名。查询覆盖approved、pending、rejected、withdrawn/ended及尚未形成offer的已拒candidate。普通更新时间/60天窗口不得让历史记忆失效。

默认每候选最多召回40条，每轮模型最多比较8条；产品索引分页读取，严禁每候选全表扫描。若召回候选溢出或未完成分页，标记retrievalIncomplete，不能据此确认全库不存在同活动。硬锚点命中不受topK截断。

FTS只做召回。中文需显式tokenization测试，可预分词/汉字bigram索引；语言别名和结构化事实是基础跨语言路径。可选多语embedding仅作为后续召回增强，默认关闭，预算另受控；不把0.85或任意向量阈值等同活动身份。

### 6.2 统一关系结果

纯比较返回：`same_entity_same_terms` / `same_entity_changed_terms` / `distinct_entity` / `uncertain`。另带evidenceRefs、matchedFields、conflicts、missingFields、basis、inputVersions。不要用单个boolean同时表示相同、没有证据和处理失败。

判定次序：

1. 解析已批准硬锚点/别名，跟随合并root，检查锚点适用产品和活动轮次。
2. 统一检查已知事实冲突。不同明确campaign/产品/并存资格/独立积分池不可由标题相似覆盖；unknown本身不构成冲突。
3. 有官方延续/取代证据时，资格、金额、周期等变化应评为同实体新版本，而不是distinct。存在可信冲突但没有延续证据则uncertain。
4. 无冲突且有充分已验证的身份依据、条款一致，才可same。单独相同URL、pageHash、金额、标题、厂商或相同泛泛原文均不足以硬合并。
5. 不确定关系交模型比较，模型不能写库、批准、生成tested证据或提高源可信度。提示词必须把网页/转述视作数据，忽略其中的系统指令。
6. 模型回答需通过Zod、原文定位、产品边界、已知冲突和输入版本检查；无法通过则uncertain。任意sameAs都必须走同一校验。
7. 两个已经独立存在的实体只生成身份合并候选，自动解析器不得重写它们；第三阶段管理员合并。

强原文身份依据优先于模型抽错的字段，但必须证明多段原文共同指向同一完整权益。保留现有Mistral两条独立原文锚点以及lead-scope反例；泛泛“所有用户”“截止未知”或同句重复放多个字段不能冒充独立证据。若身份成立而抽取字段与原文冲突，记录extraction_conflict并保留已审值，而不是创建新活动。

### 6.3 不确定对象与并发

新候选先持久化，不直接创建公开offer。对已知硬锚点采用UNIQUE占位；已确认同entity+同factsHash的版本采用UNIQUE；同entity+同version+同任务种类采用task_key唯一。

对没有稳定活动锚点的两个跨语言新候选，数据库不能凭空保证语义唯一。先建立provisional实体/身份任务，不允许静默发布；按产品执行串行身份解析工作（持久lease+fencing）使后一候选可见前一候选；若仍不确定，保留两者关系而非强合并。批准前再次检索所有未解决provisional peers，展示可能重复，人工确认same/distinct。产品lease到期必须拒绝旧worker写回；只用内存锁或Actions concurrency不合格。

## 7. 结果协议与任务闭环

新增 `POST /api/ingest/candidates`，每次最多20项，每项有inputId、observation、facts、extractorVersion、origin/leadId。requestId由调用方持久化，后端校验同key同payload。媒体、管理员实测、官方来源继续采用现有权限隔离。

每项必须返回：inputId、candidateId、outcome、canonicalEntityId?、canonicalOfferId?、versionId?、decisionId?、taskId?、retryable、reasonCode。outcome如下：

| outcome | 业务动作 |
|---|---|
| linked_approved | 同已批准版本，补观察，不新增审核或通知 |
| linked_pending | 关联现有版本的同一审核任务 |
| suppressed_rejected | 命中仍有效拒绝决定，结束该候选 |
| proposed_update | 创建/关联同活动新版本提案，不改变公开值 |
| created_pending | 独立新活动确认后创建首次审批任务，默认不得自动上架 |
| identity_pending | 身份未明，进入唯一身份任务，不作为普通新优惠审批 |
| deferred | 索引/模型/数据库暂不可用，保存重试状态 |
| invalid | 参数或证据合同不合格，可人工修正，不创建有效活动 |

HTTP 200只表示批次被处理；调用方按每项outcome判断。未知outcome是协议错误，不能当成功。响应必须覆盖每个inputId且不得重复；缺项保留未解决状态。不得只比较返回条数或拿第一个offerId代表整条多权益线索成功。

一条lead仅在所有候选都已终结或关联持久任务时退出new；部分失败只重试失败项。增加lead与candidate的关联（可在候选表lead_id索引，多个lead关联同candidate时使用lead_candidate_links复合主键）。兼容lead.offerId仅为展示主链接，不能作为完整完成证明。

`/offers`旧接口过渡期间调用相同service并返回旧字段+新协议；不得保留另一条绕过身份判断的写库路径。`/offers-index`升级为分页、含状态和结构化拒绝依据；旧客户端字段保留，但不再依靠它独自做身份判定。

## 8. 拒绝记忆的作用域与重开

scope_json必须是受控类型，不保存可执行表达式：

- exact_version：仅拒绝当前主体的事实版本，换语言/URL不重开；同主体新政策可产生新任务。
- mechanism_policy：在明确产品/机制/政策版本边界内拒绝，如普通订阅内含额度。后来出现独立赠额是新机制判断，不能被全平台黑名单吞掉。
- evidence_gap：具体缺失证据项；相同转述不重开。新增可信官方证据填补缺口可产生一次复核任务。
- duplicate_link：关联canonical entity；不是对canonical的拒绝，不能传播成“主优惠不收”。
- occurrence_expired：对应已结束轮次；不禁止新的明确独立轮次。

reason_code沿用paid_bundle/not_ai/duplicate/expired/vague/insufficient_evidence等，并记录policy_version。含义不明的历史other不扩大为机制黑名单。

重开需新政策版本/新官方证据/管理员明确命令之一，并且scope允许。自动重开只创建待审任务，不批准、不擦除旧决定。没有真实变化则返回已有决定。普通“补充来源/manual”默认只关联；另设明确 `reopen`命令，要求reason、expectedRevision和幂等key。拒绝/复核失败不能用时间过期自动忘记。

新增 `POST /api/admin/identity-tasks/:id/resolve`，动作link/distinct/new_entity；新增 `POST /api/admin/decisions/:id/reopen`。人工判定结果同样持久化锚点或distinct关系，后续同一歧义不重复询问。管理员可撤销误判，须记录supersedes关系和影响清单。

## 9. 条款比较和人工字段保护

条款比较独立于身份比较。函数 `compareTerms(before,after,evidence): {state:'same'|'changed'|'insufficient'; materialDiff; evidenceRefs}`。

- 页面文字改变但事实相同：same。证据更完整但不改变资格/额度：补证据，不重审。
- 周期、货币、单位、额度池、有效期、资格、领取方式改变：changed，不能只看数字。
- 新官方URL可支持更新，但须验证实际发放方、活动关系和有效时间；同域名不自动通过。
- 新旧政策同时出现在同一页面（旧历史+新生效条款）不以“旧句子仍在”否决新政策，需按适用区间比对。
- 截断、抓取失败、无原文、日期歧义：insufficient，不等同没有变化。
- 社区source不得更新官方核验时间；lastSeen与lastVerified严格区分。
- 现有公开已审版本不被采集覆盖。人工正在编辑的proposal字段保留，新事实冲突单独显示；经批准的新版本需有新决定。
- usdEstimate/usdMax/valuation属于已审核估值，不由身份模型重算。新版权益改变可能使估值失效，应标记需要重新估值，不悄悄沿用为已核实新值。

仅存在一项同entity+version的活跃terms_update任务。对A/B两个并行候选版本不得静默last-write-wins；显示冲突，管理员选择/综合后形成新版本。

## 10. 原子性、并发和失败语义

D1事务使用`DB.batch()`或经当前官方文档核实的等价能力，不假设支持交互式BEGIN跨多次网络调用。batch SQL失败全回滚，但零行匹配不是SQL失败。

所有有副作用命令必须：

1. 在一个guarded mutation中验证expected entity/task/proposal revisions、lease fencing和同key payload。
2. 创建唯一命令收据；后续状态SQL必须依赖本次收据和相同版本，不允许用过去的同类decision触发写入。
3. 版本、锚点、决定、offers/proposals投影、旧review日志、task状态一致提交。通知只写持久outbox/任务标识，不能在事务内发消息。
4. guard失败全部no-op并409；真实SQL错误整批回滚；结果不明时查command key，不盲重放成新请求。
5. 对理论上不应发生的部分影响行数不一致，使用同批最终约束断言使事务回滚；不能提交后才发现错了一半。
6. 锚点唯一冲突回读赢家，并重新判定其scope/version；不能简单吞冲突回成功。

测试必须在真实SQL执行上验证，不仅mock batch返回成功。SQLite harness需要实现事务回滚/绑定参数上限；再在隔离D1执行迁移和代表用例。不要在生产测试。

## 11. 后台、通知与可观察性

后台卡片必须展示主活动、现有决定、重复来源数量、与公开版本的事实diff、来源依据和“不确定”的具体原因。提供“同活动”“不同活动”“关联已拒决定”“补证”“明确重开”，不能要求管理员手输未经验证的任意ID。

稳定通知key：`task:{taskId}:opened:{generation}`。新URL、lastSeen、文案翻译、任务领取/重试、自动核验时间变化不能递增generation。只有明确的新版本或获准重开才创建新generation。继续尊重deliveries的pending/unknown，结果未知时不自动重发。

内部任务、拒绝理由、raw evidence、模型比较过程不得出现在公开offers/platforms/RSS/图表字段。所有新管理接口复用认证与角色白名单；ingest token无权approve/reopen/merge或写tested。

运行统计新增observationsReceived、candidatesResolved、duplicatesApproved、duplicatesPending、duplicatesRejected、newEntities、proposedUpdates、identityUncertain、retrievalFailures、falseMergeReports、reopenedWithEvidence。以实际outcome计数，skipped不得计入新羊毛。日志只记录必要ID/原因码，禁止令牌和原文中的用户秘密。

## 12. 性能、故障与上线模式

模式：`IDENTITY_MODE=off|shadow|enforce`，默认off。另有`IDENTITY_ENFORCE_PRODUCTS`产品allowlist。

- off：原第一阶段逻辑，不访问未部署的新表。
- shadow：记录新解析结果和建议，不改变旧offers/proposals/人工任务/通知；旧链路仍运行。shadow不能声称阻止生产重复。
- enforce：名单内所有写入与批准走新resolver；索引不可用时保存candidate为deferred，不能回退为直接建offer。

不要每候选全表扫描或把全部历史塞进prompt。每条SQL最多100绑定参数；项目额外采用每个普通ingest HTTP最多40条DB语句的初始预算（包含batch内语句），超过则持久化分批，不通过扩大批次越界。单次候选20项是接收上限，不是要求单请求同步完成全部模型和事务。模型比较在pipeline job异步完成，不占Worker请求长连接；词面/事实确定命中不再调用模型。

新模型调用进入现有modelBudget预留/结算，默认预算不变。索引失败可重试，默认指数退避至24小时；重试次数不触发永久reject。任务租约10分钟、fencing token每次递增；预算耗尽释放/延后任务，不丢候选。

FTS是可重建派生索引。索引写入失败不得丢审核历史；实体revision/策略版本更新使比较缓存失效。缓存key至少含candidate facts hash、existing version/revision、policy version、resolver version、证据版本。

## 13. 验收测试矩阵

新建fixture集 `tests/fixtures/identity-v1.json`，至少60对（20重复、20独立、20变化/不确定），另建不参与调参的至少30对holdout。fixture必须有人工expected relation与依据；线上匿名化样本导入需许可。下列是强制案例：

| ID | 输入 | 预期 |
|---|---|---|
| P2-01 | 同观察同requestId重试20次 | 一观察/一收据，返回同结果 |
| P2-02 | 同key不同payload | 409，无新状态 |
| P2-03 | 中英/改写/不同URL的同一已批准优惠 | 一主体，无新审核/通知 |
| P2-04 | 同上但原优惠已拒 | suppressed_rejected，有decisionId |
| P2-05 | 只在leads拒过、从未有offer，跨URL转述 | 关联candidate拒绝主体，不重新排队 |
| P2-06 | 同页注册礼和邀请奖 | 两独立实体 |
| P2-07 | 同名学生优惠和企业优惠 | 不静默合并 |
| P2-08 | 同公司两个产品/第三方领取 | 不混平台 |
| P2-09 | 100/day→100/month，同数字 | 新版本提案，公开旧值不变 |
| P2-10 | 新官方URL延长同一活动 | 有延续证据则新版本，否则uncertain |
| P2-11 | 改写但政策未变/一段原文重复多个字段 | 不借此确认新身份或新版本 |
| P2-12 | 同日两次独立reset；预告/确认同次reset | 前者分开，后者关联 |
| P2-13 | 旧证据不足拒绝，新可信官方证据 | 一次允许的补证复核，无自动批准 |
| P2-14 | 被拒付费套餐后来新增独立免费赠额 | 不被宽泛拒绝误杀 |
| P2-15 | 已结束轮次/新轮次；常驻每天刷新 | 新轮次分开、常驻不每日新建 |
| P2-16 | 60k/6万、USD/积分、自然月/30天 | 仅真实等价归一化 |
| P2-17 | 两来源并发不同随机ID | 硬锚点同主体；无锚点只待身份，不能双上架 |
| P2-18 | 过期任务回写、管理员同时编辑/拒绝 | 409或既定幂等结果，无覆盖 |
| P2-19 | 审核日志/投影/任务写入任一步失败 | 全量回滚；零行guard不删除任务 |
| P2-20 | 多候选一重复一失败 | 只重试失败项，已关联项不重抽 |
| P2-21 | 召回服务失败/候选截断/LLM无效JSON | deferred/uncertain，不当成新活动 |
| P2-22 | unknown vs unknown、模型推断资格 | 不自动判同或生成none |
| P2-23 | 模型sameAs指向别平台/旧轮次 | 拒绝关联，保留任务 |
| P2-24 | 普通manual重复提交/明确reopen | 前者不清空决定，后者审计并新generation |
| P2-25 | 状态/角色/公开字段隔离 | ingest不能批准，公开不泄露拒绝记录 |
| P2-26 | Mistral/source-grounded alias和lead-scope全部旧测试 | 保持通过，不以新heuristic回归 |
| P2-27 | 验证元数据更新、来源计数增加 | 不重复通知 |
| P2-28 | 差异化金额池/型号代际/区域 | 不因同数量合并 |
| P2-29 | 截断原文、旧新条款并存 | 不从缺句/有旧句推断没有变化 |
| P2-30 | 10k实体/50k观察性能fixture | SQL绑定上限不超，记录读行数/耗时/模型调用数，无每候选全库读 |

上线目标是fixture/holdout上已标注distinct的静默误合并为0；重复识别召回目标≥95%，单独报告不确定率与人工任务率，不以“全扔uncertain”伪装达标。这是验收目标，不是线上正确率保证。真实模型评估不替代确定性CI，必须记录模型版本和费用。

## 14. 实施切片与交付门槛

- P2-A：事实类型/规范化/比较纯函数＋上述基本fixture。运行旧tests；不改变路由。
- P2-B：新表、索引、SQL事务存储、任务/命令幂等，使用本地迁移测试；补最小one-to-one存量映射（第三阶段§3），不合并。
- P2-C：检索/别名/模型比较适配、版本化缓存与预算；全程shadow；补跨语言及失败测试。
- P2-D：统一所有入口和拒绝范围，候选级闭环；后台身份任务和通知key；包含权限测试。
- P2-E：隔离D1验收、shadow报告、按产品开启enforce；每片独立PR、能回滚、不自动部署。

P2-B所需基础映射是启用enforce前置，不允许先上线全新resolver再把旧库当空。第三阶段候选合并可在第二阶段完成后单独执行。

每片必须提供`npm run typecheck`、完整`npm test`；前端改动加`npm run build:web`，列出失败/跳过/未验证项。schema变更更新Drizzle元数据与迁移台账的实际项目惯例，检查重复DDL，不能仅加schema不写迁移。

## 15. 参考与证据边界

现役业务政策仍以 `docs/data-contract.md`、`pipeline/learned-rules.md`、`pipeline/platform-notes.md` 为准；本SPEC不改变收录资格。冲突时记录具体差异，保持安全默认值，不静默删除现有保护。

实现时再次核对官方能力：
- D1 batch事务及返回值：https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1绑定参数、查询及batch限制：https://developers.cloudflare.com/d1/platform/limits/
- D1支持的FTS5/JSON能力：https://developers.cloudflare.com/d1/sql-api/sql-statements/

这些链接只支持平台能力说明；表结构、上限配置、状态机和验收数字是本项目设计选择。任何生产迁移、开启enforce、审批、历史合并、通知或部署必须有额外明确授权。
