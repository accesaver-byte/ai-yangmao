# 第三阶段 SPEC：历史回填、安全合并与回滚

状态：待实施；不能据本文自动执行生产整理。
日期：2026-10-10。前置：[第二阶段身份与审核记忆](2026-10-10-benefit-identity-phase2.md)。执行入口：[Codex交接](2026-10-10-codex-handoff.md)。

## 0. 目标及执行边界

目标：把已有重复活动、线索和拒绝记录关联到正确主实体，保留每次抓取、审核、公开版本、通知和人工修改的历史；清理重复展示及重复审核任务，保证旧链接有效，未来重抓能命中已整理身份。

必须先完成第二阶段的全入口身份层、decision持久化、operation receipt、并发保护和公共canonical读取。不能先删历史重复行，再期望新算法补回历史。

本次只交付设计。Codex后续可在隔离数据上实现/验证工具；生产导出、D1迁移、暂停采集、合并生产数据、切换feature flag和部署都需要单独明确授权。默认所有CLI为本地只读或dry-run；不得检测到令牌就自动使用。

不承诺任意时间点一键无损拆回：在合并后又有新批准、新人工编辑或新来源依赖合并关系时，自动回滚必须拒绝，转为有依据的补偿操作。真实已发消息无法撤销，不应伪造未发送。

## 1. 不变量与主记录选择

- 不物理删除旧offers、leads、revisions、reviews、rejected_offer_updates、notifications、deliveries。
- 第一遍回填严格一对一：一个旧offer一个实体；不以标题相似、同URL或同金额直接合并。
- approved不会因归并到rejected而被静默下架；rejected也不会因归并到approved而被重写成“管理员批准过”。历史状态原样保存，当前公开状态由选择的canonical投影和明确决定控制。
- 原始出处和发送回执保留原ID，查询时逻辑解析主实体；不要把历史正文或投递payload改写成从未发生的内容。
- 合并只确认身份及展示归属，不授权采用新的金额、截止日期、资格、估值或证据。需要改变条款时另走第二阶段版本审核。
- 所有合并由同一identity resolver给出建议，经人工确认具体plan；不能另写脚本采用更宽松的阈值。
- 任何范围、事实、版本或授权变化，已批准的旧plan失效，必须重新预览；不能后台自动替换plan内容继续执行。

canonical推荐顺序：有管理员批准且证据明确的现有offer优先；其次已确认身份的pending；均未批准时选择最早建立的稳定记录作为建议。同等级按createdAt、id确定排序，只保证输出稳定，不构成正确性证据。最终canonicalEntityId、canonicalOfferId、采用的已批准版本必须在plan里显式给出。

两个approved条款不一致、一个approved而另一个因paid_bundle等政策理由rejected、不同资格/轮次/产品、人工not_same关系存在、或legacy一条记录混合多个独立优惠：标为blocked，不能用优先级自动裁决。可提出人工拆分/纠错任务，但不在merge里暗中拆条或改金额。

## 2. 总体流程

```text
授权取得只读快照
  → 清点/校验/建立基线manifest
  → 一对一回填实体、版本、来源及历史决定
  → 使用第二阶段resolver生成候选簇（不应用）
  → 人工逐簇确认canonical、关系与冲突处置
  → 固定plan hash和行版本
  → 隔离库完整演练：合并、验证、回滚、故障注入
  → 另行授权生产执行
  → 锁定受影响scope、重读版本、单簇事务提交
  → 验证、释放scope、恢复任务
  → 观察重放结果；保留journal与回滚能力
```

生产整理与代码发布分开。禁止一次脚本“导出→自动猜重复→删行→部署→重抓”。发现高风险或超限簇时跳过并生成清单，不拖垮其他已经验证的独立簇。

## 3. 基线快照与审计清单

新增 `scripts/identity/audit.ts`，默认只读输入SQLite快照或脱敏JSON导出，不自动连接生产。输入路径不存在、缺表、外键不一致、迁移版本未知时退出非零，不拿空集替代。

manifest至少包含：代码commit、migration列表及checksum、导出时间UTC、数据库环境标识（不含令牌）、快照SHA256、每表行数、每种review/lead/delivery状态数量、最大数值主键、按稳定顺序计算的业务行hash、导出是否完整和脱敏说明。

最低清点表：platforms、sources、offers、leads、offer_revisions、offer_proposals、reviews、rejected_offer_updates、notifications、deliveries，以及第二阶段所有新表。列出并拒绝未处理的新增外键引用；实施时用schema/PRAGMA核对，不假设本清单永远完整。

审计输出：

1. 空/非法/不一致官方证据、过时schema、孤立外键、短码碰撞。
2. 各platform的approved/pending/rejected及无offer拒绝线索数量。
3. 可能同活动的不同ID，以及同URL不同活动，不混为一个集合。
4. proposal与主offer版本是否一致；当前manualFields；待执行official/lead job。
5. pending/unknown deliveries及引用活动，已发通知的语义阶段。
6. public列表、平台页、日历、按模型页、累计估值等基线输出。金额下降可能是去除重复计算，不应被报告为实际权益缩水，须按字段解释。

输出 `manifest.json`、`audit.json`、`audit.md`。生产原始快照、内部拒绝理由及完整原文不得提交GitHub；仓库只提交脱敏fixture和代码。用户/环境有备份策略时遵循其策略，至少在隔离库成功恢复一次后才允许生产apply。

## 4. 一对一回填

新增 `scripts/identity/backfill.ts`，支持resume。计划开始固定快照与scope revision；按主键keyset分页（默认100行），不用OFFSET。字符串offer ID必须配合快照manifest，不用MAX(id)当新增水位；在线增量由第二阶段双写，不能静默漏掉插在游标前的新ID。

### 4.1 确定性映射

从 `legacy:offers:<id>` 生成有命名空间的确定性entity ID（可用SHA256前32hex，编码前保留完整legacy key并检查碰撞）；旧offer ID本身保持不变。其evidence生成标注legacy provenance的观察，不能把旧capturedAt或页面hash当成今天重新抓取/核验。

每个旧offer生成当前存储事实的版本；只有能从原始证据/审核记录确认的字段标known，不能把模型历史猜测提升为官方明示。已批准版本的依据是现存审核与投影；缺历史详情时标 `legacy_approved_snapshot`，保留不确定性，不伪造审核员、时间或原文。

对旧reviews逐行保留legacy table/id键，导入review_decisions；旧rejected_offer_updates有decision_key则复用为导入key，没有则用表名+主键。旧revisions只在足够材料支持时重建版本关系，不用逐字段diff臆造完整过去状态。

### 4.2 未产生offer的拒绝线索

建立无canonicalOfferId的实体/候选与拒绝decision，source evidence保留。reason能明确映射的按第二阶段scope规则处理；无法分类为legacy_unclassified。缺reason的系统拒绝仅记“历史系统决定”，不可扩大为管理员的永久规则。

已linked线索有offerId时建立lead_candidate_links；resolution.offerIds多个时全部保留。无法确认原文包含哪一个优惠时保留未解决标记，不能编一个候选终态骗过计数。

### 4.3 幂等与检查点

每批将回填记录和checkpoint原子提交；崩溃重跑不得重复生成决定、观察或审核任务。checkpoint包括backfillRunId、snapshotHash、table、lastKey、processed、skipped、errors、code/schema versions。

业务投影、reviewState、公开金额/日期、lastVerifiedAt、notifications和deliveries在回填阶段逐字/逐值保持不变。新增任务默认只写审计建议表/报告，不能让“回填”把所有历史数据推回管理员队列。

## 5. 候选簇与不可变merge plan

新增 `scripts/identity/plan.ts` 调用第二阶段resolver，不重新实现相似度阈值。遍历用有界blocking：平台/真实产品/机制/轮次；输出召回截断、未知字段及冲突。图上的A≈B、B≈C不意味着A=C：每个成员都要与目标canonical比较，且成员之间不得存在已知冲突/not_same。禁止直接union-find所有相似边然后全簇合并。

一个merge plan至少包含：

```ts
interface HistoricalMergePlan {
  schemaVersion: 'historical-merge-v1';
  planId: string;
  snapshotHash: string;
  codeCommit: string;
  factsSchemaVersion: string;
  identityRulesVersion: string;
  policyVersion: string;
  createdAt: string;
  clusters: {
    clusterId: string;
    canonicalEntityId: string;
    canonicalOfferId: string | null;
    acceptedVersionId: string | null;
    members: { entityId: string; expectedRevision: number; legacyOfferIds: string[] }[];
    expectedScopes: { scopeKey: string; revision: number }[];
    rowGuards: { table: string; primaryKey: string; expectedBusinessHash: string }[];
    evidenceRefs: string[];
    reason: string;
    conflicts: string[];
    status: 'proposed' | 'blocked' | 'approved';
    expectedEffects: Record<string, number>;
    reviewedBy: string | null;
    reviewedAt: string | null;
  }[];
}
```

planHash为除hash字段外完整canonical JSON的SHA256；approve的是这个hash而不是文件名。服务器重读实际对象、验证权限与规则版本，不信任客户端提交的“approved=true”。任何canonical、成员、rowGuard或冲突处理变化都产生新plan版本并重新批准。

建议界面逐簇展示：原状态、主记录候选、条款并排diff、全部来源、拒绝理由和作用范围、人工编辑字段、当前提案、可能受影响通知/旧链接、是否可回滚。必须支持“不是同一活动”，并保存not_same，避免下一次扫描重复推荐。

默认单簇含完整现有等价组最多20个实体；超限标blocked_large_cluster。不得偷拆成20+20跨事务后声称原子合并。确需更大簇必须另设计有测试的维护流程，再授权执行。

## 6. 应用方式：逻辑合并，不删历史

### 6.1 主实体与旧ID

对每个loser设置 `state='merged'`、`merged_into_id=canonicalEntityId`，包括它已有的全部group成员，确保始终一跳到未merged的canonical。不建立环、不将主实体指向自己；目标合并组也必须属于plan中的完整成员集合。

entity_offer_links保留旧offer→原实体，读取时解析原实体→canonical；identity_aliases及历史版本/决定继续指向原实体，resolver按完整等价组读取。这样不需要批量改写历史source/review/delivery payload。

canonicalOfferId保持plan选择的现有公开投影；loser原offer行不删除、不伪造新的reviewState。所有公开查询必须通过canonical membership过滤，只显示主实体的canonicalOfferId。不能只改首页，遗漏 `/api/offers/:id`、平台页、RSS、日历、模型页或通知查询。

若所有成员都无approved，合并并不自动批准；若都是无offer拒绝事项，只统一拒绝实体与任务，不生成伪造offer。

### 6.2 条款版本与审核历史

完全等价的历史版本可在读取层视为同termsHash，但原versionId及其审核决定不删除、不重编号。不同hash保留差异；采用哪个已批准版本必须在plan中明确，并有真实批准依据。

当前批准版本定义为canonical实体等价组中被明确选定、未被后续批准取代的approve decision所指向的版本；不能简单取最新capturedAt或最高versionNo。Phase2若采用approved_version_id缓存，缓存必须与该决定在同一事务更新；缓存不是另一套权威。

重复理由的reject可转成逻辑link，原reject记录仍保留。政策拒绝与批准冲突必须先由管理员作supersede/reopen等明确决定；merge脚本不得私自“approved优先”消除冲突。

### 6.3 待审提案、任务与人工字段

完全相同version的重复待审任务只保留一项开放，其他追加resolved/link决定；在journal记原状态。不同版本不能合并为一项，人工编辑中的manualFields不得静默取任意一份。

不同人工字段冲突、两个独立pending proposals、同一活动不同轮次不能自动消解。plan为blocked，审核员先在常规审核中确认要保留/拒绝的版本，然后重做plan。不得把多个proposal.candidate简单对象spread后宣布完成。

已过时official/lead review job在apply时失效：scope/实体/task revision递增；旧worker提交必须409或deferred，不能把合并前读到的ID再写回新活动。

### 6.4 通知与旧链接

通知查询统一按canonical group去重。任何成员已发送的首次上架标记都算该实体已发送；pending/unknown delivery阻止同语义事件再次发送。原delivery payload、messageId、sentAt保持原样，不重写、清空或自动release。

合并不触发new/changed/ending业务通知。修正内部实体关联不代表优惠条款变了；仅真实批准新条款才生成changed事件。不能为了“清理重复”重发过去消息。

`GET /api/offers/:oldId`：旧公开ID通过alias返回当前获准公开的canonical offer，并带canonicalOfferId；若当前实体不可公开则404，不泄漏拒绝事实。未经公开的私有pending/rejected旧ID不能因alias关联就暴露内部存在性。前端`#offer-oldId`可replaceState到canonical，不循环导航；浏览器本地收藏/已领取状态按别名迁移并去重，保留用户原时间及状态，不清空localStorage。

缓存：使用新的response schema/cache namespace，并明确最多现有缓存TTL的过渡期。授权操作完成的验收要分别检查绕过缓存的源站结果与正常缓存结果；缓存仍旧不能当作“数据库合并失败”重复执行merge。暂停通知直至canonical读取与缓存版本部署确认完成。

## 7. 事务、维护闸门与journal

新增 `identity_merge_runs`、`identity_merge_journal`：

- runs：id PK、plan_hash UNIQUE、snapshot_hash、status planned/applying/completed/failed/rolled_back、created_by、approved_by、created_at、started_at、finished_at、summary_json。
- journal：id PK、run_id FK、cluster_id、operation_key UNIQUE、plan_hash、before_json、after_json、expected_after_revisions_json、state applied/rolled_back、applied_at、rolled_back_at；UNIQUE(run_id,cluster_id)。before/after记录所有被改行与新增行ID，正文/用户数据按访问控制保存。

不把整份生产库塞进journal；仅记录本簇改动快照与引用。journal写入与该簇修改同一事务，提交失败不能出现journal说成功但数据未改，或数据改了没有journal。

### 7.1 提交前

1. 验证plan approval/hash/版本、操作者admin权限、snapshot和目标环境；默认拒绝remote。
2. 用第二阶段scope机制把受影响scope置maintenance并递增revision；这一步记录维护owner/lease，防止进程中断永远锁死。默认维护lease10分钟，owner可续；过期恢复由显式reconcile执行，不默默允许旧apply继续。
3. 观察抓取可继续保存，但所有活动写入、管理员审批和通知选择都检查maintenance。已有任务不能绕过；未升级到新协议的写入者必须先停用。
4. 重读所有成员、原offer、task/proposal、人工字段、决定、delivery状态和row guards。任何不匹配则409/stale_plan，释放自己持有的闸门，生成新preview，不能强制跳过。

### 7.2 单簇原子应用

复用第二阶段 `commitResolution` 的mutation receipt与attemptToken模式，增加merge操作；一个D1 batch完成：本次receipt、全部实体指针/语义revision、唯一开放任务整理、merge decision、journal以及受影响scope revision。所有语句受同一plan/attempt和版本guard约束，最终SQL CHECK断言检查预期行数及一跳无环、公共canonical唯一性。

SQL失败整体回滚；guard零行全批无副作用；commit返回丢失时读receipt及journal，绝不重新生成operationKey重做。不同簇可以独立提交，但要报告逐簇状态，不声称整库全部原子。共享实体或scope版本受前簇影响的后续簇必须在plan中排序并更新经过批准的预期依赖，或重新preview；不能使用陈旧版本不断盲重试。

为简化第一版：一次apply执行一个已批准cluster；每次执行后对剩余cluster重新生成guard并要求确认更新后的planHash。不得在同一大plan中悄悄修改后续guards。自动化批量执行作为后续扩展，不属于默认验收。

参数≤100/SQL；避免成百上千ID的IN参数。一个簇超过可验证的事务/行大小预算时blocked，不能用跨请求分批拼出貌似原子成功。

### 7.3 完成与恢复

提交后验证数据库不变量、公开source结果和引用，再释放本操作scope闸门。进程中断留可恢复的receipt/journal和维护owner；`reconcile`读实际事务结果恢复run状态，绝不靠“运行时间已到”假定失败并重做。

保存before/after报告。notifications/deliveries历史数及body hash必须不变，公开canonical活动数只按已批准合并组预期减少。所有不相关实体的业务hash必须完全不变。

## 8. 回滚合同

新增 `scripts/identity/rollback.ts`，默认preview。必须指定runId/clusterId及expectedAfterRevisions；只回滚自己记录的行，不按标题找“相近对象”回滚。

可自动回滚条件：所有被改业务行仍等于journal.after；没有后续新批准/编辑/合并决定，且没有新增候选、任务或通知依赖本次关系。观察lastSeen计数可增加，不影响业务回滚，但新归属关系必须检查。

满足时，用同一事务保护恢复before指针、任务状态、alias语义及revision（revision继续递增，不能退回旧数值让过期job复活）；新merge决定不删除，而追加supersede/rollback决定，journal改rolled_back。回滚的运行历史保留。

不满足时返回409/dependent_changes，列明后续依赖，人工制定补偿拆分plan；禁止force覆盖后续工作。已发外部消息不能通过回滚“撤回”，只保留历史并防止重发。

代码回滚：Phase3 apply前可回到旧路径；apply后只能回到仍理解canonical/aliases的兼容版本。不能通过关闭IDENTITY_MODE直接恢复旧公开查询而让重复活动重新全部展示。新增表/列保留，紧急止血先停止身份写入及通知，不执行DROP或清空decision。

## 9. CLI与API验收合同

以下命令为将要实现的接口，不是当前已经存在的命令：

```text
npm run identity:audit -- --snapshot <local.sqlite> --out <dir>
npm run identity:backfill -- --snapshot <local.sqlite> --out <local-work.sqlite> --dry-run
npm run identity:backfill -- --snapshot <local.sqlite> --out <local-work.sqlite> --apply-local --resume <run-id>
npm run identity:plan -- --db <local-work.sqlite> --out <dir>
npm run identity:apply -- --db <local-work.sqlite> --plan <approved.json> --cluster <id> --expected-plan-hash <hash> --apply-local
npm run identity:verify -- --db <local-work.sqlite> --journal <run-id>
npm run identity:rollback -- --db <local-work.sqlite> --run <id> --cluster <id> --dry-run
```

将参数schema集中到 `scripts/identity/args.ts`。所有读写默认local；没有--apply-local时不修改SQLite输入，输出到新文件。未知参数、缺hash、snapshot不一致退出非零。运行报告必须区分planned/applied/skipped/blocked/failed，不用一个ok:true掩盖部分失败。

生产工具不直接发任意SQL；通过admin认证的服务端业务接口：`POST /api/admin/identity/merges/preview`、`/:planId/approve`、`/:planId/apply`、`/:runId/rollback`。apply要求operationKey、clusterId、expectedPlanHash及环境确认；reason和权限必须服务端验证。reviewer只可读preview/提出建议，不可apply/rollback。未实现且未获授权前，CLI传--remote必须明确拒绝。

preview是纯读取，不产生merge、发送消息或清除队列；approve仅固定plan，不立即apply。失败日志脱敏，不记录Authorization/管理员令牌。

## 10. 测试矩阵与生产放行

所有测试先在脱敏fixture及本地SQLite执行实际业务仓库，再在获授权的隔离D1验证事务与索引。不得为了测试调用真实收集、官方模型或真实机器人。

| ID | 用例 | 必须结果 |
|---|---|---|
| P3-01 | fresh库 / upgrade至Phase2后回填 | 一对一映射，公开业务值不变 |
| P3-02 | 回填重复运行/任意批次中断恢复 | 无重复决定或实体，checkpoint一致 |
| P3-03 | 新ID落在keyset游标之前/导出不完整 | 不静默漏数，manifest检查失败或双写覆盖 |
| P3-04 | 2个不同ID、同已批准优惠 | preview不写；确认后公开只一项，旧链接可访问 |
| P3-05 | approved与duplicate-rejected别名 | 保留历史拒绝，指向明确主实体 |
| P3-06 | approved与policy-rejected冲突 | blocked，必须先明确决策 |
| P3-07 | 学生/企业、地区、产品、轮次、积分池不同 | 不合并 |
| P3-08 | A近似B，B近似C，但A冲突C | 不做传递误合并 |
| P3-09 | 同URL多个优惠 / legacy复合记录 | 不按URL合并；复合记录blocked |
| P3-10 | 两个不同人工proposal/manualFields | blocked，不覆盖字段 |
| P3-11 | 执行前管理员修改、采集更新、旧job返回 | stale_plan/409/deferred；不产生部分写入 |
| P3-12 | 并发apply同cluster/相同operationKey | 只一次journal/merge/任务整理 |
| P3-13 | batch每一步故障或guard零行 | 全部回滚或无写，原offer完整 |
| P3-14 | commit成功但HTTP超时后重试 | 读回同receipt，不重复操作 |
| P3-15 | pending/unknown/sent通知存在 | 不重发、不删回执，body/messageId不变 |
| P3-16 | 所有公共API/页面/旧fragment/收藏 | canonical一致，内部拒绝字段不公开 |
| P3-17 | >20实体/参数或事务预算超限 | blocked，不私自拆成非原子合并 |
| P3-18 | 回滚未发生后续业务写入的merge | 恢复归属/任务，revision递增，历史不删 |
| P3-19 | 合并后有新审批/编辑/依赖 | 自动rollback拒绝，给补偿清单 |
| P3-20 | 非admin或篡改planHash | 403/409，零副作用 |
| P3-21 | 死进程维护lease过期 | reconcile可恢复，不假定commit失败重做 |
| P3-22 | 不相关平台/条目 | 业务hash逐项不变 |
| P3-23 | 合并后换语言、页面、ID再抓同优惠 | 命中原实体/拒绝，不新增审核卡 |
| P3-24 | 合并后真正新轮次或真实条款变更 | 仍产生正确新实体/提案，非永久封禁 |
| P3-25 | 浏览器/边缘缓存仍旧 | 不重复执行merge；TTL/namespace后收敛 |
| P3-26 | 公共旧ID当前已不可公开 | 返回404，无内部存在性泄露 |

放行顺序：完整备份恢复演练通过 → 100%行为矩阵通过 → 一组人工确认的低风险数据在隔离库apply+rollback通过 → 单一平台小批人工确认并另行授权生产 → 每簇前后核对 → 再扩大范围。

最终报告必须给出实际处理/阻塞数量、canonical映射、保留/关闭的任务、未解决冲突、回滚runId、通知未发送证明和使用的代码/schema版本。不得以“测试通过”推断已部署，不得以“去掉N条重复”推断去重算法今后零漏判。

## 11. 实施文件清单

新建：`scripts/identity/{args,audit,backfill,plan,apply,verify,rollback}.ts`；`src/worker/identity/merge.ts`及admin路由；对应tests和脱敏fixtures；增量migration及Drizzle schema；阶段runbook。

修改：第二阶段repository/resolver的group-aware读取；所有公开offer/平台/RSS查询；admin队列与buildNotice；前端旧ID与本地收藏映射（先检查web实际文件，不能凭旧审查猜文件名）；package scripts；docs索引及data-contract。

不修改：真实通知内容/历史payload、现行收录口径、真实审核状态的历史记录、令牌/密钥、生产快照、已存在migration文件。外键变化先生成计划，不使用foreign_keys=off掩盖不一致。
