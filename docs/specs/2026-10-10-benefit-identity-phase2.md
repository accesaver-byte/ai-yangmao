# 第二阶段 SPEC：活动身份、条款版本与持久审核记忆

状态：待实施设计；本 PR 只实施第一阶段修复，不代表本文件功能已经存在或上线。
日期：2026-10-10。
基线：main `7cea69d95d2c27e2c1ebd7641a94bab2a696901d`；第一阶段已验证代码 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`，PR #2。
执行入口：[Codex 交接与任务拆分](2026-10-10-codex-handoff.md)。后续：[第三阶段历史整理](2026-10-10-historical-dedupe-phase3.md)。

## 0. 目标、授权与不做什么

目标不是不再抓到旧网页，而是：同一现实优惠可以被反复发现，但同一活动、同一条款版本不重复建活动、不重复审核、不重复发送首次上架通知。拒绝决定必须跨 ID、来源及语言延续；真实新优惠和条款变化不得被误杀。

沿用 Cloudflare Worker/D1、TypeScript、Hono、Drizzle、Node 24、现有采集与测试体系。保留 `offers` 作为公开展示投影，保留 `offer_proposals` 和旧审核/推送记录；不重写全站，不迁移数据库产品，不默认引入向量库或付费模型。

本设计不授权部署、执行远程迁移、运行真实采集、修改生产内容、发送消息、自动批准或自动合并历史活动。Codex 可在独立分支实现、测试并提交 PR；生产操作需要另行明确授权。

第一阶段已经解决：已识别 duplicateId 重新排队、同数字发放周期变化被抹掉、拒绝提案的记忆/日志/删除不原子。它尚未解决通用跨语言身份、直接拒绝的 leads 记忆、全入口一致判重或历史去重。

规则优先级：明确用户业务决定 > `AGENTS.md`、现行 `docs/data-contract.md` 与 `pipeline/learned-rules.md` > 本 SPEC 的默认设计。冲突须记录 ADR 和具体测试，不得悄悄用旧审查报告覆盖新规则。保留 main 已有 Mistral 原文关联与 lead-scope 防错归保护。

## 1. 强制不变量

1. 一个已确认活动身份最多有一个当前公开 offer；一个活动可有多个历史条款版本和无限次来源观察。
2. approved、pending、rejected、过期、撤回活动和未转成 offer 的已拒线索，都参与身份候选检索。过期不是从记忆删除的理由。
3. 抓取 URL、内容 hash、模型 key、中文标题、金额和抓取日期，任何一个都不能单独定义业务身份。
4. 同一 URL 可包含多个优惠；一个优惠可存在于多个 URL。页级缓存不能替代活动级查重。
5. `sameAs`、`sameOccurrenceAs`、固定 ID 和模型置信分只提供线索，不授权跳过服务端身份及权限检查。
6. 业务身份、条款是否变化、是否值得收录，是三个独立判断。识别成同一活动不等于忽略真实条款变化。
7. 未知不等于无条件、全球、全部模型或零额度。遗漏字段不代表官方取消。
8. 社区转述再次出现只更新 lastSeen，不刷新官方 lastVerifiedAt；抓取成功不等于原条款仍然成立。
9. 同数字可以有实质变化，如100积分/日变100积分/月。相同金额不同机制、资格或独立积分池不得自动合并。
10. 模型输出不能覆盖已批准公开版本；新条款先进入一个提案。审核员正在编辑的字段优先保留，冲突显示出来，不静默覆盖。
11. 同一候选已关联已批准、待审或已拒对象，均是处理成功的终态，不作为技术失败重试。
12. 决定、版本、提案状态、候选归属及必要审核日志必须原子提交。零行版本条件不是成功。
13. 公共页面和 API 不泄露拒绝理由、内部观察、模型提示词、reviewMemo、决策原文或未批准版本。
14. 任何无法证明安全的合并保持 uncertain，不自动删除、批准或永久屏蔽。未知匹配不得变成永久黑名单。

## 2. 业务身份与事实模型

### 2.1 四个不同对象

- **Observation**：在某时刻，从某来源读到的材料。记录原语言、可信性、抓取方式和内容版本。
- **Candidate**：从一份材料抽出的一个潜在优惠。保留模型输出、规范化事实、失败原因；一份材料可产生多候选。
- **Benefit entity**：现实中的活动/优惠计划。ID 由服务端生成；也能代表不收录的事项，没有 offer 时 canonicalOfferId 为 null。
- **Benefit version**：该实体某一组条款事实。身份稳定不要求金额、期限或资格永远不变。

无法确认是否独立活动时，创建 provisional entity 作为身份核对容器，不立即创建公开 offer。容器内候选只表示待比较，不能因为在同一容器就认定同一个优惠；允许逐个拆分为独立实体。该机制用于归拢审核，不是自动合并证据。

### 2.2 身份锚点与禁止的推断

强锚点包括：人工确认的现有 ID 关联、发放方明确且命名空间正确的 campaign ID、官方明确说明同一活动的跨页面引用。锚点必须带平台/产品、机制与活动轮次作用范围。同页存在多个优惠时，文档地址必须再加经确认的条款/活动定位，不能整页一对一绑定。

模型 key 只作弱别名。即使沿用旧 key，也要检查已知产品/资格/轮次冲突，避免 key 碰撞覆盖旧活动。已验证 URL 别名指向的是文档而非永不变化的活动条款；后续观察仍需比较版本。

母公司与产品分离：使用实际发放权益产品的 platformId，不因同属一个公司就合并。第三方提供的某模型额度不等于模型厂商自己的优惠。跨 platform 修正需证据或人工确认，不做公司名全局折叠。

### 2.3 规范化事实的最低合同

每个事实使用 `known(value, evidenceRefs)` 或 `unknown(reason)`，不得用空字符串表达未知。集合必须区分 unknown、明确不限和明确枚举。EvidenceRef 指向观察 ID、原文摘录及定位；模型推断和官方明示分别标记。

事实至少包含：

| 字段 | 含义与边界 |
|---|---|
| issuerProduct | 实际发放产品；平台别名需人工/官方依据 |
| mechanism | signup_grant / recurring_quota / referral / trial / free_access / member_extra / reset / identity_perk / application / other |
| product、plan、pool | 产品、套餐、独立积分池；不能只从标题猜 |
| entitlement | 金额或配额组件，可有多个，分别保留池和限制 |
| cadence | once、calendar_day、calendar_week、calendar_month、rolling_window、unknown；滚动窗口保留精确持续时间 |
| eligibility | 新老账户、学生/教师/企业、设备代际、付费档、邀请、地区等条件，可表达 AND/OR，不能把两者混淆 |
| channel、region | App/Web/API/CLI、地区；未知和全球不能相等 |
| modelScope、modalities | 明确覆盖模型/能力，模型名按产品命名空间规范化 |
| claimWindow | start/end/endKind/sourceTz；保留日期精度，未知时间不得补午夜当官方事实 |
| creditValidity | 领取后有效期，与可领取截止日期分开 |
| occurrence | recurring_plan 或 confirmed_event；官方活动/发放锚点，不使用抓取时间当轮次 |
| coverage | complete 或 partial，以及 unresolvedClauses，表示尚未结构化的可能重要条款 |

数量用十进制字符串规范值，禁止浮点误差影响 fingerprint。`60,000`、`6万`、`60k` 在同单位下可归一；`1m` 只有原文明确为数量 million 时才归一，不能把 month 当 million。美元使用明确币种；孤立 `$` 且无法确认币种时保持 unknown。不同币种不因实时汇率等值而合并。

Token、credits、图片次数、会员月份互不等价。不同产品积分池的 credits 也不自动可比。费率、赠金额、上限、首30天估值分离；`usdEstimate` 不作为活动身份或原始赠金的依据。

会员套餐别名、跨语言机制和模型别名采用可版本化映射；未知模型名保留，不使用模糊替换消除代际数字。qualification 冲突必须先于字符串相似度。原文充分证明字段抽错时，可以人工确认同一活动并纠正字段，不能由通用标题分支绕过冲突。

### 2.4 条款 fingerprint

定义 `facts-v1` 的 canonical JSON：对象键排序；真正无序的集合排序、去重；金额使用规范十进制；有序步骤不排序；unknown 显式编码。语义 fingerprint 只包含上述业务事实，不含标题措辞、来源 URL、抓取时间、引用定位、模型供应商和推理文本。

`termsHash = SHA256(factsSchemaVersion + canonicalFactsJson)`。同 hash 只在实体身份已确认、必要事实可比较且无 unresolvedClauses 时才能证明同版本；partial 事实的同 hash 只用于缓存/召回，不授权屏蔽新证据。升级规范化算法必须并存旧版本、重算并回放，不直接按新 hash 全库归并。

### 2.5 三类易错实例

- 官网中文“注册赠10美元”与英文公告“$10 signup credit”：机制、资格、产品与活动锚点相同才属于同实体；币种/资格不明先待核对。
- 每日100积分→每月100积分：同计划的不同条款版本。展示值和可用性不得在批准前改变。
- 学生赠会员与企业赠会员、Pixel不同代际独立赠礼、同日两次额外reset：属于不同候选；不能凭相同标题、金额或日期吞并。常规每月额度自动刷新通常不是每月新建一个活动。

## 3. 增量存储合同

以下是逻辑 schema 的必备字段和约束，不是可直接执行的 migration。所有新表放在 `src/db/schema.ts`；外键类型与现有表一致。迁移编号必须基于实施时最新目录决定，不能盲写0017；保留第一阶段0016的 decision_key 和拒绝记忆。

| 表 | 必备字段与约束 |
|---|---|
| benefit_entities | id TEXT PK；platform_id FK；canonical_offer_id nullable FK UNIQUE；state provisional/canonical/merged；merged_into_id nullable self-FK；revision INTEGER≥1；created_at、updated_at。禁止自指；merged 必须有目标，其余无目标。Phase2不开放merge写接口。 |
| entity_offer_links | offer_id PK/FK；entity_id FK；created_at。用于旧ID路由；首次回填一条旧offer一个实体，不直接合并。 |
| source_observations | id PK；observation_key UNIQUE；source_id nullable；document_key；requested_url、final_url、language、content_hash、trust、capture_method、source_verified、excerpts_json；可选脱敏source_text；first_seen_at、last_seen_at、seen_count。 |
| extraction_candidates | id PK；extraction_key UNIQUE；observation_id FK；extractor_version；slot_key；raw_candidate_json；facts_json；facts_schema_version；entity_id nullable FK；task_id nullable FK；state received/resolving/resolved/deferred/needs_identity；outcome_json；attempt_token、lease_until、next_attempt_at、error_code。 |
| lead_candidate_links | lead_id FK + candidate_id FK 复合PK；每个候选结果独立，不再只以lead.offerId判断整条成功。 |
| identity_aliases | id PK；namespace、alias_kind、alias_key；entity_id FK；strength verified/weak；evidence_refs_json；created_by；active；UNIQUE(namespace,alias_kind,alias_key) WHERE active=1 AND strength='verified'。弱别名可碰撞，绝不能直接覆盖。 |
| benefit_versions | id PK；entity_id FK；version_no；terms_hash；facts_schema_version；facts_json；created_at；UNIQUE(entity_id,version_no)、UNIQUE(entity_id,facts_schema_version,terms_hash)。事实不可原位修改。partial变complete产生新版本/补证记录，由差异分类决定是否需审核。 |
| version_observations | version_id FK + observation_id FK + relation supports/contradicts 复合PK；同版本可以有多个语言、多个来源。 |
| review_decisions | id PK；entity_id FK；version_id nullable FK；related_entity_id nullable FK；action approve/reject/link/not_same/reopen/supersede；reason_code；reason；scope_json；reopen_policy_json；policy_version；actor；supersedes_id nullable FK；at。决定追加保存，历史不删除。 |
| review_tasks | id PK；entity_id FK；kind identity/initial/terms/reopen；dedupe_key；state open/checking/resolved；revision≥1；candidate_version_id nullable FK；base_approved_version_id nullable FK；proposal_offer_id nullable FK；decision_id nullable FK；UNIQUE(dedupe_key) WHERE state IN ('open','checking')。 |
| identity_scopes | scope_key PK（第一版按platformId）；revision≥1；maintenance BOOLEAN。身份注册/关联/决策变更原子递增revision，lastSeen不递增。 |
| mutation_receipts | operation_key PK；attempt_token；command_hash；response_json；at；guard_ok INTEGER NOT NULL DEFAULT 1 CHECK(guard_ok=1)。用于幂等提交及批内最终不变量断言，见第7节。 |

必要索引：entities(platform_id,state)；entities(merged_into_id)；links(entity_id)；observations(document_key,content_hash)；candidates(state,next_attempt_at)、candidates(entity_id)；aliases(namespace,alias_key)；versions(entity_id,terms_hash)；decisions(entity_id,at)、decisions(related_entity_id,action)；tasks(entity_id,state,kind)；lead links(candidate_id)。查询必须分页，不能每个候选 select 全站 offers。

Observation key 为来源文档规范标识、内容 hash、抓取可信类别的组合，不包含抓取时刻。同文档同版本重抓采用UPSERT更新计数；重试同请求不重复累计的精确统计可使用请求operation_key。用户主动提供的新证据不能仅因文本摘要相同丢弃。

Extraction key 为 observationId + extractorVersion + 稳定slotKey。slotKey 来源于原文块/段落锚点及候选机制，不是数组序号或模型自由命名。没有可靠锚点时允许候选重复保存，但必须走业务身份解析；不得以不稳定slot产生“已去重”的保证。重新抽取升级版本不抹掉旧输出和旧决定。

source_text沿用最大250000字符入口限制且检查UTF-8字节预算；超限保存必要证据与截断标记，不声称读全。包含敏感令牌的URL须脱敏/拒收；不能一概删掉content ID或真实优惠代码。raw/内部证据只在认证接口可见，不提交生产数据库快照到仓库。

## 4. 统一身份解析器

新增模块，不把整个系统继续塞进 `src/worker/index.ts`：

- `src/shared/identity/facts.ts`：事实schema、canonicalization、三态比较。
- `src/shared/identity/contracts.ts`：输入、结果、决定与scope的Zod/type合同。
- `src/shared/identity/normalization.ts`：URL、已知平台/产品/模型/机制映射。
- `src/worker/identity/repository.ts`：有索引的候选读取、receipt、CAS和批事务。
- `src/worker/identity/resolver.ts`：召回结果和证据关系的决策，不自行批准。
- `src/worker/identity/routes.ts`：认证API、人工身份核对和显式reopen。
- `pipeline/identity.ts`：必要时语义判断与受预算控制的模型调用，禁止直接改审核状态。

接口约定：

```ts
type IdentityRelation = 'same_version' | 'changed_terms' | 'different_entity' | 'uncertain';
type IntakeOutcome = 'created_pending' | 'linked_approved' | 'linked_pending'
  | 'suppressed_rejected' | 'proposed_update' | 'evidence_attached'
  | 'needs_identity' | 'deferred' | 'invalid';

interface IntakeReceipt {
  inputId: string;
  candidateId: string;
  entityId: string | null;
  canonicalOfferId: string | null;
  versionId: string | null;
  decisionId: string | null;
  taskId: string | null;
  outcome: IntakeOutcome;
  retryable: boolean;
  reasonCode: string;
}
// 用Zod验证以上合同；retryable不得从英文message字符串推断。
```

`normalizeFacts(candidate, evidence) -> NormalizedFacts`；`compareFacts(a,b) -> { relation: 'same'|'changed'|'insufficient', changes, conflicts, unknowns }`；`resolveIdentity(candidate, retrieved, context) -> { relation, entityId?, rationaleCode, evidenceRefs, conflicts, comparedRevisions }`。`resolveIdentity` 不做网络调用或写入；持久化由 `commitResolution(command)` 执行。

### 4.1 召回顺序

1. 已验证别名/活动锚点查主记录；始终复核scope和版本。
2. 同实际平台/产品的结构化机制、资格、池、模型和活动轮次索引。
3. 标题/全文辅助召回。D1支持FTS5；中文使用应用侧字词切分/字符n-gram，英文词面不足以跨语言，跨语言优先靠受控机制和事实字段。
4. 可选多语向量召回，只补候选，不作为批准、合并或拒绝依据。首版不要求购买向量服务。

每次召回最多50个实体，送模型比较最多10个；数字是实现预算默认值，不是有效性保证。超过限额、候选并列、索引失败必须返回uncertain/deferred及truncated标记，不能把“没查完”当“没有重复”。召回包括所有审核状态以及无offer的拒绝实体。不存在静默 `catch { return [] }`。

### 4.2 决策顺序

先检查产品、资格、机制、模型/积分池、地区、窗口、轮次等有证据的冲突，再利用相似文本。直接证据证明字段抽错时走身份纠正任务，不靠弱分支绕过冲突。

- 强身份一致且事实等价：same_version。
- 强身份一致、官方证据支持实质变化：changed_terms。旧事实仍在页面时需区分“新旧并列套餐”和官方明确替代；不要求简单删除旧句子才认为改变。
- 官方明确独立机制/轮次：different_entity。
- 其他：uncertain。尤其是只有模型sameAs、相似度高、或仅来源域名可信但活动关系不明。

两个不同官方页面可以支持同一活动或新版本；跨页关系必须记录证据。不能沿用 `sameEvidencePage=false => unchanged` 的二元结论。跨页新依据不足时建立一个身份/条款核对任务，而非自动更新或永久忽略。

没有候选不证明一定是新活动：检索成功且观察充分支持独立活动，才创建新实体和待审offer；否则进入provisional容器。相同block（平台+明确产品+机制+轮次范围）的未知候选可以在UI同组显示，但保留每个候选，不能共享approve/reject，除非审核员先确认同一实体。

模型仅输出枚举关系、匹配实体ID、变化字段和对应原文引用；验证ID属于检索集合、引用属于可读观察、来源属于发放方。不存或要求模型私有推理。模型置信度不当概率阈值；超时、非法JSON、引用不成立、预算耗尽一律可恢复，不变成“新活动”或“拒绝”。

### 4.3 版本比较与已审核保护

material fields包括额度/货币/单位/周期、资格、领取范围/方式、起止与额度有效期、模型/池和独立轮次。纯标题翻译、排序、标点、追踪URL、抓取时间不是material change。

Unknown→known：若只是补齐支持已批准事实的证据，evidence_attached，不重审；若补出此前未审核的重要领取限制，创建一个补充/变更任务；approved公开版本仍不被模型修改。known→unknown：保留旧事实，标注抓取缺失并重试，不生成删除条款提案。

同一变化从五个来源出现，复用同一entity+termsHash的版本与任务。使用scope/entity revision检查已批准基线是否变化；不以普通核验时间updatedAt作为唯一身份版本。

## 5. 拒绝决定与重新打开

拒绝不是URL黑名单。scope_json必须明确 subjectKind、实体/版本、适用机制/资格/轮次和判断依据。未转成offer的leads也要有实体/候选关系和decision，不能只保存lead.status。

| 理由 | 默认作用范围 | 可以重新打开的条件 |
|---|---|---|
| duplicate | 指向明确主实体；保存link决定，不把整个平台拒绝 | 主实体出现真实新条款/轮次；别名改写不重开 |
| paid_bundle、not_ai、明确普通折扣 | 当前实体及符合拒绝predicate的条款，绑定policyVersion | 独立赠送事实改变或人工确认收录规则变化 |
| insufficient_evidence、vague | 当前证据/版本，不是实体永久封禁 | 新官方材料补足被列明缺口；换一篇转述不够 |
| expired | 该次活动历史状态，仍可关联和展示历史 | 有明确独立新轮次；不要把旧活动日期换成今天 |
| wrong_platform | 错误归属关系 | 正确发放方依据；不能把优惠本身永久拒绝 |
| other | 仅当前候选/版本 | 人工定义重开条件；未定义不得扩大成永久规则 |

legacy reason无法映射时记 `legacy_unclassified`，只对已确认相同实体/版本延续，进入一次性补分类队列，不猜测拒绝范围。政策升级不得自动把所有历史拒绝重新推审；只重评受影响predicate，产生唯一任务。

`not_same` 保存实体对的否定关联，后续不得用同一弱依据再建议合并。新增官方关系证据可生成一次重新评估任务；不删除原否定决定。

人工补充来源和reopen分开：`POST /api/admin/manual` 对已有事项只附观察/返回现状，不清空resolution或改为new。`POST /api/admin/identity/entities/:id/reopen` 必须带reason、expectedRevision、新证据或明确人工override；生成reopen决定与任务，不删除旧拒绝。评审员按现有业务权限可补证/提交判断，跨实体合并、永久规则扩大只给admin。

## 6. 队列、入口与通知合同

### 6.1 所有写入口必须一致

普通官方采集、初抽、lead-review、official-review、人工补录、管理员批准/编辑都必须经过共享身份服务。特别检查现有 `sameId` 分支，不能因ID存在就跳过身份验证。原有jobId、inputVersion、lead-scope、官方归属保护保留，身份服务不能扩大任务权限。

兼容旧 `/api/ingest/offers`，服务端适配旧输入并返回原results字段加 `IntakeReceipt`；新管线按receipt处理。不得仅在某个新版客户端查重，让旧relay继续写重复。保留旧results.id为canonical offer ID（无offer时保持input ID并显式receipt），新客户端不得靠id猜outcome。

新增认证接口：

- `POST /api/ingest/identity/observations`：最多20个观察，Idempotency-Key必填，返回观察ID及已存在标记。
- `POST /api/ingest/identity/resolve`：最多50个candidate引用，逐项返回receipt；慢模型判断异步入deferred任务，由现有pipeline受预算处理。
- `GET /api/admin/identity/tasks?cursor=&limit=`：limit默认30最大100，稳定游标与total。
- `GET /api/admin/identity/entities/:id`：主记录、别名、版本、来源、决定和diff，no-store。
- `POST /api/admin/identity/tasks/:id/resolve`：expectedTaskRevision、expectedEntityRevision、operationKey、action link/new/not_same、目标ID、reason与证据。
- `POST /api/admin/identity/entities/:id/reopen`：显式重开合同见第5节。

批准接口同时验证当前entity、task和proposal版本。即使两条待审草稿同时被批准，也不能产生两个同identity的公开记录；遗留冲突返回409及核对目标，不默默替换另一条。

### 6.2 候选终态与lead聚合

linked_approved、linked_pending、suppressed_rejected、evidence_attached、proposed_update都表示该候选已处理。created_pending不代表已批准。needs_identity/deferred/invalid保留明确原因；invalid字段错误需人工修复，技术重试不能无限循环。

一个lead多候选：逐项持久化链接和receipt；只有全部有终态才能标linked/closed。部分失败只重试未解决项；重复已拒候选可与新独立候选共存，不能因一个拒绝把整页吞掉。原lead.offerId只保留首个兼容引用，完整归属读lead_candidate_links。

新候选、提案和身份任务必须具备稳定dedupe_key。新增一个来源不重置人工任务revision、不重新发送同一身份卡片；material change或明确reopen决定才创建新的审核语义事件。

### 6.3 通知与前端

审核提醒按entity+taskKind+业务版本/decision ID去重；首次上架通知按entity+首次批准事件；条款变更按entity+version；截止提醒还包括适用截止版本。不是按随机offer ID、capturedAt或全文diff JSON去重。

沿用deliveries的pending/unknown防重发送状态，不能把超时当明确失败自动重发。飞书常驻榜的“每天重复榜单”是既有业务功能，保留日期维度，不误当活动重复推送。

UI在同一审核卡片展示原已批准版本、此次实质diff、来源列表、历史决定和“为什么可能是同一活动”。提供明确的“关联已有”“确认为独立”“保持待核对”“补证后重开”，不得把建议按钮做成自动批准。公共API保持现有结构，内部身份日志不透出。

## 7. 原子性、并发与故障恢复

D1 `batch()`提供批事务；不能在Worker多个await之间手写BEGIN/COMMIT假装跨请求事务。零行guard不会自动回滚，所有子写入必须受同一操作令牌约束。

`commitResolution(command)`：

1. 在主库一致视图读取scope revision、实体/任务/提案revision，检索和模型可在事务外进行；提交时重新验证。
2. 操作使用服务端校验的operationKey与commandHash。相同key不同payload返回409；相同key已完成返回原receipt，不再次产生任务或日志。
3. 准备全部新ID和attemptToken；一个batch的首语句按expected revisions及maintenance=false插入mutation_receipts。ON CONFLICT不覆盖；后续语句都要求本次attemptToken存在。
4. 后续语句写版本、观察关联、候选归属、别名、决定、任务/投影和scope/entity revision。新实体注册递增platform scope revision，另一并发请求必须重新召回而非按旧“无匹配”继续插入。
5. 最后检查预期目标行、任务唯一性和决定引用存在；不符合时尝试将本次receipt.guard_ok设为0，触发CHECK错误，使batch整体回滚。不要仅在batch返回后抛错，因为此时写入已提交。
6. 首guard零行且没有同operationKey已完成receipt：返回409，不生成任何子写入；安全重新解析最多2次，仍冲突则deferred。SQL失败/超时读回operationKey再决定重试，不重新生成业务事件。

Verified alias唯一性约束和活动任务partial unique index是最后兜底；语义本身不能由UNIQUE解决。跨URL且无强锚点的新候选不能靠“全局锁” magically 识别相同：它们进入相同block的核对视图，但每个候选仍保留。

候选处理租约默认20分钟，attemptToken绑定提交；过期worker不能覆盖新任务或人工决定。重试次数/预算消耗记runs，不用无限while。模型不可用、索引不可读、官方抓取失败均不得新建approved或扩大拒绝范围。

约束：每条SQL绑定参数不超过100；应用层设候选/批大小，必要时传有界JSON而不是大IN列表。不得把一个必须原子的活动提交拆成跨请求几个batch。接口默认不扫描全库、不为每个来源向模型发送全部历史。

## 8. 分阶段启用与兼容

新增 `IDENTITY_MODE=off|shadow|enforce`，默认off；`IDENTITY_PLATFORMS`精确平台名单，默认空。shadow只在独立身份表记录建议和差异，不改变旧公开offers、审核队列、lead终态或通知。enforce平台的所有入口由服务端统一强制；旧客户端不能绕过。

先增量迁移和一对一seed已有offers/rejected leads，再双写shadow，再灰度enforce。数据未seed完成的平台不得enforce，否则旧拒绝将暂时不可见。人工决定在双写期同步新decision，不靠未来某次批同步补救。

现有 `rejected_offer_updates` / `reviews` 保持可读；回填到review_decisions标注legacy provenance，不将系统猜测伪装成人工决定。第一阶段decision_key可用作旧拒绝导入幂等键；缺key的旧行使用表名+主键。

部署和migration顺序、feature flag切换都只写runbook，不在实现时执行。Phase3合并前可以回off；一旦发生历史实体合并，不允许直接回到不识别alias的旧版Worker，回滚见Phase3。

## 9. 测试与验收

新增真实fixture数据集而不是只断言字符串存在。以下是必测行为，所有外部HTTP/模型用受控fixture，数据库测试执行实际migration和Worker路由：

| ID | 输入 | 必须结果 |
|---|---|---|
| P2-01 | 同资格注册赠金，中英双语、不同URL/ID | 一个entity/version，第二次无新任务 |
| P2-02 | 已拒paid bundle换语言/新key | 关联原拒绝，无新offer或任务 |
| P2-03 | 从未产生offer的已拒lead换来源 | 关联拒绝实体，保留新观察 |
| P2-04 | 学生与企业同标题同金额 | 不自动合并；同时可独立审核 |
| P2-05 | 注册礼与邀请奖励同金额 | 不合并 |
| P2-06 | 同日两次明确独立reset | 两实体；同次预告/确认只一实体 |
| P2-07 | 同平台不同设备代际、模型/区域/积分池 | 不合并 |
| P2-08 | 100/日→100/月 | 一实体两版本，一项变更任务，旧公开值不变 |
| P2-09 | $10→$20 / 资格或有效期变化 | 正确material diff，不受纯数字保护吞掉 |
| P2-10 | 标点、数组顺序、翻译、UTM、抓取时间变化 | 无新的审核语义事件 |
| P2-11 | 字段漏抽、unknown、原文截断 | 保留旧事实，不认定取消或全球适用 |
| P2-12 | 证据不足拒绝后出现官方补证 | 满足reopen predicate才一个reopen任务 |
| P2-13 | 普通付费配置后来出现独立赠金 | 不被旧policy拒绝误杀 |
| P2-14 | 同页两优惠，同一观察多个候选 | 两候选独立处理，不以URL唯一丢失 |
| P2-15 | 一候选重复，另一候选失败 | 只重试失败候选，lead不提前closed |
| P2-16 | 人工补录已处理URL | 不清空决定；明确reopen才改变任务 |
| P2-17 | 同ID但资格/轮次冲突 | 409/needs_identity，不覆盖主offer |
| P2-18 | sameAs伪造、别平台ID、引用不在原文 | 拒绝模型关联，不扩大权限 |
| P2-19 | 两并发候选不同ID、同强锚点 | 一个主实体/任务/公开投影 |
| P2-20 | 人工approve/reject与采集同时发生 | 有版本保护，无丢决定/孤立提案 |
| P2-21 | batch中任意SQL失败或guard零行 | 无部分状态；可读回receipt判定重试 |
| P2-22 | 提交超时后重试同operationKey | 返回同receipt，无重复日志/通知 |
| P2-23 | 索引失败、模型限额、候选截断 | deferred/uncertain，不能当新活动 |
| P2-24 | 一个旧决策pair已not_same | 同弱依据不再次推荐合并 |
| P2-25 | 非管理员调用合并/扩大规则或公开读内部字段 | 403或不透出 |
| P2-26 | 旧客户端、官方/线索复核、relay入口 | 均经过服务端身份层 |
| P2-27 | 原官方同页摘录对应Mistral等已修复案例 | 原保护测试全部保持通过 |
| P2-28 | 弱别名碰撞、50条召回被截断、中文无分词 | 不静默错误hard-link；有可恢复任务 |
| P2-29 | 同一变更被多个来源复述，pending/unknown delivery | 一个任务，消息不重发 |
| P2-30 | facts算法升级、旧版本缓存 | 不能因旧缓存跳过新冲突或清空决定 |

固定回放集最低100对（≥40重复、≥40独立、≥20真实变化/补证），中英文改写至少20对。标签人工核对，保留训练示例与验收holdout分离；这只是启动门槛，不代表统计置信保证。

上线门槛：上述行为全部通过；holdout中自动错误合并=0、真实变化被静默丢弃=0；明确重复的自动终态召回目标≥90%，不足时改善召回或保留uncertain，不降低冲突保护换取数字。报告分母、uncertain占比、每平台结果，不能将uncertain记为正确去重。

shadow至少覆盖7次完整采集运行且包含人工标注的改写/新轮次回放，再灰度。监控新建/关联/拒绝抑制/变化/uncertain/deferred数、重复回审率、误合并纠正数、模型调用和D1行读取量。阈值是验收设计，不是对当前生产数据的测量。

完整检查：`npm run typecheck`、`npm test`、`npm run build:web`；新migration fresh-install与旧库upgrade；SQLite集成之外，在获授权的隔离D1上验证batch、partial unique、FTS与参数限制，不把本地SQLite通过当D1上线通过。

## 10. 官方技术依据与实现前核对

- D1 batch、Sessions：https://developers.cloudflare.com/d1/worker-api/d1-database/ 。batch失败整体回滚；跨await的应用事务不能假定存在。
- D1 SQL/FTS5/JSON：https://developers.cloudflare.com/d1/sql-api/sql-statements/ 。FTS5只是召回组件，不提供跨语言语义身份保证。
- 限额：https://developers.cloudflare.com/d1/platform/limits/ 。实施前按当前账户/运行版本确认，代码维持每SQL≤100绑定参数的保守界限。

本SPEC使用仓库当前路径作为定位，不固定行号。实施前读取最新源文件、migration和规则，并记录偏差；不可把2026-10-10的设计快照当作永远不变的生产事实。
