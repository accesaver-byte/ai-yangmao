# AI 羊毛牧场去重改造：Codex 执行入口与任务计划

日期：2026-10-10。状态：设计交接；第二、三阶段未在本PR实施。

> 执行者先读完整SPEC，再按本文件分PR实施。使用当前环境可用的计划执行/TDD/验证流程；无子代理时自行执行并明确自审，不虚构独立审查。

**Goal：** 同一活动的来源与语言变体只关联一次审核决定；真实条款变化可审；历史重复可安全归并而不丢证据、人工记录和旧链接。

**Architecture：** 保留Cloudflare Worker/D1、Hono、Drizzle、现有offers与proposals。增量增加活动实体、事实版本、来源观察、拒绝范围、任务与幂等操作层；之后才治理存量重复。先shadow，后经授权enforce；历史治理默认dry-run。

**Tech stack：** Node.js 24、TypeScript、Hono、Drizzle、Cloudflare D1、Vitest、现有Node CLI测试。保持依赖锁文件，不为写SPEC升级依赖或安装向量服务。

**Specs：**
- [第二阶段：统一身份与拒绝决定](../specs/dedupe-phase2-identity-and-decisions-v1.md)
- [第三阶段：历史回填与可逆归并](../specs/dedupe-phase3-historical-reconciliation-v1.md)
- [第一阶段实现和验证](../phase1-dedupe-fix-2026-10-10.md)

## 1. 给Codex的启动指令

可将下面文字连同本文件路径交给Codex：

```text
在 accesaver-byte/ai-yangmao 中继续实现去重第二阶段。
先读取 AGENTS.md、docs/data-contract.md、pipeline/learned-rules.md、
docs/plans/dedupe-phase2-3-codex-handoff.md，及其链接的两份完整SPEC。
先核对 PR #2 是否已合并，检查本地未提交修改和实际main HEAD；
保留后续Mistral/source-scope修复，不覆盖用户现有工作。
在独立分支先实施P2-A，不要一次实施第二、三阶段所有内容。
先写并运行失败测试，再写最小实现；运行完整typecheck、npm test和必要build。
每个PR提供SPEC条目→测试ID映射、数据库迁移说明和未覆盖风险。
设计有冲突先写ADR说明，不静默改成标题相似度或模型ID去重。
不得自动合并main、部署、执行远程D1迁移/seed、清理生产历史或发送消息。
默认IDENTITY_MODE=off；历史工具默认dry-run。完成P2-D验收后才开始P3-A。
```

## 2. 第一阶段的已有成果与未完成范围

PR #2分支：`fix/dedupe-review-stability-20261010`。不要重新实现或覆盖这些修复：

1. `pipeline/run.ts`识别服务端duplicateId为已处理，不再因skipped把已知重复送回reviewing；未知skip/部分失败仍保留。
2. `changedOfficialBenefit`允许真实的同数字周期/权益变化进入提案，保持旧批准公开版与主动编辑中的manualFields。
3. 拒绝提案的记忆、audit、delete用D1 batch+decisionKey一致提交，解决版本竞争和审计失败的部分成功。
4. 增量迁移`0016_rejection_decision_key.sql`，必须先迁移后部署；本次未执行生产迁移。

已验证代码提交`ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`：343个Vitest+8个CLI通过，typecheck和web build通过。新增12项回归/保护用例；红测6项失败，修复后全过。之后的文档提交不代表又部署了一次。

第一阶段不解决通用跨语言实体识别、不同资格的统一冲突解析、无offer拒绝线索的语义记忆、历史业务身份唯一约束；这些明确属于下述SPEC。跨页面真实变化也仍采用保守门槛，不能说已实现完整same/changed/uncertain。

现有npm audit报告4个high依赖条目（包含传递影响）；未在此PR更新依赖，不等于四个独立可利用生产漏洞。发布前另开依赖评估，不能顺手`npm audit fix --force`破坏锁文件。

## 3. 开工检查与全局约束

- [ ] 读取实际repo、工作区、分支、PR和migration状态；`git status --short`若有未提交修改，保留并在新工作区执行，不stash/drop用户工作。
- [ ] PR #2未合并时，基于其经过确认的分支建立P2-A后续分支；已合并则基于最新main。不要按旧SHA强制重置main。
- [ ] 使用Node 24；`npm ci`后运行`npm run typecheck`、`npm test`记录基线。基线失败区分已有和新引入，不能隐瞒。
- [ ] 检查实际迁移编号；编号冲突重新编号并同步测试/文档，不覆盖既有migration。Drizzle metadata与当前项目手工migration方式须一致。
- [ ] `tested`、valuation及人工字段的所有权不变；内部证据、reject理由不进入公开字段。
- [ ] 新模型/外部索引为可选；未授权不额外购买服务，不转发真实用户或账号数据。预算失败必须可恢复。
- [ ] 默认off/shadow/dry-run，生产写入/上线需要另外授权；不要触发collect、distill、通知等真实任务来假装验收。
- [ ] 不用字符串哈希代替实体身份，不用相似度传递闭包，不把unknown当same，不扩大旧reject作用范围。

## 4. 模块与接口分工

| 新/修改模块 | 职责与边界 |
|---|---|
| `src/shared/identity-contract.ts` | Zod输入/回执/Fact/Decision/Task合同，导出SPEC规定类型 |
| `src/shared/facts-normalize.ts` | `normalizeFacts(input): BenefitFactsV1`、`hashFacts(facts): string`；纯逻辑，不取网 |
| `src/shared/facts-compare.ts` | `compareFacts(before,after): FactComparison`；差异/冲突/未知/证据路径 |
| `src/shared/decision-policy.ts` | `evaluateDecision(decisions,candidate,context): DecisionEffect`；范围与重开条件 |
| `src/worker/identity-repository.ts` | 参数化D1查询、revision/CAS、事务、任务唯一与operations receipt |
| `src/worker/identity-service.ts` | `resolveCandidate(command,env): Promise<ResolveReceipt>`；统一身份提交规则 |
| `src/worker/candidate-retrieval.ts` | `retrieveCandidates(candidate,options): CandidateSet`；状态完整、topK及索引版本 |
| `src/worker/canonical-view.ts` | `resolveEntityRoot`、公开投影/旧ID/通知等价解析；故障不暴露旧行 |
| `pipeline/identity-resolution.ts` | 可选LLM语义建议与现有预算/引用校验；不持有批准权 |
| `src/worker/index.ts`及两类复核路由 | 接入服务，禁止旁路写入/信任模型sameAs |
| `src/worker/admin.ts` | 任务、link/new/changed/reopen、版本鉴权和最终批准去重 |
| `scripts/identity-reconcile.ts` | inventory/backfill/candidates/plan/apply/verify/revert子命令 |
| `src/worker/identity-reconcile.ts` | 受控管理员merge/revert事务；复用root/decision/task合同 |

新的FactComparison至少包含relation、changedFields、conflicts、unknownFields、evidenceRefs；CandidateSet至少包含items、indexRevision、complete、truncated；DecisionEffect包含action、decisionId、scope、reasonCode、reopenSatisfied。上下游从同一contract导入，不能重复定义不兼容接口。路由/前端具体文件以仓库当前目录为准，先定位再改；不凭本文猜测页面文件名。

## 5. P2-A：事实合同、表结构和shadow基础

**交付边界：** 新模块与基础记录可用，旧公开行为完全不变，IDENTITY_MODE=off默认不访问新表。

**文件：** 新增identity-contract/facts-normalize/facts-compare；修改schema、增量migration及项目metadata；新增`tests/facts-normalize.test.ts`、`tests/facts-compare.test.ts`、`tests/identity-schema.test.ts`。

**输入：** 当前OfferIn、Evidence、原文区段与legacy状态。**输出：** BenefitFactsV1、FactComparison、数据表和幂等一对一legacy映射。

- [ ] 写失败测试P2-05/06/07/08/09/10/11/21，特别是100/day≠100/month、unknown≠none、1月≠30天、不同设备代际。
- [ ] 运行`npx vitest run tests/facts-normalize.test.ts tests/facts-compare.test.ts tests/identity-schema.test.ts`；先确认因缺失功能失败，而不是测试导入/语法错误。
- [ ] 实现Fact联合类型、规范化、schema与索引。每个强锚点、open task、operations key的唯一冲突要有真实SQL测试。
- [ ] 写新库全迁移、旧库含approved/pending/rejected升级测试；legacy首次回填与重放两次计数不变。
- [ ] off旧行为回归；shadow仅影子记录，不能新增offer/approval/notice。执行完整typecheck和npm test。
- [ ] 提交P2-A，更新设计/数据合同对应机制为“未启用/影子”，不伪称生产生效。

## 6. P2-B：召回、拒绝范围、统一身份提交

**交付边界：** 后端能为候选返回逐项可靠receipt，保持shadow；所有新任务/decision/版本幂等。

**文件：** 新增decision-policy、candidate-retrieval、identity-repository/service、pipeline/identity-resolution；`tests/identity-resolver.test.ts`、`tests/identity-transactions.test.ts`、`tests/decision-policy.test.ts`。

**输入：** P2-A合同+实际证据+expected revisions。**输出：** ResolveReceipt与确定的同版本/变化/独立/不确定分流。

- [ ] 失败测试P2-01/02/03/04/12/15/16/23/24：被拒历史、无offer拒绝、跨语言但不同资格、同页新赠额不能被旧拒绝整页封禁。
- [ ] 候选检索包含全部状态；强锚点精确读、结构化/FTS召回topK30/max50；index失败返回deferred而非[]。
- [ ] 对LLM只验证结构化建议与原文引用，禁止sameAs直接更新ID；证据不完整时identity_pending。
- [ ] 失败测试P2-13/14/17/18/19：重放、并发、零行guard传播、事务中最后写失败、响应丢失。先运行红测。
- [ ] 实现commandKey+payloadHash、entity revision、版本/任务unique，所有副作用与receipt同事务；SQL异常真实rollback。
- [ ] 补模型配额/timeout测试和缓存version失效；完整typecheck/npm test。提交P2-B并提供EXPLAIN及D1行读写预算记录。

## 7. P2-C：全入口、管理员任务与公开兼容

**交付边界：** 可按平台灰度enforce；不存在旧入口绕过统一身份写入。

**文件：** 修改pipeline/run/lead-review/official-review、Worker三类路由及admin、canonical-view、web中定位到的审核页/详情路由、CLI/仓库审核技能；新增`tests/identity-workflow.test.ts`、`tests/canonical-view.test.ts`并扩展frontend-workflow。

**输入：** P2-B服务。**输出：** 所有入口使用同一receipt/decision，管理员一次核对、旧ID和通知不重复。

- [ ] 先写端到端红测：官方抓取、RSS、初抽、受阻复核、manual、edit、approve都不能绕过相同身份；覆盖P2-18/20/22。
- [ ] 实现每candidate持久状态、多关联lead；重复是终态，失败仅重试未完成者。
- [ ] manual补来源不默认重开；reopen理由和权限单独检查。link不等于approve，未知资格仍阻止发布。
- [ ] 管理UI展示新旧facts、冲突/未知、决定时间线；动作必须带版本，冲突不静默重试。
- [ ] canonical公开视图覆盖offers/platform/RSS/统计；敏感字段过滤、旧hash route和本地收藏兼容测试。
- [ ] 通知按entity/approved version/task逻辑事件去重，unknown delivery不重发；日常常驻榜行为不误禁止。
- [ ] 完整typecheck/npm test/build:web，真实本地D1运行时集成。提交P2-C并更新现役接口文档与操作技能。

## 8. P2-D：回放、迁移演练与灰度发布准备

**交付边界：** 有证据证明可发布，但不自动部署。

- [ ] 创建至少120例标注数据，按活动家族划分开发/holdout；脱敏，禁止只用现有平台特例。
- [ ] 跑P2-01至24，输出逐例结果与混淆矩阵、precision/recall分母、人工任务去重、真实变化召回和must-not-merge列表；门槛见完整SPEC。
- [ ] 用10,000实体/100,000观察合成数据测topK、EXPLAIN、rows_read/rows_written/tokens及p50/p95，不能以小库成功推断规模稳定。
- [ ] off→shadow→enforce→兼容回滚，旧库迁移和新增索引回填中断恢复；完全初始化前禁止enforce。
- [ ] 清理临时诊断文件，核对PR diff与migration编号，提交运行手册/验收记录。列出生产仍需授权的操作。

## 9. P3-A：快照、inventory和一对一回填工具

**输入：** P2完成后的schema和脱敏快照。**输出：** manifest、计数报告、幂等backfill job与冲突清单。

**文件：** scripts/identity-reconcile.ts、共享snapshot/manifest模块、增量治理表migration、`tests/identity-backfill.test.ts`和CLI subprocess测试。

- [ ] 红测P3-01/02/03/20/23：重跑、中断、UUID字典序漏项、dry-run零副作用、legacy证据缺失。
- [ ] 默认dry-run，固定manifest输入；明确环境，不访问生产。各chunk写入和cursor推进一致提交。
- [ ] approved/public与人工历史字段逐字保持，legacy映射/decisions唯一；没有语义合并。
- [ ] typecheck/npm test，命令退出码及无密钥输出测试；提交P3-A。

## 10. P3-B：候选报告、canonical建议和确认计划

**输入：** inventory+P2解析。**输出：** candidate groups、人读比较表、MergePlan/planHash；不做apply。

**文件：** 新增reconcile-plan/schema/report模块、`tests/identity-merge-plan.test.ts`。

- [ ] 红测P3-04/05/06/07/08/09/21/22：不同资格、后来下架、人工提案冲突、非传递相似。
- [ ] 每组证据、反证、版本关系和影响数可查；被拒范围不扩大；主记录选择规则确定且可人工改。
- [ ] 使用canonical JSON算hash，状态指纹绑定计划；blocked组不可执行，变计划须新hash。
- [ ] 全套测试并交付合成报告/计划示例；不提交真实生产导出。提交P3-B。

## 11. P3-C：原子merge、revert与全部引用兼容

**输入：** 确认计划、current revisions。**输出：** merge operation receipt、可逆关系、历史不变。

**文件：** Worker identity-reconcile、治理migration、canonical-view/通知适配、`tests/identity-merge.test.ts`、`tests/identity-merge-races.test.ts`、`tests/identity-revert.test.ts`。

- [ ] 先写P3-10/11/12/13/14/18/19失败用例；最后一个SQL失败必须让所有关系/receipt回滚。
- [ ] 实现<=20实体/<=200修改行计划限制、CAS、root防环、command幂等、前镜像/后指纹和inverse结构化记录。
- [ ] 不重写历史reviews/notifications FK；通过root和version equivalences聚合。pending/unknown投递默认阻止该组合并。
- [ ] revert只恢复无后续写入的操作；发现新批准/消息/二次合并返回post_merge_activity，不覆盖历史。
- [ ] 公开接口、旧hash收藏、统计全部回归；P3-15/16/17/24不遗漏。真实本地D1测试和完整typecheck/npm test/build:web。提交P3-C。

## 12. P3-D：治理演练与运维交付

- [ ] 跑完整P3-01至24，用合成与获准脱敏快照分别验证。
- [ ] 本地/staging按inventory→backfill→candidate→plan→apply→verify→revert完整演练，保留每阶段hash和逐组结果。
- [ ] 生成首批<=5组人工核对模板、生产权限清单、备份恢复检查、调度/通知暂停恢复步骤。
- [ ] 验收记录区分本地、远端提交、CI、staging和生产；不因CI绿勾宣称线上重复已消失。
- [ ] 提交P3-D；实际生产清理仍是另外任务，必须以当前生产版本重生成计划，不能直接套旧导出。

## 13. 每个PR的完成合同

每次交接必须给：base/head SHA；实际改动文件；SPEC条目→测试ID映射；红测失败原因与绿测结果；完整npm test/typecheck和前端涉及时build:web；migration/配置/default开关；未覆盖/失败项；回滚方式；是否有生产动作（默认无）。

审查重点：不同活动误合并、unknown被当same、旧拒绝误杀新赠额、并发下半成功、旧链接/通知/人工历史丢失。没有独立reviewer时写自审，不写“已通过独立安全审计”。

当前PR只交付第一阶段修复及本设计包。不要把阅读或提交这些SPEC计入第二、三阶段功能完成。
