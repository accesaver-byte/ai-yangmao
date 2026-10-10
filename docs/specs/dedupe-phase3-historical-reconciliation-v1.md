# 第三阶段 SPEC：历史重复回填、审核决定归并与可逆合并 V1

状态：待 Codex 实施的设计，不是生产清理指令。日期：2026-10-10。
前置：[第二阶段身份机制](dedupe-phase2-identity-and-decisions-v1.md)已实现并通过测试；生产执行另需用户授权。执行入口：[Codex 分阶段交接](../plans/dedupe-phase2-3-codex-handoff.md)。

## 0. 目标、非目标及权限

目标：将过去因不同来源、ID、语言、措辞而产生的重复活动映射到同一主实体；保持公开数据准确、旧链接可用、拒绝记忆连续、人工修订不丢、统计不重复、通知不重发，并可在误合并时恢复。

本阶段不是DELETE重复行的SQL脚本。保留offers/reviews/revisions/rejected_offer_updates/notifications/deliveries的原始记录和外键；通过持久实体关系、主投影、版本等价和审计日志完成逻辑归并。没有明确来源或决定冲突时输出待判断报告，不能凭相似度自动删除。

Codex可在隔离环境实现工具并运行本地fixture。读取生产导出、生成含真实历史数据的报告、执行线上回填、修改平台/活动状态、通知处理、部署和远程D1迁移分别需要授权。默认dry-run、禁用生产写入、禁用外部模型/抓取。用户给SPEC不等于允许清生产库。

非目标：修正所有历史金额/文案、重新审核全部优惠、将过期活动标拒绝、重新发送旧通知、变更收录规则、清理账号资料或重建全站数据库。

## 1. 必须保持的不变量

1. 合并是身份关系变更，不是批准、拒绝、官方核验或活动延期。
2. 旧offer ID永久可解析；主实体未公开则旧链接也不能泄露被拒或内部记录。
3. 同一真实活动公开列表/计数/金额合计出现一次；独立活动保留，不能只因金额相同归并。
4. 所有人工决定和修订保持原ID、原时间、原作者、原值；不得改历史action为system假装重新审核。
5. 同一实体不同事实版本的批准和拒绝可以同时存在；不得将拒绝旧版本误解释为全实体拒绝，也不得由某旧approve覆盖后来明确下架。
6. 已发送、待回执、结果未知的消息记录不丢；合并不能制造新通知或把unknown当failed重发。
7. 候选报告、执行计划、实际提交、回滚报告可对账；每次写入有commandKey、planHash、前置版本、结果与逆操作依据。
8. dry-run没有业务或运维写入，也不消费模型预算；日志只在工作目录。apply必须显式选择环境、计划和确认摘要。
9. 任何一项guard失败不得部分合并；执行中止后重跑幂等，数据库异常全部回滚。
10. 并发人工操作优先；发现审核中任务或新版本变动，停止该组并输出冲突，不能自动重读后替用户确认最新版本。

## 2. 基础盘点与固定输入

### 2.1 盘点对象

至少包含platforms、offers、leads、offer_proposals、offer_revisions、reviews、rejected_offer_updates、notifications、deliveries，以及第二阶段entity/offer映射、versions、observations/candidates、anchors、decisions、tasks、operations和索引版本。正文不是必须全量导出，保留引用hash和最小必要证据；不导出tokens、.prod.secrets、用户个人资料或通知接收人凭据。

报告按状态和平台给记录数、distinct旧ID数、entity映射覆盖、孤儿引用数、活动数/版本数/决定数、进行中任务、pending/unknown投递、缺官方证据数、潜在重复组数。观察行数多不等于重复活动多。只报告本快照，不能由文件名推断当前生产数量。

### 2.2 一致快照

推荐在获授权的维护窗口暂停身份写入和相关通知claim，导出固定快照。数据库备份/恢复能力需在环境中验证，不依赖口头保证或假定所有套餐有相同保留时间。保存schemaVersion、代码SHA、identity规则版本、导出时间、表行数、每文件SHA256、备份位置标识；不记录访问密钥。

不能用随时变化的库执行长时间OFFSET分页后声称同一快照。离线snapshot manifest列出待回填主键和行指纹；分块迭代这个不可变清单。仅记字符串最大ID会漏掉后来插入且字典序较小的UUID，禁止。运行期间变更通过显式增量清单另跑或重新导出；两种数据不混为同一验收批次。

## 3. 一对一回填，不先做语义合并

第二阶段初始化和本阶段工具共享幂等backfill实现：

- 每条legacy offer建立唯一legacy映射，保留原ID、状态、discoveredAt、publishedAt、lastVerifiedAt、withdrawnAt和完整人工字段；不得重新生成日期。
- 规范化事实尽量来自已审核字段及原证据。不能从美元估值倒推原积分或擅自补资格。原文不能定位时标legacy_unverified/unknown。
- approved条目的初始批准版本与原公开值一致；pending proposal为独立候选版本和任务；拒绝updates建立针对其具体facts/evidence的legacy决定，找不到事实就保留原证据范围而非无限封禁。
- reviews逐条导入决议并存legacy_review_id唯一。只有明确有对象的duplicate理由能自动link；理由里只有“重复”无目标ID时输出人工核对，不猜最近的一条。
- 无offer的rejected lead可建立provisional entity及窄范围decision。linked leads保留关联，部分多权益丢失的关系只从现有证据恢复，不编造。
- 引用多条offer的JSON字段必须盘点，包括lead.resolution.offerIds、proposal.candidate、delivery.payload及历史CLI链接。保持原历史JSON，新增读时canonical解析；不得全局字符串replace旧ID，避免改动原文引用。

backfillBatchSize默认100条，高参数写入按每条/小批生成SQL并遵守D1限制。每条使用legacy主键唯一和原revision/rowHash验证；失配进入conflict，不覆盖。进度记录`jobId,manifestHash,chunkIndex,lastInputKey,counts,errors`，只在该块成功后推进。重复运行相同manifest不会重复产生versions/decisions。

## 4. 候选发现：召回不等于合并

### 4.1 分类

候选分四类：

- **可确认重复**：已确认活动锚点/人工same-entity关系，事实等价，无scope冲突。
- **疑似重复**：跨语言/来源事实接近，但活动范围/轮次等尚不明。
- **同实体不同版本**：有官方修订/延期关系，不能丢失任一版本。
- **禁止自动归并**：产品、资格、地区、设备代际、独立池或发放轮次存在冲突；或存在相互矛盾的人工决定。

工具必须列出所有类，不只输出准备合并的组。已有相似度算法可辅助召回，最终关系复用第二阶段服务。不得写另一套只用于清库的简单SQL标题匹配。

### 4.2 禁止相似度传递聚类

A像B、B像C不代表A与C同一活动。每个成员必须与所选canonical满足同活动证据，并检查组内已知冲突；必要时全对比较。疑似链不自动做union-find闭包。候选组有20个以上成员先拆人工可读批次，不能用小模型一次决定整个大簇。

### 4.3 报告字段

每组输出groupId、kind、proposedCanonicalOfferId、memberIds、当前审核/生命周期、事实比较表、证据URL和摘要、决定时间线、人工字段差异、现有proposal/task、历史通知概况、blockedReasons、建议动作及影响数。必须解释“为什么是同一活动”，不能只写score=0.92。引用原语言，辅助翻译独立标记。

明确列出可能误合并的反证。例如同名学生/企业优惠、相同奖励不同设备代际、同日第二次reset。没有足够信息时默认不合并，保留身份任务。

## 5. canonical选择与冲突处理

### 5.1 默认建议顺序

优先已经作为长期公开入口、拥有明确当前批准版本的记录；其次证据与实际发放产品一致、人工维护完整的记录；再以最早合法创建时间、ID字典序作为确定性平局规则。自动建议不等于执行许可。

不得仅按approved>pending>rejected排序覆盖真实决策时间线。一个后来被明确unpublish的实体，不能因为同组存在早期approved副本就复活。若无法区分“拒绝重复副本”和“否定优惠本身”，整组blocked，要求管理员选择最窄正确范围。

### 5.2 字段保留

canonical现有公开字段作为基线。成员人工修改的同值保留出处；冲突字段逐项报告，由管理员在独立terms_update决定。禁止取最大金额、最长有效期、最少资格等凑成从未被批准过的优惠。不得合计重复usdEstimate或取最大usdMax当合并价值。

多个pending proposals：事实等价者保留一个活动任务，其余标superseded并保存来源关联；人工manualFields冲突时阻止该组合并，或在明确计划中指定保留任务和各字段处理。没有授权不能删除人工草稿。

同实体不同版本：保留每个原version，增加已确认等价/修订关系；当前approved_version只在计划明确且决定依据一致时选定。不能把历史差异当重复版本删除。没有人工批准的新版本保持待审。

### 5.3 拒绝决定归并

版本范围reject只作用等价事实版本，不升级为entity范围。predicate必须在目标产品和范围有效且不与approved事实冲突；否则人工核对。evidence_gap拒绝遇到官方证据已经补全时生成一个补证任务，而非继续永久抑制。duplicate理由记为link关系，不计一次新的审核拒绝。

历史决定保留sourceEntityId/legacyReviewId，通过root解析提供完整时间线；不得改作者与日期。向目标视图合并决定是查询层等价关系，不重写历史决定的原对象。

## 6. 执行计划：可审查、不可悄悄变化

工具`plan`生成UTF-8 JSON和Markdown摘要。JSON是执行输入，Markdown只作人读。schemaVersion='identity-merge-plan-v1'。

```ts
interface MergePlan {
  schemaVersion: 'identity-merge-plan-v1';
  planId: string;
  snapshotManifestHash: string;
  codeSha: string;
  resolverVersion: string;
  targetEntityId: string;
  sourceEntityIds: string[];
  canonicalOfferId: string | null;
  relation: 'same_version' | 'same_entity_versions';
  expectedEntities: { id: string; revision: number; stateHash: string }[];
  expectedOfferHashes: { id: string; hash: string }[];
  expectedTaskHashes: { id: string; hash: string }[];
  selectedApprovedVersionId: string | null;
  versionEquivalences: { a: string; b: string; evidenceRefs: string[] }[];
  taskActions: { id: string; action: 'keep' | 'supersede'; targetTaskId?: string }[];
  evidenceRefs: string[];
  reason: string;
  blockedReasons: string[];
  predictedEffects: Record<string, number>;
}
```

planHash由canonical JSON计算，不包括运行临时日志。执行前任何字段变动都必须重生成hash、重新确认。blockedReasons非空不能apply。用户确认的计划hash、确认人、确认时间存审计。执行不接受“合并所有高分候选”的自由指令作为无限范围授权。

计划必须列出的影响数：legacy offers映射、entity根数量、公开列表减少数量、versions等价关系、decisions可见范围、将supersede的任务、旧URL数、将覆盖的通知等价键，以及预计不变的历史记录数。金额变化按具体canonical公开值重新计算，不能假设减少比例等于重复数比例。

## 7. 新增治理记录

第二阶段表外新增以下逻辑表；migration采用实施时下一个编号：

`identity_backfill_jobs`：jobId PK、manifestHash、phase、cursorJson、statsJson、status、createdAt、updatedAt。仅apply/backfill模式写，dry-run不写。

`identity_merge_operations`：id PK、commandKey UNIQUE、planHash、planJson、beforeStateJson、afterStateHash、resultJson、inverseJson、state(applied|reverted)、actor、appliedAt、revertedAt NULL。回滚不得抹掉原apply记录，追加operation event。

`identity_merge_events`：id PK、operationId FK、kind(apply|revert|blocked)、detailsJson、actor、at。blocked如果发生在dry-run仅写报告，不写生产表。

`version_equivalences`：低/高排序versionId组成UNIQUE，entity root范围校验、operationId、evidenceRefs、revokedAt。只表示同事实版本，不把有变化版本宣称等价。

治理表中的JSON保存最小必要快照、显式列名与checksum，不保存令牌/完整环境变量。inverseJson是结构化命令，不保存未经审核可直接执行的任意SQL。

合并通过`sourceEntity.merged_into = targetRoot`和canonical查询完成。根至多一跳为目标；已有下级成员需纳入计划和guard，以保持根解析有界。仍保留所有实体原行。entity_offers不改原entityId，查询root得到统一身份；anchors/decisions/evidence同样解析root。不要重写原始FK后才发现回滚无法知道原归属。

## 8. 原子apply与并发保护

仅admin能执行merge/revert；reviewer可查看脱敏计划和建议，不能apply。

同一次apply最多20个entity且预计修改不超过200行/500KB命令体。超限返回400要求拆计划；不要把一个逻辑合并跨多个独立事务造成半组成功。若因数据库限制必须分阶段，先实现明确prepare/commit状态及读时隐藏未提交映射，再编新SPEC，不偷偷分块。

apply流程：

1. 验证planHash、schemaVersion、环境、用户确认、manifest以及代码兼容版本。
2. 读取所有受影响entity、offer、version、task、decision、anchor及pending/unknown delivery的当前版本；与计划逐项比较。
3. 有新的人工修改、任务checking、投递pending/unknown或主实体已重定向时，409 blocked并解释差异。不能修改后自动重试冒充原批准。
4. 进入短D1事务，CAS占位commandKey；重新校验revision/stateHash、根无环、平台和事实关系、任务/通知锁；后续所有语句依赖本次占位成功。
5. 写merge_operation前镜像、映射和版本等价，supersede计划指定的重复任务；同步持久索引dirty标记、canonical通知覆盖关系和业务审计。
6. 事务最后核对预测影响数和不变量，失败必须导致SQL异常rollback；零行SQL不等于成功。CHECK验证表或等效完整guard机制必须经本地真实D1验证，不只在事务提交后JS查错。
7. 保存receipt并提交；提交后读回root、public投影、任务和外键校验，输出结果与差异。任何异常将写入暂停并报告，不继续后续组。

两个并发计划涉及同一entity时revision CAS至多一个成功。同key相同planHash重试返回原receipt；同key不同planHash409。响应丢失不能二次应用inverse/merge。

每组独立原子，批次可部分完成但报告必须逐组标明applied/blocked/not_started；不得把一个组内部部分成功称作applied。后续组默认遇到首个严重不变量错误停止；业务冲突可跳过但最终非全成功退出码。

## 9. 各类引用与可见性

### 9.1 网站与客户端

公开列表、平台详情、RSS、时间线、日历、按模型、全部羊毛、洞察、价值合计和默认排序统一调用第二阶段canonical view；旧offer行不能在某一个旁路接口重现。对old-id详情返回canonical公开payload及requestedId，而非把被拒旧内容混进响应。

网站使用`#offer-ID`，fragment不发送服务器；必须在前端收到别名映射后用history.replaceState更新hash。浏览器本地收藏/已领取状态以用户原数据为准：读取时别名折叠并去重，不清空localStorage。对独立轮次不可合并用户的已领取标记。API的旧数值和新数值变化需解释为去重，不重写实际领取历史。

canonical被拒/下架时所有别名按其公开性返回404或现役历史视图，管理员接口仍可查历史；勿通过别名泄露reviewMemo、原lead.raw或rejected reasons。

### 9.2 历史审核与提案

revisions/reviews保留原offerId；管理详情按等价实体聚合展示并标明原记录。重复merge操作不是approve/edit，不污染人工准确率。manualFields、valuation、tested和lastVerifiedAt不得由非管理员修改。过期活动继续保留正确的历史起止日期。

提案不是证据档案：supersede后通过version/decision/operation仍可查看旧提案。不能只删除offer_proposals然后依靠运营人员记忆恢复。

### 9.3 通知与投递

合并前检查所有组成员的notifications及deliveries.payload引用。sent记录保持sent且messageId不变；pending/unknown阻止合并，除非管理员在单独投递处理流程给出确认（不能在merge顺便改状态）。failed/released同样保留历史。

逻辑new/changed/ending/ended/urgent通知按root+批准版本或活动窗口+channel查询整个等价类。任一成员已有相应sent记录即覆盖重复提醒；已发送changed但versions并非等价，不覆盖未来真实变更通知。日常常驻榜允许按现役规则再次展示，但不能重新记一次new发布。

审核提醒按task去重，已superseded任务不会再推；任务合并不发送“新审核任务”。历史消息无法撤回的事实必须保留，不声称merge撤销了用户已经看过的推送。

## 10. 回滚与误合并修复

提供`revert --operation-id`，默认dry-run。读取inverseJson和afterStateHash，只在受影响字段、entity revision、task状态仍匹配合并后状态且没有新的真实决定/投递时执行无损逆操作。所有逆写入与revert事件同一事务，重复revert返回已恢复结果。

能无损回滚的情况：merge后无人修改，恢复merged_into及根关联、撤销新增version equivalences、恢复被supersede的任务、索引与通知覆盖关系。原offers/reviews/revisions没有删除，恢复的是关系而非伪造历史。

不能自动无损回滚的情况：合并后已批准新版本、写入新证据关联、发送消息、发生二次合并或用户明确操作。返回409 `post_merge_activity`，输出新增事实与受影响ID；管理员决定拆分归属，执行新的split计划，不直接套旧数据库快照覆盖其他活动。split计划遵循同样CAS/幂等/审计规范，作为后续独立任务实现，V1至少具备检测与阻止破坏性回滚。

Worker代码回退：合并后不能切到完全不认识entity映射的旧版本，否则重复旧行会再次公开。紧急回退应使用保留canonical读、关闭新解析/merge写入的兼容版本。保留所有新增表与历史拒绝，不逆向DROP生产数据。

## 11. CLI合同与运行隔离

新增 `scripts/identity-reconcile.ts`，使用Node 24 + tsx；包命令`npm run identity:reconcile -- <subcommand>`。下面命令是实现后应支持的合同，当前不能假装已经存在：

```bash
npm run identity:reconcile -- inventory --snapshot ./private/snapshot --out ./private/report
npm run identity:reconcile -- backfill --snapshot ./private/snapshot --db local --dry-run
npm run identity:reconcile -- candidates --snapshot ./private/snapshot --out ./private/candidates
npm run identity:reconcile -- plan --group group-001 --canonical existing-offer-id --input ./private/candidates --out ./private/plan.json
npm run identity:reconcile -- apply --db local --plan ./private/plan.json --confirm-plan-hash <sha256>
npm run identity:reconcile -- verify --db local --operation-id <id>
npm run identity:reconcile -- revert --db local --operation-id <id> --dry-run
```

默认无`--apply`或缺确认hash为dry-run；上例apply子命令也要求明确confirm。db取local/staging/production，不允许隐式默认production。production必须另有显式`--allow-production`和用户授权记录引用；令牌从既有安全配置读，绝不打印。staging不是生产库别名，先核对绑定ID。

候选生成默认不联网、不调用LLM。需要模型辅助时另用`--allow-model`并读取脱敏快照、计入预算，输出中标明哪些关系由模型建议；不能自动apply。真正生产apply不在GitHub普通CI执行。

退出码：0完整成功/纯dry-run成功；2计划或参数不合法；3状态冲突/部分组blocked；4验证不一致；5技术错误。stdout输出摘要JSON，详细日志写文件；任何退出码都不能输出密钥或未脱敏内容。

## 12. 发布步骤与验收门槛

S0：先实现并验证第二阶段服务、canonical读与所有入口；确认第一阶段0016迁移已完成或等价。没有这个基础不得先清历史。

S1：本地合成快照→全新库迁移→旧库升级→回填dry-run/真实local apply→重跑→回滚，证明幂等及可逆。

S2：经许可的脱敏历史快照生成inventory及候选报告；管理员确认首批不超过5组，覆盖approved重复、rejected重复、补证、不同版本、必须不合并各类。

S3：隔离staging执行同样计划，核对公开API、前端旧链接、通知不发送、所有关键表计数/外键、操作日志、无误合并及rollback。

S4：取得生产授权，备份并核验恢复入口，暂停相关身份写入和通知claim，读取新快照重生成计划hash。旧staging hash不能直接视为生产批准；计划须绑定当前生产revision。

S5：首批生产apply后全量verify，任何不变量失败停止；再按<=20实体一组逐批，逐组报告。恢复调度前检查pending/unknown投递和幂等键。不得自动发送验收消息。

S6：shadow/enforce回放新来源：已合并羊毛换语言/ID仍关联原entity，拒绝历史有效，独立活动仍可入审。报告按新旧manifest比较，不用“重复数下降”替代漏收检查。

需报告的指标：合并组数/源记录数/实体净减少数、未处理疑似组、blocked理由分布、真实新活动数、人工任务减少量、误合并回滚数、无孤儿引用、公开unique实体数、按平台价值变化及解释、额外模型用量、重复通知增量（期望0）。不能承诺语义误判绝对为0；验收fixture中的must-not-merge必须0。

## 13. 自动化验收用例

| ID | 场景 | 必须断言 |
|---|---|---|
| P3-01 | 同快照backfill运行两遍 | entity/version/decision数量不再增长；旧字段逐字不变 |
| P3-02 | 中途失败/断点续跑 | 已完成块不重复；失败块不推进cursor |
| P3-03 | 快照后新增字典序较小ID | 增量清单可发现，不能静默漏回填 |
| P3-04 | approved与duplicate rejected同活动 | canonical公开一次，duplicate理由仍可查 |
| P3-05 | 后来明确unpublish与早期approved冲突 | blocked，不复活 |
| P3-06 | student/biz/设备代际/不同轮次同标题 | 不自动合并 |
| P3-07 | A像B、B像C但A冲突C | 不传递硬合并 |
| P3-08 | 两个不同manualFields提案 | blocked或明确计划分配，人工内容不丢 |
| P3-09 | 版本A拒绝、版本B批准 | A仍抑制，B仍公开，不扩大拒绝范围 |
| P3-10 | 两个同时apply重叠成员 | 一个成功，一个409；无半组关系 |
| P3-11 | 计划后人工修改主记录 | CAS拒绝，不偷偷刷新expected version |
| P3-12 | SQL中途异常、审计失败、guard零行 | 所有关系/任务/receipt回滚 |
| P3-13 | commit后丢响应再调用 | 返回同operation结果，计数不变 |
| P3-14 | sent或unknown delivery引用旧ID | sent被继承覆盖；unknown阻止合并，不重发 |
| P3-15 | 所有旧详情hash/收藏/已领取 | 映射正确、不清用户数据、不合并独立轮次 |
| P3-16 | API列表/RSS/日历/洞察金额 | 一活动一次，历史时间不被发现时间替换 |
| P3-17 | 被拒canonical及内部旧记录别名 | 公开404/现役许可视图，无内部泄露 |
| P3-18 | 无后续写入时revert、重复revert | 恢复原关系/任务，审计不删除 |
| P3-19 | 合并后批准/投递/二次合并再revert | 409 post_merge_activity，禁止破坏性恢复 |
| P3-20 | dry-run包括production参数 | 无DB/预算/模型/通知副作用 |
| P3-21 | 超大组/错误hash/跨产品锚点 | 400或blocked，禁止部分apply |
| P3-22 | 时间范围相同但两次独立reset | 保留两实体和两个领取事件 |
| P3-23 | 快照缺历史正文/旧理由无法解释 | legacy_unverified及人工报告，不造证据 |
| P3-24 | 合并后旧采集入口再抓一次 | 仍解析root，不创建新pending或通知 |

测试包括真实production路由＋migration-backed SQLite、真实本地D1事务、网页旧hash路由、CLI subprocess退出码和文件hash。至少一次fault injection覆盖最后一个事务语句失败；不能只在mock里让batch看起来原子。

## 14. 分PR实施与交付物

P3-A：inventory/snapshot manifest/backfill幂等工具；默认dry-run；fixture及覆盖率报告。

P3-B：候选发现、对照报告、canonical建议、人工确认plan schema/hash；不做线上apply。

P3-C：治理表、atomic merge/revert、全部canonical读/通知等价兼容、审计；过渡不破坏现役历史ID。

P3-D：本地D1/前端/CLI全链路、错误注入和回滚演练，运维runbook、首批候选报告模板。生产执行作为用户另行批准的任务。

最终交付：源代码和测试、增量migration、运行说明、manifest schema、plan schema、合成示例、每组verify与revert输出模板、设计→测试映射、当前HEAD和未覆盖风险。不得把所有任务一次提交，或提交真实生产导出到GitHub。

## 15. 依据

项目现役审核/公开规则见 `docs/data-contract.md`；数据库字段见 `src/db/schema.ts`。第二阶段SPEC定义全部身份关系。D1事务/限制在实施时核验官方文档：
https://developers.cloudflare.com/d1/worker-api/d1-database/
https://developers.cloudflare.com/d1/platform/limits/

默认策略：能确证才归并，不能确证先保留；决定和原始历史永久可追溯；真正执行必须可检查、可重放、可阻止破坏性回滚。
