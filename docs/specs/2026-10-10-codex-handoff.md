# Codex交接：第一阶段PR验收、第二/三阶段分步实施

日期：2026-10-10。仓库：`accesaver-byte/ai-yangmao`。

## 1. 从哪里开始

第一阶段PR：[PR #2](https://github.com/accesaver-byte/ai-yangmao/pull/2)。分支：`fix/dedupe-review-stability-20261010`。

先读：

1. 仓库 `AGENTS.md`、`docs/data-contract.md`、`pipeline/learned-rules.md` 及涉及平台的现行规则。
2. [第一阶段修复记录](../phase1-dedupe-fix-2026-10-10.md)。
3. [第二阶段SPEC：统一身份、版本和拒绝记忆](2026-10-10-benefit-identity-phase2.md)。
4. [第三阶段SPEC：历史回填、合并和回滚](2026-10-10-historical-dedupe-phase3.md)。
5. 本交接文件的实施补充、任务顺序和授权边界。

当前状态：PR #2只有第一阶段三个具体修复和后续SPEC，不含完整语义去重。不得把文档当已实现代码，也不得再重复实现已完成的第一阶段补丁。

第一阶段基线为main `7cea69d95d2c27e2c1ebd7641a94bab2a696901d`；已验证业务代码提交 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`。后续提交增加文档/移除临时测试runner，实施前仍须确认最新PR diff及main变化。

在本地先检查未提交文件并保留用户工作。PR #2已合并时从最新main新建第二阶段分支；未合并时从其远程修复分支新建 `feat/benefit-identity-v2`，不要直接改PR #2分支，不自动合并/强推，不把同一补丁重抄一次。用户已有新修复则逐项对照，不覆盖。

## 2. 第一阶段已交付内容与限制

实现内容：

- `pipeline/run.ts`：duplicateId是已解决候选，关联canonical ID而非重新送审；未知skipped与部分失败仍保留。
- `src/shared/review-stability.ts`、`src/worker/index.ts`：官方权益事实变化可以进入提案，即使数字相同；已批准公共值与正在编辑的人工提案不被覆盖。
- `src/worker/admin.ts`、schema及migration0016：拒绝记忆、审核日志、提案删除通过唯一decisionKey和D1 batch原子完成。
- 两个真实workflow/Worker测试文件新增12个回归及控制案例。

验证证据：[红绿验证运行](https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054794747)。新增测试在旧实现出现6个预期行为失败；修复后343个Vitest测试、8个CLI测试通过，typecheck、build:web通过。SQLite集成执行真实migration，模拟D1 batch事务；尚未完成真实Cloudflare D1或生产验收。最终实施者必须重新运行当前分支检查，不能只引用这个历史数字。

已知范围外风险：依赖审计报告4个high受影响依赖条目（含传递关联），未在本PR升级lockfile；不是4个已确认可利用的生产漏洞。另建依赖修复PR验证，不执行无审查的 `npm audit fix --force`。

**发布顺序：先验证并执行0016数据库迁移，再部署新Worker。** 新schema会读取decision_key，不能先部署再慢慢补迁移。回滚Worker时保留新增列/索引/拒绝记录。迁移编号与main冲突时重编号新增文件并重跑fresh/upgrade测试，不修改已应用migration。实施第二阶段不自动执行上述生产步骤。

## 3. 两份SPEC共同的实施补充

### 3.1 当前批准版本是显式指针

第二阶段 `benefit_entities` 在必备字段基础上再增加：

- `approved_version_id` nullable FK → benefit_versions.id；
- `approved_decision_id` nullable FK → review_decisions.id。

两者同时null或同时非null。非null时decision必须是有效approve、指向该version且属于同canonical实体组。批准/取代决定、两指针、offers公开投影和revision在同一受guard事务更新。原版本/决定不改写；不能取latest capturedAt或最高versionNo当当前批准版本。Drizzle循环FK需明确列类型，测试migration和typecheck。

第三阶段canonicalEntityId必须是plan选定canonicalOfferId当前所属实体；不要让另一个实体偷指该offer而违反canonical_offer_id UNIQUE。若确需改变主投影归属，另作有明确批准依据的事务计划，不用取消唯一约束解决。

### 3.2 provisional容器不是集体批准单元

同block的未知候选可以共用身份核对视图，但必须显示独立candidateId。task resolve命令须明确candidateIds，确认link/new/not_same仅作用于这些成员；其他成员保持未解决。整个容器不能一键全部继承approve/reject，除非先确认同一实体并记录证据。这样避免用“少推审核”掩盖误合并。

### 3.3 维护闸门为第三阶段增量扩展

第三阶段为identity_scopes增加 `maintenance_owner`、`maintenance_lease_until`；锁定/续约/释放都按owner和revision CAS。Phase2普通流量已经要检查maintenance，不能到merge脚本才加一个无其他写入者遵守的锁。

identity_merge_runs/journal的before/after包括实体指针、任务状态和批准指针；不回退revision、不删除真实历史决定。一个cluster一次apply，剩余cluster重新preview和确认planHash，是第一版明确选择，不做隐式多簇全自动执行。

### 3.4 模型位置与事实安全

模型调用仍在pipeline预算框架中；Worker resolver纯判断、repository统一写入。semantic relation不是用户收录决定。known事实都必须有出处；人工实测tested权限不扩大；快照不全、模型调用失败、找不到官方来源是“证据/运行状态”，不是“优惠不存在”。

平台级scope CAS只能防止并发注册绕过索引，不能自动解决跨语言语义不明；未知要保留核对任务。没有embedding也必须靠结构化双语机制、产品别名和证据关系通过基础回放集。

## 4. 第二阶段实施任务（逐个小PR）

每个任务先读对应SPEC，写失败测试并确认失败原因，再实现、运行完整检查、自审diff、提交。不得把多个未验证模块一次性拼到主分支。任务代码路径是目标路径；现有文件内容必须先实际读取。

### P2-A：事实合同与差异比较

文件：新建 `src/shared/identity/{contracts,facts,normalization}.ts`、`tests/identity-facts.test.ts`、`tests/fixtures/identity/*`。

产出：`NormalizedFacts`与Zod schema；`normalizeFacts(candidate,evidence)`；`compareFacts(a,b)`；canonical JSON与facts-v1 hash；版本化别名表。

先固定P2-01、04至11、14、17、28、30的纯函数失败测试，特别是100/day与100/month、unknown与global、Token与credits、学生与企业、同URL多活动。仅写表面字符串断言不算通过。

验收：确定性hash；跨语言等价事实一致；有证据冲突不能same；不完整返回insufficient；无网络和数据库副作用。

### P2-B：持久实体、版本、决定与原子提交

文件：`src/db/schema.ts`、新的未占用migration、`src/worker/identity/repository.ts`、`tests/identity-repository.test.ts`。

产出：SPEC第3节schema与本文件批准指针；`commitResolution(command)`、`getReceipt(operationKey)`、`getEntity(id)`、有界检索及scope CAS。生产事务用D1 batch，不用多个await伪造transaction。

失败测试：fresh/upgrade、operationKey重放/异payload、同scope并发新ID、零行guard、每条SQL故障、receipt丢回包、批准指针和投影原子一致。为CHECK guard最终断言写能真实回滚的SQLite测试；另列隔离D1验证清单。

验收：没有孤立version/decision/task；主记录唯一；已批准状态稳定；100绑定参数限制；全套第一阶段回归保持通过。

### P2-C：召回与身份判断（先shadow）

文件：`src/worker/identity/resolver.ts`、`pipeline/identity.ts`、`tests/identity-resolver.test.ts`、双语holdout fixtures。

产出：`resolveIdentity(candidate,retrieved,context)`，四态关系、证据引用、冲突和比较revision；有索引的候选召回、可选FTS5；受预算语义判断；缓存key包含facts/rules/policy及scope revision。

失败测试：同一活动多语言、拒绝lead无offer、错平台、相似度传递误合并、模型伪ID/伪引用、召回截断、错误后空索引、预算耗尽。保留已有Mistral/lead-scope/独立设备赠礼测试。

验收：记录shadow差异但不改公开/审核/通知状态。报告precision、recall、unknown占比，不把unknown记成命中；达到SPEC回放目标后才准备enforce。

### P2-D：统一入口、决定scope与显式reopen

文件：`src/worker/identity/routes.ts`、`src/worker/{index,admin,lead-review,official-review}.ts`、`pipeline/{run,lead-review,official-review}.ts`、`tests/identity-intake.test.ts`。

产出：兼容旧/offers的IntakeReceipt；逐候选lead links；所有入口服务端enforce；reopen/补来源分离；新版及legacy拒绝范围导入。

失败测试：全部入口绕过尝试、sameId冲突、已拒候选加独立新优惠的部分失败、直接拒绝lead换URL、手工重复提交、补证后仅一次重开、policy升级只重评相关项、审核权限边界。

验收：已解决候选不重试；旧客户端不能绕过；不同拒绝理由不一律永久封禁；first-stage审计/并发保护不回退。flags默认off，代码不切换生产。

### P2-E：审核UI与通知语义身份

先读取web实际结构再写文件路径计划；不得按历史记忆猜前端文件名。修改身份任务视图、来源/版本diff、canonical ID适配、buildNotice及notifications/deliveries取数；测试public projection与通知幂等。

失败测试：任务新增来源不重发卡片、同版本多URL仅一项、uncertain容器只处理所选candidate、人工编辑冲突、pending/unknown delivery、公开接口不泄密、日更常驻榜仍按天工作。

验收：`npm run build:web`，真实浏览器操作身份确认、拒绝、补证、版本diff及旧链接，提交截图/操作记录（无真实密钥）。没有实际浏览器验证时必须标未验证，不能靠HTML字符串测试声称体验通过。

### P2-F：本地回填、shadow验收与灰度runbook

实现Phase3的一对一backfill部分作为启用前置，不做历史merge。导入批准/拒绝历史和无offer leads；完成100对最低回放集与7次采集模拟/授权shadow观察，记录每平台结果。

验收：off/shadow/enforce三个模式；seed未完成不准enforce；错误可恢复；公开输出不退化；fresh、upgrade、旧客户端与完整npm测试通过；获授权隔离D1的batch/FTS/CAS验证。

交付灰度/回滚说明，生产flags、部署和数据写入仍待授权。Phase2结束后再创建Phase3工作分支。

## 5. 第三阶段实施任务

### P3-A：只读审计、manifest及可恢复一对一回填

文件：`scripts/identity/{args,audit,backfill}.ts`、`tests/identity-backfill.test.ts`；复用P2-F，不重复实现。

先写P3-01至03、22失败测试；关键断言为公开业务hash不变、重复运行不增记录、缺表/截断/游标插入不漏报、所有外键引用得到处理。生成fixture审计示例与恢复日志。

### P3-B：plan生成、审查界面与not_same记忆

文件：`scripts/identity/plan.ts`、admin preview/approve路由、对应UI及tests。

先写P3-04至10、17、20测试。只读preview不写业务数据；plan必须给canonical、全部成员/row guards、证据、冲突、expectedEffects、hash及人工批准。不能将相似度图连通分量直接全部合并。

### P3-C：单簇事务、逻辑alias、journal

文件：`src/worker/identity/merge.ts`、新migration/schema、`scripts/identity/apply.ts`、`tests/identity-merge.test.ts`。

先写P3-11至15、20、21测试：并发、超时、逐语句失败、maintenance失效、plan被改、旧job到达。实现单簇D1 batch/receipt/journal、现有group完整成员的一跳指针及全部查询canonical-aware。

公开API、RSS、通知、审核页面、收藏/旧hash链接都必须统一。不要只在首页filter一下重复项。历史payload、review记录和lastVerifiedAt不变。

### P3-D：验证、rollback、重放与发布runbook

文件：`scripts/identity/{verify,rollback}.ts`、`tests/identity-rollback.test.ts`、前端旧链接fixture、runbook。

先写P3-16、18、19、23至26测试。回滚无后续依赖时恢复归属，revision必须继续增长；有后续业务写入则409，不能force覆盖。重放新来源验证不再回审，同时真实新优惠/变化不丢。

提交完整dry-run/apply-local/rollback-local记录和未解决簇清单。生产apply必须停在授权边界，不能把测试库成功描述为线上整理完成。

## 6. 每个任务的完成合同

- [ ] 明确本任务覆盖的SPEC条款、输入/输出接口及迁移。
- [ ] 新增测试在旧代码上出现预期失败，保留命令与失败摘要。
- [ ] 最小实现后 targeted tests通过。
- [ ] `npm run typecheck`、`npm test`全部通过；前端改动加`npm run build:web`及实际浏览器验证。
- [ ] migration fresh-install、已有数据upgrade、失败/并发及幂等测试通过。
- [ ] diff不含密钥、真实客户/生产数据、临时runner、意外workflow/lockfile变化。
- [ ] 对照SPEC自审；有独立reviewer时再审，没有则明确只有自审。
- [ ] 单独commit/PR，描述实际验证范围、未验证项、依赖风险及下一任务。

任何项目全套测试失败都必须按名称报告，包括此前已存在的失败，不用“不是我改的”隐去。未经授权不操作生产；同时也不能用需要生产授权为由放弃本地可完成的实现和测试。

## 7. 可直接交给Codex的任务文本

> 请处理accesaver-byte/ai-yangmao。先读取AGENTS.md、现行data-contract和learned-rules，再读取docs/specs/2026-10-10-codex-handoff.md及其链接的第二/三阶段SPEC。PR #2已经实现第一阶段三个修复，请检查最新diff与测试，不要重做。PR #2未合并时从其远程分支新建feat/benefit-identity-v2，已合并则从最新main新建；保留本地未提交工作。
>
> 按P2-A到P2-F逐项实现，每项先写红测、最小修改、完整验证、提交。事实身份/条款版本/收录决定必须分开；已拒leads即使没有offer也要有持久scope决定；不能只提高相似度阈值或扩写提示词。保留真实变化、资格差异、现行Mistral及lead-scope保护，不能降低测试标准换通过。
>
> 第二阶段完成并验收后再执行P3-A到P3-D。历史整理默认只读/本地dry-run；不删历史记录，不自动选择冲突的主记录，不改真实通知回执。所有生产迁移、部署、采集、消息发送、merge main和生产apply都需我另行授权。不要因本地存在token就扩大权限。
>
> 遇到代码基线/规则与SPEC冲突，读取最新来源后记录ADR和测试，作最小安全调整；不可悄悄改收录规则。每项报告改了什么、实际测试输出、未验证部分和剩余事项。产出小PR，不自动合并。

## 8. 阅读与执行时的已知局限

这是一组设计要求与任务计划，不是对生产数据库大小、当前重复率或语义模型精度的已测量结论。phase-one测试数量来自固定提交；今后的通过数量会随新增用例变化。本文没有独立第三方代码审查结论；PR仍需要正常review、迁移验证与发布授权。
