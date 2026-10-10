# 去重第二、三阶段：Codex执行交接

> 实施入口：先读两份SPEC，再按本文件的切片执行。每片先写失败测试、运行确认，再实现并运行完整套件。可用superpowers:executing-plans或等价本地工作流；不要因技能不可用跳过测试/权限边界。

**Goal**：同一羊毛只审核同一事实版本一次，持久记住拒绝；对真实政策变化生成提案；安全整理历史重复而不丢审批、引用或通知收据。

**Architecture**：保留现有offers公开投影，增加活动身份、不可变条款版本、观察/候选和有作用域的审核决定。新数据先统一身份，历史先一对一回填，再通过可审计、可回滚的逻辑合并整理。

**Tech stack**：现有Node24 / TypeScript / Hono / Drizzle / D1 / GitHub Actions；不引入付费向量服务为前置。

**Specs**：
- [P2：身份与审核记忆](../specs/2026-10-10-phase2-identity-and-decision-memory.md)
- [P3：回填与历史合并](../specs/2026-10-10-phase3-history-backfill-and-merge.md)
- [P1：已实现代码、验证和迁移边界](../phase1-dedupe-fix-2026-10-10.md)

## 0. 接手第一阶段，不要重做

第一阶段PR： https://github.com/accesaver-byte/ai-yangmao/pull/2
修复分支：`fix/dedupe-review-stability-20261010`。
基线main：`7cea69d95d2c27e2c1ebd7641a94bab2a696901d`。
已验证代码提交：`ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`，随后仅清理临时文件和添加文档；以PR最终diff/CI为准。

已实现三项：duplicateId终态闭环、同数字真实权益变化进入提案、拒绝记忆/日志/提案删除的原子提交。不是完整语义去重。不要删除最近的Mistral原文匹配和lead-scope保护，也不要把已验证修复重新生成一遍。

本地先查看工作区状态。不要reset/clean覆盖用户修改，不要直接checkout强切到新分支；使用用户认可的隔离worktree。若PR已合并，从当前main开后续分支；若未合并，从最新修复分支建立第二阶段分支，并明确stacked PR依赖，不要偷偷合并PR #2。

第一阶段含`0016_rejection_decision_key.sql`。生产发布必须先迁移后部署，当前任务没有执行该动作；新schema提前于D1列上线会影响请求。若0016编号被占用，先解决迁移编号与台账，不覆盖别人的迁移。

## 1. 全局约束

- 不自动merge main、不部署、不运行生产db:migrate/seed、不开enforce、不apply历史合并、不发Telegram/飞书消息。
- 不读取/打印/提交`.prod.secrets`、`.dev.vars`和tokens；默认本地/隔离D1，远端命令需单独授权。
- 数据合同、learned-rules、platform-notes和AGENTS.md仍是现役业务约束；SPEC不是新收录政策。
- 每片必须保留人工字段/实测等级、原文语言、金额与价值V1合同；内部理由不出现在公开投影。
- 每次说明哪些结果实测、哪些未验证；不能以测试通过推断已经部署。
- 未知索引/证据/模型结果必须deferred/uncertain，不当作无历史或新活动。
- 不靠降低阈值解决跨语言，不靠全平台拒绝名单记忆拒绝，不靠DELETE清理历史。

## 2. 接口与实现补充裁定

这些细节补齐SPEC中的实现边界，执行时不得忽略：

1. **产品串行lease**：实现`identity_product_leases(product_id PK, owner_token, fence INTEGER, expires_at)`。claim用原子条件更新/插入；续租和结果提交检查相同owner+fence。lease默认10分钟；过期worker不能提交。它只是消除并发可见性缺口，不证明两个语义对象相同。
2. **候选关联**：统一使用`lead_candidate_links(lead_id,candidate_id,PRIMARY KEY(...))`，不要只在candidate上放单个lead_id；不同来源可能归入同candidate/活动。
3. **compare结果接口**：`resolveCandidate(input, context)`返回P2§6四态关系；`compareTerms(before,after,evidence)`返回same/changed/insufficient；`applyResolution(command)`消费带expectedRevisions/lease fence的结果，返回P2§7业务outcome。模型不得调用apply/approve。
4. **租约和引用的新表**：与P2-B同片迁移、类型和测试，不在后续路由里临时建表。`accepted_version_id`的entity归属必须有事务内完整性检查，不能只验证version存在。
5. **合并审计枚举**：P3采用独立`identity_merge_events`，不扩张P2通用review_decisions action为隐式merge。merge_jobs.decision_id引用管理员明确link/superseding决定；所有origin记录不可变。
6. **模式切换**：IDENTITY_MODE=off只关闭新resolver；一旦存在merge关系，alias-aware读取始终启用。代码回滚只能到具备此兼容性的版本，或先执行安全unmerge，不能用关闭开关恢复重复展示。
7. **未知聚类**：缺乏硬锚点时同一候选簇仅一个身份任务；不同provisional实体的same/distinct关系任务key使用排序后的实体ID+事实版本，来源追加不新建同一关系任务。人工确认same需记录组内各成员到root的依据；已存在实体的自动合并仍禁止。
8. **回滚能力**：“可回滚”默认指未发生依赖的后续变更；不是承诺任何时间都能自动unmerge。遇到新审核/新发送必须输出补偿计划，不覆盖用户后续数据。

## 3. 执行顺序与每片完成合同

顺序：P2-A → P2-B（包含P3-A最小bootstrap）→ P2-C → P2-D → P2-E → P3-B → P3-C/D → P3-E。P3-A先做基础回填，不提前语义合并。

| 切片 | 文件/接口 | 首批必须红测的行为 | 完成条件 |
|---|---|---|---|
| P2-A | `src/shared/identity/{types,facts,urls,compare}.ts`；`tests/identity-facts.test.ts`；fixture | 同数字不同周期、unknown、产品/资格/pool冲突、跨语言等价 | 纯函数合同及fixture通过，不修改路由 |
| P2-B | schema/增量migrations；`src/worker/identity/repository.ts`；leases；`tests/identity-store.test.ts` | 同key重放、key/payload冲突、guard零行、事务SQL故障、fence过期 | 真SQL原子性通过；off模式旧链路兼容 |
| P3-A基础 | `scripts/identity-backfill.ts`；`tests/identity-backfill.test.ts` | 中断续跑、旧rejected lead无offer、同快照二跑、变更/小主键补漏 | preview默认只读，one-to-one映射不改公开/通知 |
| P2-C | resolver/FTS repository；`pipeline/identity-review.ts`；`tests/identity-resolver.test.ts` | 跨来源重复、候选截断、索引故障、非法sameAs | shadow只记录建议；预算/模型故障不放行 |
| P2-D | decisions/tasks/routes及旧入口适配；后台；通知 | 拒绝scope、新证据重开、多候选部分失败、权限、重复通知 | 所有入口同一resolver；任务和决定一致；公开不泄密 |
| P2-E | 隔离D1验收、golden/holdout报告、运维 | 新旧schema兼容、10k/50k性能fixture、端到端回放 | 验收报告，enforce默认关闭；未授权不发布 |
| P3-B | merge-preview脚本/接口 | A≈B≈C冲突、两个approved冲突、手工字段冲突 | 只出候选及阻塞项，无自动写入 |
| P3-C/D | merge.ts；canonical读取；旧链接和通知保护 | 重叠merge、未知发送、CAS、各公开聚合去重 | apply受管理员明确确认，所有读/通知路径兼容 |
| P3-E | rollback接口/脚本；故障注入；运维 | 无后续依赖可撤销、有后续审核/发送则阻塞 | 脱敏before/after、回滚/补偿证据及未解决清单 |

每片按以下五步提交：

- [ ] 建立该片测试（从SPEC对应P2/P3编号选择），先对当前实现运行并确认预期行为失败，不接受语法/导入错误充当红测。
- [ ] 实现最小生产逻辑，不合并未完成的其他片；新增数据结构有Zod+SQL约束。
- [ ] 运行目标测试和完整`npm run typecheck && npm test`；前端加`npm run build:web`，运行`git diff --check`。
- [ ] 自检真实权限、公开字段、手工保护、SQL失败/零行、同key重放和未验证范围。可用独立代码审查，但不能把自己自检称第二位审查者。
- [ ] 单独commit/PR，附测试命令/实际结果、迁移、回滚、feature flags、剩余风险和对应SPEC编号。

整个SPEC不是“一次把所有代码改完然后上线”的任务。每片必须有可独立验收的结果；涉及环境、权限、不可逆操作时停止在预览，不用生产尝试填补信息缺口。

## 4. 五项特别审查

1. 资格或模型冲突的特例返回false后，通用标题分支不能再把独立权益合并；对应P2-07/P2-08/P2-28。
2. same条款哈希里unknown不等于相同身份；低可信来源不能刷新官方核验；对应P2-22/P2-25/P2-29。
3. 任何SQL零行与审计失败都不能出现“删了提案、没保存决定”；对应P2-18/P2-19、P3-12。
4. 产品lease过期和并发新来源不能产生双上架；对应P2-17、P3-11。
5. 合并后通知、旧链接、回滚不能丢原始审计或覆盖新人工操作；对应P3-09/P3-10/P3-14/P3-15。

## 5. 给Codex的启动指令

```text
请在当前ai-yangmao仓库执行去重第二阶段，暂不执行第三阶段生产合并。
先读取AGENTS.md、docs/phase1-dedupe-fix-2026-10-10.md、
docs/specs/2026-10-10-phase2-identity-and-decision-memory.md、
docs/specs/2026-10-10-phase3-history-backfill-and-merge.md、
docs/plans/2026-10-10-dedupe-codex-handoff.md，以及现役数据合同/规则。

核对PR #2和当前分支，保留最新修复，不覆盖本地未提交文件。
先完成P2-A，再按交接顺序推进；每片先红测再实现，完整typecheck/test通过后单独提交。
P2-B只实现P3-A的基础一对一回填，不进行语义合并。
实现默认off/shadow，不自动merge main、部署、迁移生产D1、seed、发消息或开启enforce。
生产权限和任何apply操作另行确认。报告每片代码、实际测试、未解决风险及下一片依赖。
```

## 6. 发布者必须知道

第一阶段已有343个Vitest+8个CLI绿测记录，但这不是第二/三阶段测试结果。新增SPEC尚未实现，也没有生产去重成效统计。第一阶段npm audit有4个high受影响依赖项（含传递关联），需另行检查运行面和安全升级；本次未修改锁文件。

现役运维命令以operations.md为准。发布前确认正确Cloudflare账号、DB、已应用迁移、恢复点和最终CI。数据库增量迁移先于读取新列的Worker；线上核验与代码合并是独立步骤。
