# Codex执行入口 — 羊毛去重第二/第三阶段

版本：v1.0，2026-10-10。此文件是执行入口；先读本文件，再读两份SPEC。代码、测试和文档在独立分支完成；本文件不授权生产部署、生产数据操作或发送消息。

## 1. 文件与当前交付

- 第一阶段PR：#2，分支`fix/dedupe-review-stability-20261010`。
- 第一阶段说明：`docs/phase1-dedupe-fix-2026-10-10.md`。
- 第二阶段完整SPEC：`docs/superpowers/specs/2026-10-10-dedupe-phase2.md`。
- 第三阶段完整SPEC：`docs/superpowers/specs/2026-10-10-dedupe-phase3.md`。

第一阶段仅修复三个确定问题，未合并main/部署。验证的产品代码提交为`ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`；新增12个回归/保护测试，修复前6个行为断言失败，修复后343个Vitest和8个CLI测试通过，typecheck/build:web通过。验证使用Actions Node24与SQLite集成，不是生产D1。

第一阶段包含`0016_rejection_decision_key.sql`。后来main可能已有新的提交或同编号迁移，执行方必须现场核对，不照旧覆盖。npm安装期间报告的4个high依赖项未在本PR升级；应另行评估，不能把“测试通过”等同于“无供应链风险”。

## 2. 开始前的检查

1. 读取本地AGENTS.md和现役data-contract/operations/learned-rules；检查`git status --short`，保留用户未提交修改，不reset/clean。
2. `git fetch origin`后确认PR #2是否已合并。已合并则从最新main开新分支；未合并则从PR分支开后续分支，明确PR依赖，禁止把同一修复再次手抄一遍。
3. 在Node24环境运行npm ci、npm run typecheck、npm test、npm run build:web。记录真实输出、失败项和当前commit；不能用上面的历史测试数字当新执行证据。
4. 枚举所有写入者、读取方与通知调用方：pipeline初抽/官方复核/lead复核，worker ingest/admin/manual/approve/edit/reject/unpublish/withdraw，脚本、审核技能、web、RSS和两种通知。
5. 用本SPEC建立任务清单和测试矩阵。需求不明确时先在本地按保守行为实现并记录设计决定；凡会扩大生产授权、自动批准或破坏数据的操作必须停在计划/PR，不擅自执行。

## 3. 补充合同：消除实现歧义

以下条款细化两份SPEC，执行时一并遵循。

### 3.1 观察和结果类型

`ObservationInput`至少含`sourceId:string|null`、`origin:string`、`originalUrl:string`、`fetchedUrl:string`、`contentHash:string`、`observedAt:string`、`snapshotId:number|null`及由可信采集器产生的sourceAttestation；API验证URL、hash、时间、长度和source归属。模型输出不得自己提升sourceAttestation。完整sourceText可在请求内提供做摘录校验，但不得默认公开/长期重复存储；缺正文不等于空正文。

`NormalizationResult`固定为`{ok:true,facts:BenefitFacts,factsHash:string,warnings:string[]}`或`{ok:false,issues:{path:string,code:string}[]}`。未知事实仍可ok=true但明确unknown，不能靠填默认值提升匹配置信度。

`Resolution`含identityRelation、termsRelation、chosenEntityId、candidateEntityIds、conflictPaths、unknownPaths、evidenceRefs、reasonCode、resolverVersion、needsHuman；与API CandidateReceipt分开，后者是已提交的状态收据。

CandidateReceipt的resolved指“此候选无需继续抽取处理”，不是已经批准：created_pending、duplicate_approved、duplicate_rejected、linked_pending、proposed_update为true；needs_identity_review、needs_reopen为false且retryable=false（等待已有任务，不继续自动重抽）；deferred为false且retryable=true；invalid为false且retryable=false，需要更正输入。技术自动重试不得另建业务审批卡。

当所有候选resolved：至少一个对应offer时lead=linked；全部只有拒绝主体且无offer时lead=rejected/closed并保留决定引用；混合未决候选时lead=reviewing且保存已有task/candidate引用，不能清空resolution。对needs_identity_review的后续同簇来源仅追加任务候选。

### 3.2 命令与版本栅栏

ingest_commands主键按`principal + requestId`作用域生成，bodyHash覆盖规范化请求内容，不覆盖服务器新增时间。持有相同请求ID的超时重试必须复用原payload；不同body返回409。receipt读取必须检查授权主体，不能枚举别人的命令。

增加`commit_token TEXT UNIQUE NULL`。事务首条把received/retryable命令条件更新为临时committing并设置本次token；条件包含所有相关platform/entity/task/decision revision。后续语句都WHERE EXISTS本次token，最后保存结果并标committed。committing不得在成功事务之外可见；SQL异常回滚，零行首条导致其余语句全部无操作。命令已committed时读回原结果，不再次执行状态转换。

review_decisions的target_key是服务端生成的`<target_kind>:<target_id>`，不能是任意模型文本。命令内同一target唯一；entity/version/task/candidate的引用必须与target_kind一致，附带的entity上下文也要验证归属。新Decision取代旧决定必须有明确supersedes_id与理由，不能改写旧reason。

### 3.3 任务generation和旧版本重现

相同提案factsHash、相同baseApprovedVersionId只创建一个开放任务。任务被拒后，同证据语义版本沿用决定；新增观察时间和jobId不递增generation。只有正式reopen决定允许新generation。

条款A→B→A：有官方恢复生效关系时可形成新transition；重新抓到旧A公告不能自动回退。旧文与新文顺序无法确认时INSUFFICIENT，展示当前批准版并保留判断任务。

### 3.4 迁移通知抑制的唯一选择

第三阶段提到的migration_suppressed不写成sent，也不复用pending。实施独立表`migration_event_suppressions`：`event_key,channel`复合主键；`entity_id`、`event_kind`、`cutoff_approved_version_id`、`merge_operation_id`、`reason`、`created_at`、`revoked_at`。其含义仅是“这次历史迁移不触发回放”，不是曾经送达。

buildNotice查真实business_event_receipts与该suppression表；新批准版本不受旧cutoff抑制。撤销合并不自动撤销真实发送记录，也不使历史事件重新发送。每日常驻榜按独立digest日期照常运行。

### 3.5 合并批次的revision依赖

第一版执行计划每个平台最多包含一个可执行SAFE_IDENTITY组，其余组可以列为仅分析候选，不执行。同平台第一组合并会推进identity_write_state，下一组必须重新生成plan并批准新hash，不能复用原平台revision。

这是有意的保守限制，避免签名plan与预期版本在批内自行漂移。未来需要同平台多组一次执行时，另加带依赖和预期revision链的plan-v2，不在v1里偷偷修改plan。跨平台组默认人工判断，不进入自动SAFE_IDENTITY执行。

### 3.6 版本与范围

S2中内部机制枚举是身份层补充，不替换现役offer.type、tags、requirements或估值schema。写公开投影仍经过offerIn/checkOffer/publicationError等现役业务校验。

硬匹配不能优先于来源安全校验。unknown字段既不能证明冲突也不能证明一致；factsHash相同不是全球实体唯一键。所有模型关系先校验来源、ID范围和事实；只能用高分而无依据的关系进入人工任务。

## 4. 推荐PR拆分和依赖图

```
PR #2（阶段1）
  → S2-A schema/类型 + S2-B事实规范化
  → S2-C历史召回 + S2-D统一解析/幂等命令
  → S2-E pipeline与S2-F管理入口全适配
  → S2-G canonical读取/通知 + S2-H shadow指标
  → P3-A保守映射回填（生产执行另授权）
  → shadow评估 → enforce（另授权）
  → P3-B合并工具/演练 → 私有plan审批 → 分批生产merge（另授权）
```

为避免一个巨大PR，每个单元至少完成红测、最小实现、全套测试、差异自检与文档；下表列的是必须交付的可审查单元，不是一次提交全部代码。

| 单元 | 必须输出 | 关键红测 |
|---|---|---|
| S2-A | facts/API类型、增量schema、唯一/外键约束、兼容reader | 一实体双primary失败；旧行不丢；无offer拒绝可存 |
| S2-B | normalizeBenefitFacts、compareBenefitFacts、稳定hash | day/month不等；1000/1k等；不同货币/模型/AND-OR不等；unknown不覆盖 |
| S2-C | repository/retrieval、分页/全状态索引、重建工具 | rejected与历史可召回；索引错误不返回空历史；截断显式 |
| S2-D | resolver、命令收据、平台revision栅栏、强锚约束 | 不同ID并发同活动只建一个；同key不同body409；零行提交无副作用 |
| S2-E | 所有pipeline适配、候选级进度、预算内语义建议 | duplicate终态；部分失败仅重试余项；sameAs假指向被拒 |
| S2-F | 决定scope、reopen、人工任务、旧接口适配 | 拒绝换语言不回流；补官方证据只开一个任务；人工草稿不被覆盖 |
| S2-G | canonical投影、旧ID解析、通知事件账本 | 所有列表统计一次；内部信息不公开；别名不触发new；unknown不盲发 |
| S2-H | feature flag、shadow、指标与合同更新 | shadow不改现行业务；off/enforce切换受完整性检查 |
| P3-A | inventory/backfill/checkpoint与fixtures | 两次导入无重复；崩溃续跑；公开行为不变 |
| P3-B1 | 图/negative relation/plan生成/摘要 | 非传递相似不全并；多approved冲突停；plan只读 |
| P3-B2 | 权限/版本保护apply、operation审计、旧行保留 | audit失败全回滚；旧plan409；重复apply同receipt |
| P3-B3 | unmerge、通知suppression、全入口验收 | 新编辑不被旧快照盖掉；旧ID可用；回滚不恢复重复发送 |

每个单元的测试命令固定包含`npm run typecheck`和完整`npm test`；涉及web/公开输出加`npm run build:web`和UI测试。SQL行为用迁移驱动SQLite，再在获授权的D1 staging验证。禁止只跑自己新增的测试而遗漏全套失败。

## 5. 核心测试结构示例

这些例子是验收结构，不是让测试通过mock验证自身逻辑。fixture中的官方来源、额度和规则必须由测试显式构造，不能接真实付费模型或生产站。

```ts
it('deduplicates a reviewed benefit across language and source', async () => {
  const base = await fixtures.approvedSignupGrant({ amount: '10', currency: 'USD' });
  const first = await intake(fixtures.englishAlias(base));
  const replay = await intake(fixtures.chineseFaqAlias(base));
  expect(first.entityId).toBe(base.entityId);
  expect(replay.entityId).toBe(base.entityId);
  expect(await counts()).toMatchObject({ publicOffers: 1, newReviewTasks: 0, newNotificationEvents: 0 });
  expect(await publicOffer(base.offerId)).toEqual(base.publicSnapshot);
});

it('does not merge independent eligibility scopes', async () => {
  const student = await fixtures.approvedStudentGift();
  const business = await intake(fixtures.businessGiftWithSameTitleAndAmount());
  expect(business.entityId).not.toBe(student.entityId);
  expect(await publicOffer(student.offerId)).toEqual(student.publicSnapshot);
});

it('keeps rejection after a lead-only dismissal', async () => {
  const rejected = await fixtures.rejectedLeadWithoutOffer();
  const replay = await intake(fixtures.translatedAlias(rejected));
  expect(replay.outcome).toBe('duplicate_rejected');
  expect(replay.decisionId).toBe(rejected.decisionId);
  expect(await counts()).toMatchObject({ publicOffers: 0, newReviewTasks: 0 });
});
```

并发测试必须在真实数据库写入前设置barrier，使两个请求都先看到旧revision，再放行；只用Promise.all但没有可控交错不足以证明竞争保护。断言实体/任务/决定/notification数量和最终内容，不只断言HTTP200。

合并测试在真实schema中创建offers、proposals、reviews、leads多目标与deliveries；对每个表检查before/after与外键。先运行测试确认因缺功能失败，再实现。已有Mistral/Space Bunny/重置/手动字段/估值/来源身份测试不得删除或降低标准。

## 6. 判定优先级和常见错误

安全和来源归属 → 已批准/已拒决定与作用域 → 身份/条款证据 → 人工活动中提案保护 → 性能优化。不能为了队列变少牺牲前面的规则。

不要实施：全平台相同金额合并、所有同公司产品合并、仅title或URL唯一、模型自己设置canonical ID、降低0.85阈值作为主要修复、把unknown当none、把换语言当新条款、收到skipped就失败重试、只记最近拒绝、旧页面一段消失就判政策改变、永久实体黑名单吞新版本、全量重抽测试生产、批量DELETE重复offers、清空通知/拒绝表。

不必第一版引入embedding；先让持久身份、全状态召回、事实比较、候选终态和审核scope闭合。后续任何向量模型/阈值/召回策略变化都必须有版本和标注评估，不能成为静默合并的单一依据。

## 7. 每次交付的报告模板

```
实施单元：
基线commit / 修复commit / PR：
修改文件及对外合同：
红测：命令、具体失败断言：
绿测：命令、通过/失败/跳过数量：
全套typecheck/tests/build结果：
实际验证环境（SQLite/D1 staging/生产分别说明）：
新增schema与兼容性/迁移顺序：
未实现、未验证、依赖风险：
是否触及生产/发送消息：
下一单元的明确前置条件：
```

最终“第二阶段完成”需要S2全部验收及兼容入口盘点，不是几个函数单测通过；“第三阶段代码完成”不等于生产数据已回填或合并。生产结果另提供私有plan、批准记录和operation receipt。

## 8. 可直接交给Codex的任务说明

> 请先阅读AGENTS.md、现役data-contract/operations，以及docs/superpowers/specs/2026-10-10-dedupe-handoff.md和两份phase2/phase3 SPEC。核对PR #2与最新main，不覆盖我的本地未提交改动，不重复实现阶段1。按handoff的依赖顺序分小PR实施，先写并运行失败测试，再做最小实现，每个单元运行完整typecheck/tests，涉及公开界面再跑build:web/UI测试。优先建立持久活动身份、全状态拒绝记忆、结构化事实比较、统一服务端闸门与幂等状态提交；不要仅调相似度或增加平台特例。历史部分默认只读inventory、dry-run和plan生成，保留旧记录和ID，要求planHash、版本检查、审计与unmerge。没有我的单独授权，不合并main、不部署、不执行生产迁移/回填/合并、不线上重抽、不发送消息。每次提交按报告模板列出实际验证与剩余风险。
