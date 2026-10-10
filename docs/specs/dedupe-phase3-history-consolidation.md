# SPEC · 第三阶段：历史回填、重复合并与可逆整理

版本：1.0 · 2026-10-10 · 状态：待实施，未扫描或更改生产历史

依赖：[第二阶段：统一身份与拒绝记忆](dedupe-phase2-identity-and-decisions.md)。执行入口：[Codex 分批执行说明](../plans/dedupe-codex-execution.md)。不得独立于第二阶段的解析器、代际控制和权限保护执行。

## 0. 目标与禁止事项

目标：让存量重复记录归于稳定活动身份，使后续查重、审核和通知继承正确历史；保留来源、原决定、人工修改、已有URL和可逆操作日志。

不把历史数据质量整理等同于重新批准。不得硬删除重复offers/reviews/revisions，不得批量把rejected改approved，不得更新lastVerifiedAt冒充重新核验，不得自动重新发送旧消息，不得重估美元价值或改平台政策。正文更正、估值变更和有效性复核另走原审核流程。

本规格没有生产记录数量、重复比例或待合并ID清单。Codex须从授权的只读导出/隔离副本获取真实快照；不得把之前报告中的数量当当前事实。私有导出、证据正文和个人信息不得提交GitHub。

## 1. 分成两个不同操作

### 1.1 Backfill：一对一补身份，不改变审核结论

给每条旧offer创建独立Entity/Version并记录映射；即使两行看起来相同，第一遍仍不合并。为无offer的已拒lead创建provisional实体或candidate-evidence决定；理由不明时按最窄范围保留，不能扩成全产品拒绝规则。

### 1.2 Consolidation：人工确认同一活动后的逻辑合并

根据现有事实、证据和第二阶段解析器生成候选分组；只有管理员确认的manifest可以写回。合并通过Entity redirect、活动/版本对应关系和公共投影选择实现。原行与历史归属不改写，不伪造“过去就是这样”。

这两个操作分别有命令、权限、dry-run报告、幂等key和验收，不能混成一次cleanup脚本。

## 2. 新增操作数据模型

在第二阶段表上补充：

| 表 | 必须字段/约束 |
|---|---|
| identity_backfill_jobs | id PK；mode；scope；snapshot_manifest_hash；cursor JSON；state planned/running/paused/completed/failed；started_at；completed_at；counts JSON；actor。 |
| identity_backfill_items | job_id FK；legacy_kind；legacy_id；legacy_fingerprint；entity_id；version_id；decision_id；status；error。UNIQUE(job_id,legacy_kind,legacy_id)。另对(legacy_kind,legacy_id,legacy_fingerprint,backfill_schema_version)建幂等约束，跨job不重复创造事实。 |
| identity_merge_plans | id PK；manifest JSON；manifest_hash UNIQUE；state proposed/approved/applied/conflicted/rolled_back；approved_by；approved_at；created_at。修改manifest必须生成新hash和重新批准。 |
| identity_merge_events | id PK；plan_id FK；operation_key UNIQUE；canonical_entity_id；member_ids JSON；before_image JSON；after_image JSON；actor；applied_at；rolled_back_by nullable FK；expected_generations JSON。append-only。 |
| identity_version_equivalences | id PK；left_version_id FK；right_version_id FK；relation same_terms/supersedes/distinct_round；basis JSON；merge_event_id FK；active。不得仅按terms_hash把unknown版本视为相同。 |

benefit_entities.redirect_to为可逆关系。redirect解析最大8跳；出现环或超过上限返回完整性错误，阻止公开投影与后续写入，不回退到创建新实体。正常merge直接指根实体，避免形成长链。

版本和决定保留origin entity；canonical读取必须按成员集合归一。不要原地改变历史version.entity_id或decision.entity_id以伪装归属；需要跨组复用相同事实时建立equivalence。新版本写根实体，历史相同terms通过成员索引/equivalence查到，避免因合并后版本仍在子实体而重新送审。

## 3. 只读盘点与快照合同

提供 `scripts/identity-history.ts`，子命令见第9节。默认dry-run，无环境推断、无隐式远端。

输入必须包含：导出时间、数据库/环境的非秘密标识、schema/migration版本、应用git SHA、收录policy版本、导出内容SHA256、允许的平台范围、表行数、导出工具版本。没有完整性manifest不允许apply。

最低盘点表：offers、leads（含resolution.offerIds及offerId）、offer_proposals（含manualFields）、offer_revisions、reviews、rejected_offer_updates、notifications、deliveries、platforms、sources，以及第二阶段全部身份/决定表。

读取顺序按稳定主键/游标分页；不能用OFFSET一边修改一边遍历。Snapshot模式可以固定导出；在线模式需记录水位，每条legacy row在提交前重查fingerprint（全部业务/审核相关字段，而不是只看updatedAt）。记录变更则标conflicted，不把新内容覆盖成旧快照。

报告至少包括：各状态数量；无平台/无证据/非法JSON/缺失父记录；多项权益共用页面；拒绝无原因；双approved潜在重复；pending提案/在途通知阻塞；可安全一对一回填数量；待人工消歧数量。公开与内部字段分开，报告可输出脱敏摘要。

## 4. 一对一回填规则

### 4.1 旧 offers

每条offer第一次回填一个稳定Entity，保存legacy offer→entity；优先保留旧offer.id作为canonicalOfferId，所以既有链接不变。服务端生成Entity UUID，映射持久化后不因脚本重跑再生成。

Version从存储事实与现有证据构建：不调用模型填未知字段，不从标题臆造地区或金额；不能把旧usdEstimate当领取额度。记录事实来源为legacy_snapshot，保留原evidence.capturedAt，不刷新lastVerifiedAt。

approved记录映射为批准其当前版本的历史决定；rejected记录映射为拒绝当前版本/证据；pending不生成批准。withdrawn/ended作为生命周期状态保留，不因entity confirmed变成可领。entity确认身份和offer批准是不同轴。

若存在历史审核日志，引用旧review ID作为basis并保留reviewer与时间；没有日志只标 `legacy_state_import`，注明“旧状态导入，具体审核时间/理由未知”，不得把迁移时间写成原审批时间。

### 4.2 已拒更新

从rejected_offer_updates导入对应候选条款版本及拒绝决定，保留evidence/diff/at和第一阶段decision_key。缺少完整candidate时建立partial事实版本，未知字段不从别的版本虚构。重复导入用原表主键+fingerprint去重。

### 4.3 未成 offer 的拒绝线索

保留lead原URL、raw摘要和resolution.reason/quote/evidenceUrl；自动模型拒绝与管理员拒绝分别标actor/strength。无明确依据时仅作用于该候选证据，不自动创建覆盖整个产品的宽规则。

同一个已拒事项的不同lead可以在后续manifest中合并；第一遍不依靠URL相似直接合并。断网、抓取失败、没有搜索结果不导入成永久否定决定。

### 4.4 pending proposals和人工字段

保存提案base版本、candidate、manualFields、原revision和更新时间。回填不删除提案、不自动批准、不刷新任务semanticRevision。人工更改证据、title、valueText、USD、领取条件等保护要完整保留。

## 5. 候选分组与主记录选择

复用第二阶段解析器的normalizer/retrieval/conflict/compare，新增batch planning层，不写另一套相似度算法。

输出分组必须带完整成员、建议主Entity/Offer、相同依据、不同字段、证据缺口、审批状态、影响的引用、未完成提案和通知。不确定pair不得通过传递闭包变成已确认cluster；每个成员要能独立证明与指定主记录同活动。

### 5.1 主记录排序只用于建议

优先：存在有效人工批准且实体/产品归属正确的原记录 → 有可靠官方证据和完整人工字段的记录 → 最早稳定公开ID。不能“最新抓取赢”“文本最长赢”或“一律选择approved”。

出现以下情况拒绝自动生成可执行merge，进入人工冲突任务：

- 两个approved版本实质不同，无法证明是同一计划的前后版本。
- 同日两次独立reset、不同积分池/产品/地区/资格/轮次。
- 一个被拒原因是duplicate，但没有可靠目标主记录。
- 记录存在人工提案，且合并会覆盖/重定向其字段编辑。
- 合并后会把已拒或无证据条目带入approved公开投影。
- 多个不同身份共用URL，唯一依据只是相同URL/金额/标题。

允许将确属同一计划的前后版本合并成一个Entity，但manifest必须注明每个version关系及哪个approved版本是当前公开投影；生命周期变化和再次开放必须有相应决定，不能由merge本身推断。

## 6. Manifest与人工批准

manifest是可审计、可重放的JSON文件，不是任意SQL。最低结构：

```json
{
  "schemaVersion": 1,
  "planId": "uuid",
  "snapshotHash": "sha256",
  "policyVersion": "recorded-version",
  "resolverVersion": "recorded-version",
  "groups": [{
    "groupId": "uuid",
    "canonicalEntityId": "uuid",
    "canonicalOfferId": "existing-offer-id",
    "members": [{ "entityId": "uuid", "expectedIdentityRevision": 4, "legacyFingerprint": "sha256" }],
    "reason": "管理员确认同一次注册赠金",
    "evidenceRefs": ["observation-id:excerpt-key"],
    "versionRelations": [{ "left": "version-id", "right": "version-id", "relation": "same_terms" }],
    "proposalDisposition": "block_until_resolved",
    "notificationDisposition": "preserve_no_resend"
  }]
}
```

该JSON为字段示例，不可直接对生产执行。成员列表必须包含canonical实体。每组最多10个Entity，超过必须拆为可逐组审查的计划且重算当前revision；不得把大组自动拆分后绕过人工确认。

planHash为规范序列化后的SHA256。管理员通过受认证命令/接口approve-plan保存planHash、actor、时间、范围；编辑成员、主记录、版本关系或来源后hash变化，必须重新批准。执行器仅接受存储为approved的对应hash，调用者不能仅在请求JSON里写approved=true。

Reviewer可以看报告、提出候选，不可批准批量merge。Ingest无merge权限。脚本操作始终显示计划的环境和scope；未明确指定目标环境只能dry-run。

## 7. Apply：原子提交和引用处理

每组单事务，通过第二阶段command key、platform generation、identity revision和legacyFingerprint共同保护。新nonce不是幂等key；operationKey固定为planHash+groupId。响应丢失用同key读回。

提交顺序逻辑：验证已批准计划与版本 → 保存before-image → 创建/确认版本equivalence与别名关系 → 将成员redirect到canonical根 → 更新规范投影指针及必要任务关联 → 增加相关generation → 保存after-image与operation receipt。所有必要后置条件由事务内SQL约束保证；任一失败整个组回滚。

不同平台的merge默认不允许。只有人工证实原platform归错且完成独立纠错决定后，才能在显式manifest中迁移；不能因为同公司或同模型跨产品合并。涉及多个平台generation的操作按稳定ID顺序检查并在同事务中更新。

### 7.1 引用处理矩阵

| 引用 | 合并后的处理 |
|---|---|
| offers.id / 旧详情URL / hash路由 | 保留旧ID。别名访问返回canonicalOfferId并展示canonical内容；旧行保留internal。不能重定向到未批准记录而泄漏内容。 |
| offers公开列表/平台页/RSS/日历/图表 | 只统计canonical投影一次；后端统一过滤，前端不另做“看起来重复”的过滤。 |
| leads.offerId / resolution.offerIds | 原引用保留可审计，读/判断时解析canonical；需要新的materialized映射时单独记录，不覆盖原resolution证据。 |
| reviews / revisions / rejected updates | 原事件归属和时间保持不变。聚合读取显式显示originOfferId/EntityId；旧reject duplicate不覆盖canonical批准。 |
| offer_proposals / manualFields | 默认阻塞merge直到人工处理。确需转移时新建明确迁移任务保留原base/diff/manualFields与origin，不盲拷到新base或静默丢提案。 |
| candidate/entity/version关联 | 保留origin，所有新解析先resolveCanonical；按equivalence找到旧版本和决定，避免再建待审。 |
| confirmed aliases | 查询时resolveCanonical，不需要全部批量重写。唯一冲突必须人工消解并记录证据；不能onConflictDoNothing丢掉含义不同的别名。 |
| review tasks | 已解决重复任务保留为resolved并标mergeEvent；未解决的新事实不取消；对保留任务只补来源，不重发首次卡。 |
| notifications / deliveries | 保留实际发送事实，解析canonical和版本关系后抑制同事件重发，不修改旧payload冒充过去发了别的东西。 |

### 7.2 通知特别规则

有pending/unknown delivery涉及组成员时，默认阻塞该组合并，先由管理员确认送达状态或释放尝试。不得通过合并让未知发送结果自动重试。

发送账本的新逻辑键是canonical entity + 可比较的version/事件 + stage + channel。历史记录按canonical映射聚合；same_terms版本可共同抑制“新上架”，不同新版本不能因为历史有changed记录就永不再通知。

日报常驻榜本来允许不同日期出现，不能把“每天榜单”变成全局只发一次。其每日幂等维度保持day；这里防的是merge/alias导致的意外重发，不删除合理的周期通知。

### 7.3 数量和价值

合并后列表/图表数量可能减少，这是去除重复投影，不是优惠被下架。记录before/after的canonical数量与价值聚合差异，明确被消除的重复贡献。不得把多条重复usdEstimate相加到主活动，也不能取最大值代替原人工估值。

## 8. 回滚与误合并恢复

只逻辑合并、不硬删除，使回滚能够恢复成员根身份。提供rollback-plan/rollback-group，默认先dry-run。

回滚前比较当前revisions/generation与merge after-image。若合并后没有新的批准、提案、别名或候选写入，则同一原子事务恢复redirect、canonical投影和任务映射，保存新rollback事件，不删除原merge事件。

若有后续写入，不允许盲恢复before-image：输出依赖冲突报告，转“split实体”人工任务。新写入Observation/Decision/Version不得丢失，需逐项确定归属。通知已发事实永远保留；回滚不撤回外部消息，也不自动再发。

Rollback请求幂等；重复执行同operationKey返回已有receipt。对已被其他rollback替代的计划给409。恢复时保留后来独立人工更正，不能因旧manifest把修改覆盖掉。

整个数据库级恢复是单独灾备操作，不由cleanup脚本自行执行。生产开始前需管理员确认备份/恢复点及恢复权限；脚本不得假定拥有云平台恢复能力。

## 9. CLI与API合同

创建 `scripts/identity-history.ts`，建议通过 `npx tsx` 运行，不新增能默认直连生产的package脚本。

子命令：

- `audit --input <sanitized-snapshot> --out <dir>`：只读完整性报告。
- `plan-backfill --input <snapshot> --out <manifest>`：一对一计划，不做merge。
- `apply-backfill --plan <file> --environment local|staging|production --expected-hash <hash>`：无批准/无明确环境拒绝执行。
- `plan-merge --input <snapshot> --out <manifest>`：疑似组、差异、阻塞项，默认只读。
- `approve-plan --plan <file> --expected-hash <hash>`：管理员服务保存批准，不能本地伪造。
- `apply-merge --plan <file> --environment ... --expected-hash <hash> --group <id>`：一次明确组；批量续跑逐组保存cursor和receipt。
- `verify --plan <file> --environment ... --out <report>`：只读后置检查。
- `rollback --plan <file> --group <id> --environment ...`：默认dry-run，另加`--apply`才写。

所有apply命令默认模拟，必须显式`--apply`，且生产环境另需当前任务的人工授权。`approve-plan`只批准该hash，不授权脚本自行扩展scope。工具必须忽略环境中偶然存在的ADMIN_TOKEN作为额外权限来源，环境变量有令牌也不扩大任务授权。

后台最低接口：`GET /api/admin/identity/history-plans/:id`、`POST .../:id/approve`、`POST .../:id/groups/:group/apply`、`POST .../:id/groups/:group/rollback`。请求含expectedHash、expectedRevision和commandKey。409不自动覆盖重试。所有报告和操作页面`Cache-Control: no-store`。

每批读最多200条；每批backfill最多20条；merge每组最多10实体。不要把所有IDs展开成超限SQL绑定参数；使用子查询或受控json_each，遵守实际D1限制。每个批次保存cursor与累计结果，失败可续跑而不重复决定。

## 10. 验收用例

必须在隔离副本完成，并保存脱敏报告：

1. 全新空库跑迁移与零行audit正确；旧库从实际0016之后增量迁移成功。
2. backfill重复运行两次，第二次新增实体/版本/决定=0；在第N批失败后续跑得到相同最终映射。
3. 200+ offers与复杂引用读写不超绑定参数，所有分页不漏行/重复行。
4. 一approved+一rejected duplicate合并后canonical批准不变；两个独立学生/企业优惠不可合并。
5. rejected lead无offer仍能继承拒绝；自由文本reason不自动扩大范围。
6. 两个同URL不同权益拒绝合并；三条A~B~C弱相似不以传递性自动合并。
7. 两个approved不同条款、独立reset轮次、不同地区、不同设备代际→冲突报告而非静默择一。
8. 有manualFields/proposal时默认阻塞；显式迁移保留原base和diff，不覆盖任何人工字段。
9. 每个旧offer URL仍可访问正确canonical；未批准/拒绝数据不能从alias公开接口泄漏。
10. offers、platforms详情、RSS、日历、全部榜单/聚合不重复计数；USD未重新计算。
11. 已发送new通知不重发；不同实质版本仍可发changed；日报按天行为保留；pending/unknown delivery阻塞merge。
12. 提交前记录被人工改动→409，零写；audit失败/约束异常→全组回滚；响应丢失重试不重复merge。
13. 运行中采集同义新候选：generation冲突后重新召回canonical，不创造旧alias的新offer。
14. redirect环/超深链/孤儿引用触发完整性失败，不悄悄忽略。
15. 没有后续写入的merge可完整回滚；有后续更新则拒绝盲回滚并给split任务，数据不丢。
16. main/production与staging环境标识混淆、manifest被修改、未批准hash、越权reviewer/ingest均不能apply。

完整性报告应证明：所有旧引用仍可解析；所有merge有事件与before/after-image；没有新增公开批准；没有更新真实lastVerifiedAt；没有新增外部发送；所有状态变化均在批准manifest内。

## 11. 上线顺序与停止条件

1. 第二阶段基础表与身份解析在隔离环境验收。
2. 授权只读导出，audit，修复结构性坏数据或记录阻塞，不用脚本“猜正确值”。
3. 在副本上backfill，重复运行验证幂等；新旧公开输出在未merge时相同。
4. 生成候选merge报告，管理员逐组选择；测试至少一个无风险小组的apply和rollback。
5. 管理员另行批准生产备份、迁移、回填和指定manifest；执行时暂停相关平台采集写入或确认全部写入口已受generation保护。
6. 生产先一小组，verify通过才继续下一组；不把授权小组外的候选自动加入。
7. 完成后只读检查两个完整采集轮次：旧批准/拒绝同版本不重新造人审任务；独立新羊毛和真实变化仍能进入审核。

停止条件：孤儿引用、误合并、审批状态意外变化、人工字段丢失、重复通知、版本保护失败、D1异常增加或manifest不一致。立即停止后续组，保留日志；根据第8节选择组回滚或人工split，不自动全库回滚。

## 12. 交付清单

- 回填与合并CLI/API、权限测试、manifest schema、分页及事务测试。
- 脱敏dry-run报告样例、冲突报告样例、apply/verify/rollback结果样例。
- 数据模型/读路径变更、所有公开入口和通知入口的canonical处理。
- docs/data-contract.md、docs/design.md、docs/operations.md、仓库审核技能的同步说明。
- 独立PR，明确已经完成的是脚本/测试/隔离验证还是生产写回。没有生产授权则交付到隔离验收为止。

不以“重复数量减少”单指标宣告成功。必须同时证明不同优惠未被误杀、真实更新未被吞、历史审核可追溯、旧链接可用、回滚可执行。
