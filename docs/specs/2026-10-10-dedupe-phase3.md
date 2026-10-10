# SPEC-03：历史身份回填、重复合并与安全切换

版本：1.0 · 2026-10-10 · 状态：待 Codex 实施的设计规范，不是已经执行的数据清理。

前置依赖：[SPEC-02](2026-10-10-dedupe-phase2.md)。本阶段必须建立在统一身份服务、作用域拒绝记忆、候选级回执、canonical读取及通知归属解析已完成且测试通过的基础上。不得另写一个独立的“相似度大于阈值就删除”活动脚本。

## 1. 范围与授权

本阶段交付两部分：可重复运行的迁移/合并工具，以及经过预览和人工确认的执行流程。默认只在隔离本地/测试D1和合成数据上开发验证。生产数据读取导出、生产apply、rollback和部署都需管理员单独授权，不能从“写SPEC”或“建PR”推导出这些权限。

目标：将历史重复记录关联到一个规范实体，网站、统计、审核和通知都只认同一份有效权益；保留旧ID、原审核理由、原修订、来源证据和真实发送回执。不追求“数据库行数最少”，不物理删除旧offer。

## 2. 核心原则

H01：dry-run业务写入数为0，不能写lastSeen、任务、状态、通知标记或模型预算。首版dry-run纯确定性读取；需要模型辅助时使用单独明确标记的有预算分析命令，不叫dry-run。

H02：任何合并必须有可见manifest、明确canonical选择、受影响引用清单和前置版本。输入数据变了就拒绝本组apply，不能拿旧计划覆盖新审核。

H03：每个组是原子单位；批次可有多个组，但一个组不能留下部分合并。通过幂等operationKey可恢复中断，不依靠“脚本大概跑到第几行”。

H04：原审计与已发送payload不可改写。合并用root归属视图表示，不把历史事实重新编造在主活动名下。

H05：identity确定不代表字段内容确定；有冲突的公开值和人工提案不能通过“最新覆盖”“最大值优先”或字符串拼接自动解决。

H06：pending或unknown的投递未人工对账前，禁止合并涉及的成员。绝不能把unknown释放后自动再发。

H07：回滚只撤销本次已记录的变更，且必须验证未被后续操作修改；不能直接恢复整库备份抹去其他新数据。

H08：已合并的别名ID必须继续解析；关闭新resolver不能恢复旧重复公开行。

## 3. 只读盘点与快照

先实现 `scripts/identity-inventory.ts`，默认只读本地路径或显式指定测试API，禁止默认API_BASE指向生产。输出到gitignored的 `artifacts/identity/<runId>/`。拒绝令牌/密钥出现在输出、命令日志或文件名；生产原文和客户信息不能提交repo。

盘点必须覆盖：offers全部reviewState及过期/撤回状态、platforms/sources归属、offer_proposals及manualFields、reviews、offer_revisions、rejected_offer_updates、leads及resolution.offerIds、notifications、deliveries，以及第二阶段新身份表。遗漏某个表不能宣称全链路合并。

输出：

| 文件 | 内容 |
|---|---|
| inventory.json | schema版本、当前应用commit、数据来源环境、业务表计数、状态分布、orphan检查、待定投递数量 |
| snapshot-index.json | 每个相关record的ID、业务版本/hash、引用关系和抽取完整性；不含令牌 |
| duplicate-candidates.json | 强匹配、疑似匹配、明确不合并的配对和理由 |
| review.html或review.md | 可读预览，主记录与成员逐字段对比、旧决定和证据入口 |
| summary.json | 扫描量、覆盖量、未扫描量、工具版本和停止原因 |

记录数据库一致性边界：优先在隔离恢复副本上运行离线盘点；在线分页读取不是全局快照，必须在报告中标记，并在apply时对每组重读版本。不能把跨页有写入的结果称为一致快照。

大表使用游标分页；记录并遵循返回cursor直到结束，不能只取前100或只扫approved。身份/引用缺失时输出错误队列，不能默认没有引用。

## 4. 历史回填：先赋予身份，不急着合并

### 4.1 初始1:1回填

为每个旧offer创建一个独立entity和offer_identity_link；若已回填则复用，重复执行不能新增第二个entity。命令键采用 `legacy-offer:<offerId>:identity-v1`，首条命令与link/entity创建同事务。

保留原offer ID、reviewState、证据、估值、人工字段、发现/审核时间；回填不刷新lastVerifiedAt，不重新批准，不发送消息。不把当前时间作为历史活动开始或历史审核时间。

approved记录有可信已知事实时创建baseline version并指向它；字段无法从原证据确认时保留unknown和legacy来源标记，不以模型常识补齐。pending/拒绝/历史活动也需回填，以便后续匹配。

### 4.2 回填审核决定

优先从reviews/rejected_offer_updates和有版本的lead resolution导入，保留原actor、action、reasonCode、reason、时间与来源ID。每个来源审计记录使用唯一导入键，不能二次导入。

- 原人工approve/reject可导入对应有限范围决定；缺失原version时明确标记legacy_version_unknown，最多支持已确认相同主张的记忆。
- reviewer=system或模型初筛不是人工决定，必须保持system来源。
- duplicate拒绝只有明确指向主记录的依据才建立alias；自然语言“重复”但没有对象，进入一次性人工定界。
- other/无理由不能生成entity_policy或全平台禁止规则。
- 没有offer的rejected lead也回填candidate和决定；不要虚构一个offer来满足外键。
- 合并批准与拒绝历史时不能用“approved总是优先”删除真实拒绝理由；先区分拒绝的是重复影子、错误版本、证据不足还是政策本身。

### 4.3 回填已有通知覆盖

原notifications/deliveries保持不变。建立可追溯的实体事件覆盖视图或表，从原offer归属映射到当前root，用于防止合并后重发“新活动”。对于无法判断对应哪个版本的旧changed通知，不凭数字大小归属新版本；标记legacy覆盖并把旧变更视为历史，后续只有明确的新批准transition才触发新事件。

建议新增 `identity_event_coverage`：`id,root_entity_id,event_kind,version_id nullable,publication_seq nullable,channel,legacy_table,legacy_row_id,receipt_state,at,import_key UNIQUE`。该表是投影，可重建；真实发送状态仍以原回执为准，不把import时间当发送时间。event_kind区分first_publication、change、ending、ended、review_task与daily_recommendation。

## 5. 候选分组与主记录选择

### 5.1 分组规则

调用第二阶段相同的召回和身份比较器，并读取所有keep_separate/作用域决定。输出三类：

- `confirmed_duplicate`：有充分同实体同轮次证据，可提出合并计划，仍需管理员批准manifest。
- `needs_identity_review`：只有词面/向量相似、资格未知、来源关系不明，不进入自动apply集合。
- `keep_separate`：独立产品/机制/资格/池/设备代际/轮次的可信冲突，持久保存审核关系后不反复询问。

不得简单union-find弱相似边。一个组必须以拟定canonical为中心逐成员确认兼容，同时检查成员之间已知冲突；A≈B、B≈C但A与C独立时不得把三者整组归并。

常驻计划跨年份仍可同实体。活动新一轮必须单独实体；对比要区分official发布时间、claimStart、实际occurrence，不能以抓取日期制造新轮次或合并年度活动。

### 5.2 规范主记录建议

优先推荐有明确人工批准、较完整可信证据和已审核字段的记录；推荐不等于自动采用。保持外部使用较多的旧ID有利于兼容，但不能因此选错活动。

| 组合 | 处理 |
|---|---|
| approved + 同版本pending | 通常保留approved投影，将pending作为重复影子；补充证据但不覆盖人工值 |
| approved + 因duplicate而rejected影子 | 指向approved root，保留影子拒绝审计；不继承为全实体拒绝 |
| 两个approved且事实一致 | 人工选canonical，保留另一行与全部引用；网站只显示一份 |
| 两个approved但金额/资格/时间冲突 | 阻断合并，先确定版本或独立活动，不能取最高价值 |
| approved + 政策本身被人工拒绝 | 必须审查决定范围和先后因果，不能按状态优先级覆盖 |
| 只有pending/rejected且证据不全 | 不为减少队列强行批准；可建立同一不公开entity与一个任务 |
| 一个是母公司公告，另一个是产品公告 | 只有实际领取同一权益才同entity；母公司不能替代产品归属 |

title、steps、adminNote、reviewMemo不得随合并拼接成公开文案。不同人工备注保留原记录，管理页按来源显示。估值保持规范投影已有合法V1值；merge本身不重算美元或合计两条重复价值。

## 6. 合并manifest合同

新增 `src/shared/identity-merge-contract.ts`，由Zod验证，作为预览、批准、apply、回滚的唯一合同。以下字段是首版必需：

```ts
interface MergeManifestV1 {
  schemaVersion: 1;
  planId: string;
  algorithmVersion: string;
  sourceEnvironment: 'local'|'test'|'production';
  sourceSchemaVersion: string;
  snapshotId: string;
  planHash: string;
  groups: Array<{
    groupId: string;
    memberEntityIds: string[];
    canonicalEntityId: string;
    canonicalOfferId: string|null;
    expectedEntities: Array<{id:string; identityRevision:number; currentVersionId:string|null; rootId:string}>;
    expectedOffers: Array<{id:string; updatedAt:string; reviewState:string; contentHash:string}>;
    expectedProposals: Array<{offerId:string; updatedAt:string; candidateHash:string; manualFieldsHash:string}>;
    expectedDecisionHash: string;
    expectedReferenceHash: string;
    evidenceRefs: string[];
    justification: string;
    chosenFields: Array<{field:string; fromOfferId:string; valueHash:string}>;
    taskActions: Array<{taskId:string; expectedRevision:number; action:'resolve_duplicate'|'retain'|'combine_review'}>;
    projectedCounts: Record<string,number>;
    blockedReasons: string[];
  }>;
}
```

`planHash`以schemaVersion、algorithmVersion、sourceEnvironment/schema、snapshotId和排序稳定的groups为规范JSON求SHA256；排除planHash本身和报告生成时间。所有预览字段选择均在hash内；修改组成员、主记录或选用字段都需要重新批准。成员和expected版本不能由apply时临时“自动修正”。

chosenFields首版默认为保持canonical原值。任何来源不同的公开字段选择视为内容变更，另走正常审核提案，不随merge直接写公开投影；manifest标记此限制。实际身份合并可先完成，仅合并后未解决的内容差异保持一个任务。

批准动作：管理员提交planId+planHash+approvedGroupIds+reason，写append-only决定。token仅用于认证，不能写入manifest。首版使用服务器存储的已批准hash，不需要在客户端保存签名密钥。没有批准记录、hash不符、环境不符或blockedReasons非空，一律拒绝apply。

## 7. 原子应用与引用处理

新增 `identity_merge_operations`：`operation_key PK,plan_id,plan_hash,group_id,state(prepared/applied/reverted/conflict),before_image JSON,after_image JSON,expected_after_revision JSON,actor,at,applied_at,reverted_at,error`。UNIQUE(plan_hash,group_id)。日志不能在失败后误报applied。

一个组的执行顺序：

1. 验证admin权限、明确的已批准manifest、环境和schema。获取涉及root的短租约，按ID排序避免相互等待；租约失败返回可重试，不持锁调用LLM。
2. 重读所有实体、offer、proposal、决定、任务、alias和投递依赖；计算manifest预期hash。任一业务版本变化返回409，本组零修改。
3. 查询成员全部pending/unknown deliveries，以及被其payload/marks/reviewAlerts引用的成员。任何未对账投递阻断整组，不能只看notifications。
4. 计算before/after变更集与字段级回滚依据。禁止隐式改变reviewState、lastVerifiedAt、人工估值和真实回执。
5. 单个D1 batch以本次operation marker和完整前置条件为闸门，原子写alias/root关系、规范entity修订、所需任务关联、决定、事件覆盖和operation回执。每条后续SQL依赖本次marker，零行前置检查不能造成部分提交。
6. 读回确认所有成员root唯一、规范投影唯一、无孤儿FK、任务和通知去重符合预览。返回operationKey、受影响计数、before/after canonical集合。

不允许一个过大的组被拆成几次无保护的数据库提交。超过实际D1事务/语句/绑定限制时拒绝该组并要求重新设计分组或使用明确的prepare/activate协议；不能以执行一半为“成功”。首版组成员上限10个，批次默认每次处理20个组、最大50个组；每组独立事务和独立状态。重跑只继续未applied的组，已成功组返回原回执。

### 7.1 每类引用的具体规则

| 引用 | 必须行为 |
|---|---|
| offers | 不DELETE；canonical实体指向选定公开offer。旧行保留原字段和状态，公开查询通过root/成员过滤排除影子 |
| offer_identity_links | 保留旧offer原始entity归属；root解析提供统一视图，不改写旧历史主体 |
| entity merged_into | loser指向root，禁止环；单组扁平化，已有下级成员必须计入manifest；不静默改未列成员 |
| 强alias | 解析到root；不得抢占冲突alias；所有移交有beforeImage和决定 |
| source_observations/proofs | 保留原来源；同内容可关联统一entity，不能把其他offer摘录覆盖canonical原审核证据 |
| leads/resolution.offerIds | 保留原入库ID也能经root解析；新v2候选读统一root。不要用全库字符串替换JSON中的ID |
| observation_candidates | 已成功候选保持成功，通过root读取统一归属；不重跑模型、不清拒绝决定 |
| review_decisions/reviews/revisions | 原记录immutable，管理页聚合展示成员记录和来源；新增merge决定，不伪造历史approve |
| offer_proposals/manualFields | 不静默丢失。相同提案可经明确manifest收束；不同或人工编辑冲突则retain/合并到待核对任务，不直接覆盖 |
| identity_tasks | 稳定地收束duplicate任务并引用主task；只有未解决差异保留。不能只把所有任务标done |
| notifications | 原offer-stage-channel唯一键不批量改成canonical以免冲突；经成员/root聚合及coverage投影判断已通知 |
| deliveries | 已发送payload和messageId不改，pending/unknown先对账；任何merge都不触发自动补发 |

提案处理约束：若两个成员有不同manualFields或candidate事实冲突，首版合并应阻断，先由管理员解决；不能仅把两个冲突提案的对象spread到一起。对于完全相同提案的收束，必须保存原proposal快照到operation beforeImage并保留审计引用，供回滚恢复。

### 7.2 公开查询和统计

所有入口必须使用同一root过滤服务：`/api/offers`、单条详情、`/api/platforms/:id`、RSS、时间线、日历、模型页、常驻库、申请制、排行榜、墓场和通知候选。后台审核列表也不能留重复影子待审。

旧 `/api/offers/:oldId` 在canonical仍批准且平台准入时返回canonical公开DTO，可附安全的canonicalId与requestedId；不能通过旧ID泄露拒绝记录。网站旧 `#offer-旧ID`需跳转或替换为主ID。若canonical不公开，仍404；不能为了兼容泄露原rejected内容。

合并不将活动开始日改成现在，不把历史补录记成本周新增。合计每个规范活动计一次，不相加重复美元值；未知美元保持null，申请上限保持申请制口径。缓存schema命名空间在canonical读取上线时升级，管理员不能因旧缓存误判重复仍在。

“去掉重复记录数”和“真实福利数量变化”分别报告：公开count下降可能正确，但变化必须能逐组解释。旧ID的历史审计计数保持原样，不能因聚合修改“管理员当年审核了几次”的事实。

## 8. 回滚与拆分

新增 `POST /api/admin/identity-merges/:operationKey/revert`，必须admin、expectedAfterRevision、reason和独立commandKey。批量回滚默认关闭。

只有以下条件全部满足，才能自动回滚该组：

- operation仍applied且没有后续merge/split依赖。
- 所有该操作修改的业务字段/alias/root/task投影均等于记录的afterImage，identityRevision符合预期。
- 没有merge后的新人工决定、批准版本、投递状态变化或无法确定归属的新候选。只增加lastSeen等无业务副作用字段，可经字段白名单保留，不恢复旧值。
- 原成员记录和提案快照仍完整，恢复不会造成唯一键/FK冲突。

回滚也使用事务：恢复本次改变的root/alias/task投影，保留原不可变审计，新增revert决定，operation记reverted。不能DELETE原merge审计；beforeImage包含的全部原始大正文不应自动公开。

存在后续业务变化时返回409并输出冲突引用清单，由管理员执行有计划的compensating split。split是新业务操作，显式决定新候选/任务归谁；禁止套用旧beforeImage覆盖后来的事实。

整库恢复只作为严重事故的运维恢复手段，必须单独停写、评估后续数据和批准；不作为普通merge undo实现。第一阶段增加的拒绝decision_key及任何已写拒绝记忆不能随回滚被清空。

## 9. 需要实现的运维CLI与接口

下面是目标命令合同，不是当前仓库已有命令；Codex必须实现后才能使用。都应有 `--help`、参数校验和非零错误退出码。

```text
npx tsx scripts/identity-inventory.ts --db <local-file> --out <directory>
npx tsx scripts/identity-backfill.ts --db <local-file> --dry-run --out <directory>
npx tsx scripts/identity-backfill.ts --db <local-file> --apply --manifest <file> --expected-hash <sha256>
npx tsx scripts/identity-merge.ts plan --db <local-file> --out <directory>
npx tsx scripts/identity-merge.ts apply --db <local-file> --manifest <file> --expected-hash <sha256> --approved-groups <ids>
npx tsx scripts/identity-merge.ts verify --db <local-file> --operation <key>
npx tsx scripts/identity-merge.ts revert --db <local-file> --operation <key> --expected-after <revision-file> --reason <text>
```

本地apply使用相同service逻辑适配SQLite，真实D1通过受保护admin API；禁止在HTTP失败时自动退回直接生产SQL。生产模式必须显式 `--environment production --api-base <explicit-url>`，并用环境变量读取token；不接受默认生产地址、不把token写到CLI参数。`--dry-run`与`--apply`互斥；来源环境与manifest不符拒绝。

目标API：`POST /api/admin/identity-merges/plan`（只读预览）、`POST /identity-merges/approve-plan`（保存批准）、`POST /identity-merges/apply`（按组事务）、`GET /identity-merges/:operationKey`（回执）、`POST /identity-merges/:operationKey/revert`（条件回滚）。HTTP按admin路由权限，reviewer和INGEST_TOKEN调用写接口403。schema不得直接接受任意SQL、任意表名、模型生成谓词或未经校验的JSON patch。

退出码：0成功/有效dry-run；2参数或manifest无效；3版本/引用冲突；4依赖/数据库故障；5仅部分组完成。任何部分成功都输出每组状态及可续跑游标，不能返回全量成功。

## 10. 实施顺序与文件落点

P3-A，盘点和幂等回填工具：新增 `scripts/identity-inventory.ts`、`scripts/identity-backfill.ts`、`src/worker/identity/backfill.ts`。用合成数据库覆盖所有历史状态和缺理由记录；只在本地开发回填，不合并。

P3-B，merge合同与预览：新增 `src/shared/identity-merge-contract.ts`、`src/worker/identity/merge-plan.ts`、`scripts/identity-merge.ts`。计划必须可解释且确定性，dry-run无写入；加入配对非传递性与冲突canonical测试。

P3-C，apply/revert：新增 `src/worker/identity/merge-apply.ts`、`merge-routes.ts`和operation/coverage迁移。接入权限、CAS、幂等、事务、投递阻断、条件回滚。先失败测试，再实现。

P3-D，公开与通知切换：修改共享canonical查询、实际web旧ID路由、各公开API、admin queue和通知构建；所有合成引用合并/回滚后无孤儿且不重发。补operations、data-contract和演练报告。

每个PR独立通过typecheck、npm test及涉及web时build:web；迁移必须在真实本地Wrangler D1也验证。任何SQL大表遍历和同步API循环应有分页/限额/进度，不用一个可能超时的请求处理整库。

## 11. 验收测试

必须使用迁移构建数据库与真实服务代码，不复制待测条件。至少覆盖下表；多次运行、逆序运行、故障注入均需断言最终数据库状态。

| 编号 | 场景 | 断言 |
|---|---|---|
| H01 | 混合approved/pending/rejected/ended/withdrawn及无offer lead | 盘点覆盖全部，分页无遗漏；计数可对账 |
| H02 | 同一回填连续两次/中途停止重跑 | entity/link/decision只生成一次；原offer字段和时间不变 |
| H03 | 仅system判断、缺理由、无法定位版本历史 | 不冒充人工，不建立宽范围拒绝规则 |
| H04 | dry-run/plan命令 | 所有业务表行数和内容hash不变；无模型/网络写请求 |
| H05 | 100个相似配对含A-B-C冲突 | 不通过弱相似传递形成错误组 |
| H06 | 两个approved值一致 | 人工选canonical后只公开一个，不相加估值 |
| H07 | 两个approved资格/金额冲突 | 计划blocked，apply拒绝，原状态不变 |
| H08 | approved与duplicate rejected | 保留批准投影和影子拒绝历史；不把主实体判拒 |
| H09 | 两份人工提案冲突 | 不覆盖manualFields、不删除提案；阻断或先人工解决 |
| H10 | 预览后offer/proposal/decision/alias被修改 | 本组409且零修改，不用旧manifest覆盖 |
| H11 | 预览后新pending/unknown投递出现 | apply阻断；不把投递标sent/failed/released |
| H12 | batch中间审计失败、第一条前置检查零行 | 不留下半组root/alias/task/operation成功标记 |
| H13 | 应用成功但HTTP响应丢失后重试 | 相同operation结果，计数/通知不重复 |
| H14 | 20组中第7组失败再续跑 | 前6组不重做，失败组保留原状态；结果逐组报告 |
| H15 | 大于10成员组、参数绑定超限制 | 执行前拒绝或明确拆分计划，不能部分提交 |
| H16 | 旧ID/旧hash路由/不同公开入口 | 全部到相同canonical；被拒root不泄露详情 |
| H17 | RSS、日历、模型页、排行榜、墓场 | canonical只计一次，开始日期与历史分类不漂移 |
| H18 | notifications唯一键冲突与旧changed版本不明 | 不bulk改FK、不伪造回执，不重发旧变化 |
| H19 | 正常发送过的成员合并 | 历史payload不变，首次上架不再推；新批准变化仍能推 |
| H20 | 每日飞书常驻榜 | 合并只减少榜内重复，不永久禁止每日推荐 |
| H21 | 刚合并后立即revert | 仅恢复本次字段，旧ID/任务/聚合正确，无孤儿FK |
| H22 | 合并后管理员改了新条款/决定 | 自动revert409，不抹掉新事实，给补偿拆分清单 |
| H23 | 合并后新增candidate或发生投递变化 | 不无条件还原beforeImage，要求显式归属处理 |
| H24 | 重复revert、A→B→A或alias循环 | 幂等或409，绝不产生循环解析 |
| H25 | 关闭resolver/回滚应用版本 | 已合并的root仍解析，不把重复影子重新公开 |
| H26 | reviewer/ingest身份调用merge写接口 | 403，数据库不变 |
| H27 | 修改manifest组成员/主ID/环境/hash | 批准失效并拒绝apply |
| H28 | 真实本地Wrangler D1迁移及事务行为 | 与SQLite合成测试同样通过；记录实际命令/结果 |

每次演练生成：before/after公开canonical集合、每组被抑制重复的映射、全部审计/通知计数、不变字段hash、`PRAGMA foreign_key_check`结果、失败组与未处理组清单。不能只有“成功合并N条”的一句日志。

## 12. 生产执行检查表与分批发布

实施完成不等于可直接在生产执行。运行者必须逐项确认：

- 第二阶段enforce或兼容root服务已验证，所有写入口不绕过；旧Worker回滚也理解merged root。
- 数据备份/恢复点可用，曾在隔离副本恢复验证；数据库名称/ID/环境明确匹配，令牌未打印。
- 所有迁移已在测试环境通过；生产变更窗口、停止条件和负责人明确。
- 生产只读盘点完整，管理员批准确切planHash与具体groupIds；只有疑似相似的组不获批自动合并。
- 未确定投递已对账；不能为了让合并通过而批量release。
- 第一批只应用3个无字段冲突的确认重复组；逐项读回公开接口和后台，检查新事件数为0。
- 第一批通过后再按默认20组上限推进；任何不明公开数量变化、孤儿、重复发送、前置版本异常都停止后续组并保留进度。
- 完成后至少跨一次常规采集验证旧变体不重新建offer/task；真实新条款的合成或测试环境案例仍能进入提案。

最后交付运行报告，分开列出：代码已合并、迁移是否已应用、Worker是否已部署、哪些组已批准/已应用/跳过/失败、哪些线上验收实际完成。没有执行的项目写“未执行”，不得用CI通过替代生产验收。

## 13. 两阶段共同实现细则

这些细则补充SPEC-02，解决易被不同实现理解成不同含义的边界：

- strong alias与weak hint分开：identity_aliases只保存经确认强映射；弱URL/模型key提示存候选检索索引，不受强唯一约束。一个source URL可检索多个entity，不能抢占URL归属。
- identity_revision在身份关系、有效决定、版本指针和task语义改变时递增；last_seen更新不递增。新增决定即使不改公开offer也使旧merge计划失效。
- extraction完整输出及候选数量可保存在identity_commands对应extract命令的result中，再持久化每个candidate；0候选也必须有完成回执。禁止只有候选ordinal而没有可证明完整的提取批次。
- 对一个entity下相同factHash但新增证明，追加provenance关联，不改immutable facts；只有未知补足且影响判断时创建新candidate/version并解释是补证还是政策变化。
- 发布、审计、alias root和通知事件的写入都需要同命令版本闸门；不能仅锁住新建entity而放任人工批准绕开。
- 历史canonical变化采用root解析，不将所有外键更新到一个ID。这是为保留审计和避免唯一键冲突，不代表可以忽略任何消费者；所有消费者必须有合并前后测试。
- 若由于D1限制无法在一组内原子激活全部必需变更，首版拒绝该组；不要隐式设计未经测试的多阶段生产迁移。

## 14. 交付物

必交：可执行CLI及help、接口与权限测试、schema/迁移、只读盘点与manifest预览、原子apply与条件revert、canonical消费者适配、黄金测试、故障注入报告、隔离恢复演练、生产操作手册及未解决清单。合成fixtures可提交；生产snapshot、manifest中敏感原文、认证信息不得提交。

最终验收问题不是“删掉多少重复”，而是“每一次保留、合并、抑制和重开是否有可追溯的依据，并且不会损害新的真实福利”。
