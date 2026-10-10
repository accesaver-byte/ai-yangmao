# SPEC v1.0 — 第三阶段：历史回填、重复合并与可逆发布

状态：待实施，不代表已经扫描或更改生产数据。日期：2026-10-10。
依赖：`2026-10-10-dedupe-phase2.md`。基线：PR #2及main `7cea69d95d2c27e2c1ebd7641a94bab2a696901d`，执行前重新核对实际最新版本。

## 0. 两个独立子阶段

P3-A基础回填：为旧offers、已拒线索、提案与审核记录建立身份/版本/决定映射。每条旧offer先独立映射，不进行语义合并。这部分是第二阶段enforce的前置条件，可在第二阶段schema与兼容reader完成后实施。

P3-B重复合并：在统一resolver和所有writer/readers/通知均已适配后，生成候选合并计划，经管理员确认再修改关联。不能把“回填字段”暗中升级成“自动清理全部历史重复”。

目标是从历史数据中恢复稳定活动身份、审核依据和来源，保留旧ID和审计，避免旧重复污染前台统计与未来审核。不是批量删除记录，也不是重新批准所有候选。未经明确生产授权，只允许本地/测试环境实现、只读快照分析和dry-run。

## 1. 必须保持的不变量

- H01：每条原始offer、lead、revision、review、rejected update和delivery可追溯到原对象；不物理删除已审核历史。
- H02：相同金额/标题/URL不构成充分合并依据；不同地区/产品/积分池/资格/轮次有反证时不自动合并。
- H03：每个正式合并有不可变plan、planHash、操作者、理由、输入版本、before/after映射和结果。计划是审批对象。
- H04：新来源不能改变主记录选择；主记录不是“最新抓到”或“模型觉得文案更好”。
- H05：公开内容冲突、待审提案冲突、相互冲突的拒绝决定、在途/未知消息存在时，自动合并必须停止并生成具体人工任务。
- H06：迁移可暂停/恢复；同一操作重试不重复创建实体/决定/通知；旧计划在数据改变后必须返回冲突。
- H07：合并不触发新上架、临期、变更或重新审核通知；通知抑制不能以伪造已发送消息实现。
- H08：回滚只恢复本次修改的身份关联/投影，不覆盖后续人工编辑，不清空拒绝记忆；有新编辑时进入人工恢复而非强制反写快照。
- H09：写入口和审核使用同一个实体版本栅栏。不能用“暂停某一个Actions”假定不存在管理员、手工脚本或其他写入者。
- H10：未知证据、状态或关联必须显式记录，不以默认值制造已核验事实。

## 2. 前置能力和角色

实施P3-A前：第二阶段增量schema、双读兼容、版本化normalizer、幂等命令和本地数据库适配已完成；第一阶段0016迁移已包含在目标测试库。
实施P3-B前：第二阶段统一resolver、全入口写保护、canonical读取与旧ID解析、任务/业务事件账本已完成；shadow表现经过审查。没有这些能力，合并后旧流程可能立刻重新制造重复。

分析与生成plan：可在脱敏本地快照上执行；不会更新业务数据。
审核plan、执行生产merge/unmerge：仅管理员；reviewer不能通过现有补录/编辑接口获得此权限。
代码提交、PR合并、schema迁移、数据回填、数据合并、部署与消息发送是不同授权，不能互相推导。

## 3. 工具和交付文件

建议新增：

- `scripts/identity/export-snapshot.ts`：受控导出；默认不读取.prod.secrets，必须显式指定环境与目标。
- `scripts/identity/inventory.ts`：只读盘点和完整性检查。
- `scripts/identity/backfill.ts`：P3-A本地演练/受控回填。
- `scripts/identity/plan-merges.ts`：只读生成候选plan与HTML/Markdown摘要（不执行）。
- `scripts/identity/apply-plan.ts`：只执行已确认、未过期、版本匹配的指定plan/group。
- `scripts/identity/unmerge.ts`：生成和执行受版本保护的撤销计划。
- `src/worker/identity/merge.ts`：唯一的合并事务服务；CLI和admin API共同调用。
- `tests/identity-backfill.test.ts`、`identity-merge.test.ts`、`identity-public-projection.test.ts`及fixtures。

CLI至少支持`--db <local.sqlite>`、`--dry-run`（默认）、`--out <private-dir>`、`--cursor`、`--limit`、`--plan <file>`、`--group <id>`。本地路径缺失时报错，不能默认接生产。写模式需显式`--apply`与planHash；生产还需匹配环境标识及服务器签发的管理员批准记录。

禁止在普通CI/开发脚本中自动加载.prod.secrets或访问真实模型/生产DB。工具日志只输出计数、hash和脱敏对象ID，不输出token、私有正文、管理员备忘录或用户数据。

## 4. 一致性快照与只读盘点

### 4.1 快照

生产导出只能在明确授权后执行。优先使用平台支持的一致性数据库导出/备份机制，并记录导出方式、时间、目标数据库标识、schema版本、应用提交和文件SHA-256；不能把多个时间点的分页接口结果冒充事务一致快照。

无法获得一致性快照时，记录每行业务revision与采集时间区间，将输出标记为analysis_only；apply时必须逐组从权威库重新核对。备份文件不得提交GitHub或上传公开artifact；处理完按用户的数据保留要求处置。

### 4.2 盘点范围

读取offers、platforms、sources、leads及resolution、offer_proposals、offer_revisions、reviews、rejected_offer_updates、notifications、deliveries；以及第二阶段新身份/版本/任务表。不得只读取approved，因为拒绝和未上架线索正是本次记忆修复的对象。

输出`inventory.json`，包含：

```json
{
  "schemaVersion": "identity-inventory-v1",
  "snapshotId": "sha256:...",
  "sourceCommit": "...",
  "schemaMigrations": [],
  "counts": { "offersByReviewState": {}, "leadsByStatus": {}, "proposals": 0, "rejectedUpdates": 0 },
  "integrity": { "orphanRefs": [], "invalidJsonRows": [], "invalidDates": [], "conflictingPrimaryLinks": [], "unmappedRows": [] },
  "deliveryBlockers": [],
  "normalizerVersion": "benefit-facts-v1"
}
```

检查外键、JSON、重复URL、异常日期、孤立proposal、linked却无目标、resolution多目标、过时提案、同短码多对象、已拒却有公开任务、疑似同活动多个approved，以及pending/unknown投递。发现问题不直接修正，列出分类和逐项处置建议。

## 5. P3-A：保守基础回填

### 5.1 offers

为每条尚未映射的旧offer生成独立Entity及primary membership；保留现有offer.id不变。幂等导入key为`legacy:offer:<id>`，重试查已存在映射，不再新建。即使标题相同也先分别建实体，语义合并在P3-B处理。

从已存字段生成facts-v1；明确已审核的字段按现有事实保留，原文无法支撑的归一化细节标记unknown/legacy_reviewed，不伪造sourceText或官方时间。title/valueText保留在公开旧行，normalizer不能静默改写它们。估值V1保持原样，不用于身份决定。

approved行建立当前批准版本并指向它；pending行建立草稿版本与一个first_review任务；rejected行建立exact_version决定。withdrawn/ended是生命周期，不改成rejected。已有待审proposal映射为同Entity的变更任务，当前approved仍为旧版本。

### 5.2 reviews、revisions和rejected updates

以`legacy:review:<id>`、`legacy:revision:<id>`、`legacy:rejected-update:<id>`作为导入幂等键。保留原actor、时间、理由、reasonCode、diff与来源。旧review记录没有足够字段重建当时完整条款时，保存原始引用并标记legacy_partial；不得从今天的offer反推出当时的完整政策。

旧拒绝范围无法可靠恢复时，scope=exact_version或legacy_unknown，需要管理员确认才能推广到entity_policy。rejected_offer_updates有证据与diff时建立相应拒绝版本/决定；不能只以当前页面仍出现旧句就封禁此实体所有未来条款。

管理员历史编辑和正在编辑的proposal.manualFields分别保留。manualFields不能在导入时被清空，也不能误当作原始官方事实。

### 5.3 没有offer的拒绝线索

为有明确拒绝依据但没有offer的lead创建未公开Entity或identity_case，保存原URL、resolution、理由和规则版本来源。只有字符串“模型判断不是羊毛”的旧线索，不能自动转换成整个产品的永久拒绝规则。

多个看似相同的拒绝lead先分别导入，后续可作为候选簇人工确认；同一URL已知的明确决定可以作为有限来源记忆，但不得绑定页面上所有其他权益。

### 5.4 观察与通知基线

将历史evidence和可用snapshot关联为Observation，记录imported=true、真实capturedAt是否已知。历史转载不能刷新lastVerifiedAt。多个offer共享一个页面时可以共享Observation，但保留独立candidate/版本关系。

导入既有notifications和deliveries到business_event_receipts的兼容视图/记录：sent保持已发送，pending/unknown保持阻塞；缺证据的旧状态标legacy_unknown。不得制造新的messageId或把未发送历史假设为已发送。

### 5.5 回填算法

按PK分页；默认每批50条，事务规模按当前D1限制再收紧。checkpoint含snapshotId、表名、lastPrimaryKey、normalizerVersion和计数。单行冲突记异常并保留，不整批强覆盖。每个导入对象在受幂等键约束事务中完成映射和关联；故障后继续游标不会漏掉未提交行。

回填期间发生新写入，统一writer直接创建新映射；backfill遇到已映射行只校验，不覆盖。对于来源快照已过时的行，按最新revision重新导入或记录冲突；不得把旧快照覆回线上。

验收P3-A：所有可解析旧offer都有一个membership，primary唯一约束通过；导入两次计数不增加；公开列表内容/数量/排序和通知状态与回填前相同；未知历史被明确标识。

## 6. P3-B：生成候选合并图

### 6.1 召回与边

复用第二阶段resolver，不另写一个离线相似度阈值系统。节点是Entity/旧offer映射，边记录SAME_ENTITY、DISTINCT_ENTITY或UNRESOLVED及证据。

不得直接对所有“相似边”的连通分量做union-find合并：A像B、B像C不保证A与C同活动。一个可执行组必须对主记录与每个成员证明同身份，并检查组内任意已知负关系/资格/轮次冲突；存在冲突整组转人工，不能用传递性覆盖反证。

### 6.2 三类计划

SAFE_IDENTITY：有共同已验证官方活动锚点/已确认别名，条款与范围兼容，主记录明确，无在途任务/消息冲突；可以推荐合并，但生产仍需批准plan。
REVIEW_REQUIRED：语义很像但锚点不足、不同版本、多个approved内容冲突、存在人工编辑/提案冲突或拒绝范围冲突；生成具体问题，不执行。
KEEP_SEPARATE：已知不同发放方/产品/积分池/资格/事件等，保存negative relation；后续同一证据版本不再次推给管理员。

计划中明确“同实体不同版本”与“同版本重复行”。新旧政策不能揉成一组看起来更丰富的offer；不同官方生效顺序未知则人工判断。

## 7. 主记录选择规则

按顺序判定，不是简单评分：

1. 有管理员已经指定的canonical且证据不冲突，沿用它。
2. 只有一条approved且其他为相同版本的pending/rejected-duplicate，优先保留approved。
3. 多条approved：先核对是否同版本、相同权益范围、人工确认和有效性一致；不一致则REVIEW_REQUIRED。确认一致后优先有可靠人工确认及完整证据的记录，再按最早真实discoveredAt，最后用字典序ID作为稳定tie-break。
4. 全部pending：只合并已证明同身份的任务，保留人工字段最多且证据可靠的稿；冲突需人工。合并本身不批准。
5. 全部rejected：合并身份与决定，不创建公开条目；不同拒绝理由与scope都保留。
6. approved与非duplicate拒绝相冲突：必须人工判断拒绝是旧误抽、不同范围还是当前收录政策，不能仅因approved优先而忽略拒绝。

同一活动的主ID一旦确认，不因后续语言、标题润色或新来源改变。保留每个原offer的字段与原始ID作为历史，不能通过“取所有非空字段的并集”生成未经审核的新公开事实。

## 8. 合并计划合同

`merge-plan.json`必须使用稳定序列化后计算SHA-256；人工批准的是该hash，不是一个可任意修改的路径。除displaySummary外的执行内容均参与hash，任何成员/动作/版本改变使原批准失效。

```ts
interface MergePlanV1 {
  schemaVersion: 'identity-merge-plan-v1';
  snapshotId: string;
  environmentId: string;
  sourceCommit: string;
  resolverVersion: string;
  normalizerVersion: string;
  ruleVersion: string;
  createdAt: string;
  groups: Array<{
    groupId: string;
    classification: 'SAFE_IDENTITY'|'REVIEW_REQUIRED'|'KEEP_SEPARATE';
    canonicalEntityId: string;
    canonicalOfferId: string|null;
    members: Array<{ entityId: string; entityRevision: number; offerId: string|null; offerUpdatedAt: string|null; proposalRevision: string|null }>;
    expectedPlatformRevisions: Record<string,number>;
    relationshipEvidence: Array<{ left: string; right: string; relation: string; evidenceRefs: string[]; reason: string }>;
    blockers: string[];
    effects: { membershipMoves: string[]; taskActions: object[]; decisionLinks: object[]; notificationActions: object[]; publicContentChanges: [] };
  }>;
}
```

默认`publicContentChanges`为空。合并需要修改公开条款时，拆成独立的正常审核提案，不能藏在merge plan里。

另输出管理员摘要：保留谁、关联谁、证据是什么、哪些旧ID将解析到主ID、预计公开计数变化、是否有待审/拒绝/投递冲突、可否撤销。摘要不输出密钥或完整私有备忘录。生产plan、before-image与数据库快照属于私有操作材料，不提交源码仓库。

## 9. 逐组原子执行

新增`identity_merge_operations`：operation_id UUID PK、command_key UNIQUE、plan_hash、group_id、environment_id、actor、reason、status applied/reversed、before_image JSON、after_image JSON、created_at、reversed_at；同一planHash+groupId建立唯一约束。未成功执行的尝试另记诊断，不假写applied。

执行步骤：

1. 检查管理员批准记录、planHash、environmentId及本次明确授权。仅执行SAFE_IDENTITY且无blocker的指定组；REVIEW_REQUIRED不得靠--force绕过。
2. 重新读取所有成员、platform/entity revision、proposal、当前决定、任务和投递。任一影响身份/内容/审核/发送的版本与plan不符，整组409并要求重新规划。
3. 检查成员是否已被合并、是否会形成循环、是否有历史negative relation、是否跨错误产品。不要依赖旧计划中的检查结论。
4. 用第二阶段的条件batch：首条登记本次operation，条件是全部预期版本成立且operation未应用；后续每条均依赖该operation成功创建。任一SQL失败全量回滚；首条零行时后续全部无副作用。
5. 把alias的offer_identity_links关联到主Entity，role改alias；保留唯一primary。非主Entity置merged并记录mergedInto，扁平指向根，禁止循环。
6. 保存before/after关联、导入来源和决定关系、处理已明确允许的任务动作和事件抑制，再递增所有相关revision。返回逐组receipt及实际变更数。
7. 不修改offers原始公开字段，不DELETE旧offers，不改写历史review/revision/delivery原记录。之后所有读写通过canonical解析；真正需要物理迁移引用只作为未来独立项目，不属于本阶段。

每组上限20个实体作为工程默认；超过时分为待管理员确认的小组或专门大组方案，不能简单截断组后执行部分含糊关系。一次batch参数/SQL数按实际D1限制验证，禁止拼接未验证值；可用参数化json_each传ID集合。

这里选择“保留旧行＋逻辑引用映射”，而不是删除后全库改外键：可保留旧ID、恢复审计、降低回滚风险。所有仍读取raw offerId的代码都必须适配，这是P3-B的上线前置门槛，不允许边合并边猜测调用方。

## 10. 各关联对象的明确处理

### offers与公开读取

列表/统计只选primary且approved、平台approved的记录；所有别名的approved原行仍留库但不重复计数。旧详情ID通过membership解析到根主offer；根没有approved主记录时公共接口404，不泄露拒绝对象。SPA hash、RSS旧guid、书签继续可解析；新RSS/new通知使用主ID，不为alias重新发稿。

生命周期取主记录真实审核结果，不能用“某个别名尚未过期”自动延长优惠。当前主记录若evidence_missing、已撤回或历史日期未知，不因别名合并自动恢复可领或补日期。

### leads与多目标resolution

保留lead.offerId和resolution.offerIds原值用于审计；运行时统一resolveCanonicalIds得到去重后的主ID集合，后台同时能查看originalIds。不能只处理第一个offerId。一个lead涉及多个独立活动时，合并其中一项不得把其余目标吞掉；未解决候选继续保留。

### offer_revisions与reviews

原记录继续指向原offerId，不改原actor、时间、diff和证据。主Entity审计页按membership聚合展示，标明原对象。展示排序按真实时间和稳定ID；不能拿不同对象的revision数字大小推断生效顺序。

### offer_proposals与人工字段

有未决proposal默认是blocker。只有候选版本事实完全相同、manualFields无冲突且计划明确列出task合并动作时，允许保留一个主提案，其他提案转为有审计的superseded任务；不把两份不同候选字段无审核地合成一份。不同manualFields值或不同条款版本必须交正常审核解决后重新生成merge plan。

### 拒绝决定

原决定保持原target及scope；通过实体关系提供可检索视图，不能把exact_version拒绝自动扩大为整个主Entity拒绝。拒绝duplicate别名则关联主Entity，其他理由若互相冲突列blocker。legacy_unknown不因合并变成永久政策。

### 通知、在途发送和历史静默

- 已发送通知保持实际delivery/messageId，关联到主Entity的历史事件视图；未来new事件检查主记录和所有alias历史收据。
- pending/unknown投递是blocker。先由管理员在现有送达台账核对，不在merge中擅自标sent/released或删除。合并批处理中也要检查这一点，不能只在plan阶段检查。
- 没有历史发送证据的旧活动，合并不能伪造sent。需要防止迁移后突然发送时，建立`migration_suppressed`业务基线事件，明确标“仅抑制迁移回放，未曾确认发送”，与真实sent区别保存。business_event_receipts若第二阶段枚举没有此状态，实施时增加独立suppression表/字段并同步类型；禁止借用sent。
- 已经真实出现的新条款或新的审核任务仍可按新版本发送，不能用一个永久entity黑名单抑制所有未来事件。
- 飞书每日常驻榜维持既有日常展示；alias合并只去掉同一榜单内的重复，不取消合法每日重现。

## 11. 中断、并发与幂等

导出、盘点、plan生成、apply为四个不同命令；plan生成完全只读。批次checkpoint含成功groupIds和各receipt，不把“开始处理”当作“已合并”。响应超时先通过operationId/planHash+groupId查收据，不盲重放非幂等写入。

测试至少覆盖：两个merge争抢同一alias、管理员编辑/拒绝期间apply、采集新候选期间apply、pending消息在plan后出现、同plan执行两次、执行半途进程退出、D1条件首条0行、audit/映射中途失败和缓存尚未过期。

并发写发生时优先返回冲突而非覆盖。使用全入口的identity_write_state，不单靠GitHub concurrency。更严格维护窗口可以是运维选项，但不能替代版本检查。

## 12. 撤销合并与回滚

`unmerge`也先生成plan，必须引用明确operationId与其after-image。默认dry-run，生产需要单独授权。

可以自动逆向的范围：本次membership、mergedInto关系、任务聚合和migration suppression，且当前revision仍等于该operation执行后的预期revision。旧原始行从未删除，因而不需猜测重建。

有后续新的批准、编辑、版本、决定、alias或发送时，不允许整包恢复before-image。生成REVIEW_REQUIRED恢复计划，说明哪些关联能拆、哪些新事实必须保留。不能回滚到“重新发送历史消息”的状态；真实送达账本永久保留。新候选和拒绝记忆也不能因unmerge丢失。

撤销通过新operation与Decision审计，原merge保持历史applied并标reversed引用，不删除原操作。撤销后重新跑canonical完整性、公开投影和消息抑制验证；禁止直接SQL批量置空mergedInto作为恢复方法。

应用代码回滚与数据unmerge分开：若已合并数据，回滚到完全不理解membership的旧reader会重新展示重复。发布包必须有兼容降级路径：停新resolver但保留canonical过滤；或先受控unmerge，再回滚reader。不能默认“关feature flag就安全”。

## 13. 发布步骤及试点门槛

本SPEC不授权以下生产操作，只规定获得授权后的执行顺序。

1. 在全量脱敏快照上运行inventory/backfill两次，确认幂等、外键和公开行为不变。
2. 运行plan-merges，人工标注样本：同活动改写、不同资格、已拒无offer、不同轮次、多个approved、提案和通知冲突必须覆盖。
3. D1 staging演练与生产schema一致，执行apply、重复apply、故障注入、unmerge；验证完整读写链路而非仅SQL表计数。
4. 经授权备份生产、部署兼容schema/reader/writer；先P3-A映射回填，不合并。
5. identity V2 shadow与指标审查通过后，选择最多10个SAFE_IDENTITY组作为第一批；管理员逐组批准planHash。
6. 对账所有公开入口、审核任务、拒绝记忆和通知预览；确认没有生产消息被本操作发送。
7. 观察至少两个真实采集周期的重放行为，再批准下一批。这里是运维验收条件，不要求执行代理等待或后台运行；每批交付receipt，由操作者决定下一批。
8. 所有迁移/计划/receipt在私有操作目录保留，源码只提交工具、schema、合成fixtures、脱敏总结和运行指南。

停止条件：任何错误合并、公开字段意外改变、重复new通知、拒绝记忆无法追溯、孤立外键、提案冲突未被阻塞、无法读回operation收据。出现即停止下一组，不用扩大阈值或--force继续。

## 14. 验收矩阵

| ID | 输入/故障 | 必须结果 |
|---|---|---|
| B01 | 同一快照连续回填两遍 | 映射/版本/决定数量稳定 |
| B02 | 回填一半崩溃后继续 | 无漏行、无重复、checkpoint可信 |
| B03 | 同URL多个权益；同标题不同资格 | 不误合并 |
| B04 | A~B、B~C但A与C有冲突 | 不把连通分量全部合并 |
| B05 | 一条approved+同版pending/rejected duplicate | 保留approved主ID，来源/决定可追溯 |
| B06 | 两条approved条款/有效性不一致 | REVIEW_REQUIRED，公开内容不变 |
| B07 | 全rejected且从未有公开offer | 只统一身份记忆，不创建公开权益 |
| B08 | 不同日期/同日独立重置 | 独立轮次不丢失 |
| B09 | proposal.manualFields冲突 | apply被阻止，不能默默取并集 |
| B10 | resolution关联三个offer，只合并其中两个 | 第三个仍在，原IDs可审计 |
| B11 | sent/pending/unknown通知混合 | sent保留；pending/unknown阻止merge；不伪造送达 |
| B12 | 缺历史发送记录但不应迁移回放 | 明确suppression，不伪造sent |
| B13 | 计划后有人编辑或新增投递 | 整组409，无部分迁移 |
| B14 | 同一plan/group重复执行 | 同receipt，无额外决定/事件 |
| B15 | audit或关联写入中途失败 | 整组回滚 |
| B16 | unmerge前无后续变更 | 还原本次映射，审计完整 |
| B17 | unmerge前有新批准/发送 | 不覆盖新事实，生成恢复判断 |
| B18 | 旧ID从详情、SPA、RSS链接进入 | 已批准主ID可达，私有状态不泄露 |
| B19 | 今天/日历/平台/模型/统计/RSS全部读取 | 同一活动计一次，独立活动数量不降 |
| B20 | 合并后来源重放20次、换ID/语言 | 不重建旧别名活动或审批卡 |
| B21 | 合并后合法新政策/新一轮活动 | 正常产生变更任务/独立活动，不永久压制 |
| B22 | 已合并数据下关闭新resolver | canonical reader仍有效，不恢复重复显示 |

全套typecheck、npm test、build:web和git diff --check均须通过。新增SQL测试运行真实约束；D1 staging验证batch事务与生产差异，不能把SQLite全绿等同于已验证线上。

## 15. 完成交付

交付包含：只读inventory工具、幂等backfill、带证据与版本的merge plan生成器、受权限/版本保护的apply/unmerge服务、旧ID解析和所有读取方适配、通知历史桥接、测试与合成fixtures、操作手册、试点审查模板、回滚清单。

执行结果必须分开报告：代码已写、测试已跑、PR已提交/合并、schema已迁移、数据已回填、哪些组实际合并、Worker已部署、线上已核验。没有完成的环节不能用“全部修好了”概括。不得把本SPEC中的示例计数或工程门槛当作生产实测效果。
