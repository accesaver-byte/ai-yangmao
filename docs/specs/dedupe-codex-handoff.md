# Codex 交接：活动身份、拒绝记忆与历史去重

日期：2026-10-10。本文是后续执行提示，不表示第二/第三阶段已经实现。

## 给 Codex 的提示词

将下面整段交给项目中的 Codex；不需要重新手工复制第一阶段的代码修改。

```text
你正在维护 accesaver-byte/ai-yangmao（AI 羊毛牧场）。

请先读取：
1. AGENTS.md
2. docs/data-contract.md、pipeline/learned-rules.md、docs/operations.md
3. docs/phase1-dedupe-fix-2026-10-10.md
4. docs/specs/dedupe-phase2-3.md
5. docs/specs/dedupe-phase2-3-plan.md

任务：按规格实施第二阶段统一活动身份、来源观察、条款版本、拒绝决定和候选级处理闭环；第二阶段代码完成后，另起变更实施第三阶段历史扫描、经批准计划的逻辑合并及冲突可逆回滚工具。分阶段分小任务提交，不把两阶段压成一次大重构。

先核对当前分支、未提交改动、origin/main和PR #2。第一阶段已有独立分支 fix/dedupe-review-stability-20261010；其产品代码已验证提交是 ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4，main基线当时是7cea69d95d2c27e2c1ebd7641a94bab2a696901d。读取实际最新代码，不重放旧补丁，不覆盖后来新增的修复。PR未合并时可以在新的本地独立分支上基于该PR继续，不自行合并main。

先执行基线检查，随后创建docs/implementation/dedupe-progress.md，逐项执行计划中的12个任务。每项先写可重现问题的行为测试并确认失败，再实现，再运行npm run typecheck、完整npm test和git diff --check；涉及UI/公开接口还须npm run build:web。数据库修改要在空库及旧版本快照上跑migration-backed集成测试。不能用只mock结果的测试来证明实际SQL正确。

必须解决两个核心体验：
- 同优惠在不同语言、URL、页面或生成ID下出现，关联同一个主体/版本；已经批准或拒绝的同版事项不再新增人工审批。
- 真正不同的资格、产品、池、单位、轮次，以及真实条款变化不能被误合并或静默丢弃。

重要约束：
- 模型sameAs/标题/数字相同只是线索；通过服务端统一resolver与证据关系确认。
- 先区分活动身份，再比较条款；保留SAME/CHANGED/INSUFFICIENT三态，未知不当相同。
- 被拒绝但从未生成offer的线索同样要有持久、可检索、有限作用范围的拒绝决定。
- 同一页多候选逐项落处理结果，只重试失败项；duplicate是成功终态，不是写入错误。
- 人工提案和已批准公开字段受保护；身份link不等于approve，补链接不等于reopen。
- 并发通过持久键、版本/partition epoch CAS和D1 batch约束。0行匹配不是事务异常，必须让依赖写也不执行。
- 历史默认dry-run。合并需固定plan hash、成员版本与管理员明确批准；逻辑合并保留全部原始证据/审核/修订/送达记录，旧链接仍可用，通知不能重推。
- 一旦历史发生合并，关闭新resolver仍须保留canonical兼容读；不能回退到会重新公开loser的旧Worker。

当前授权仅是代码、测试和明确的离线/本地演练及提交分支/PR。不授权部署、合并main、生产数据库导出/迁移/合并/清理、真实采集、付费模型调用或实际消息发送。不要自动读取.prod.secrets；本地验证有凭据不代表可访问生产。计划中的shadow采样和生产apply是后续发布者的验收门槛，不要为了勾选任务擅自执行。

若没有生产快照或真实隔离D1授权，使用合成/已授权本地夹具交付工具，并明确哪些验证未执行，不能声称线上已清理。已有依赖audit high项另行报告，不借此无关升级整个锁文件。

每个阶段交付：代码diff、迁移/回滚说明、红绿测试结果、固定golden语料结果、剩余风险、实际提交/PR、未执行的上线步骤。判断成功不能只看待办减少，必须同时检验真实新活动和条款变化仍被保留。
```

## 文件职责

| 文件 | 用途 |
|---|---|
| `docs/phase1-dedupe-fix-2026-10-10.md` | 已实现的3个具体修复、12项新增测试、真实验证证据及0016发布顺序 |
| `docs/specs/dedupe-phase2-3.md` | 业务不变量、数据模型、身份/条款/拒绝算法、API、历史计划与回滚、验收和启用门槛 |
| `docs/specs/dedupe-phase2-3-plan.md` | 12个有依赖、接口、文件和测试的实施任务；任务1–9为第二阶段，10–12为第三阶段 |
| 本文件 | 直接粘贴给Codex的任务/边界与交接要求 |

## 第一阶段发布提醒

PR #2含增量迁移 `0016_rejection_decision_key.sql`。**先迁移D1，再部署对应Worker**，否则新schema读取新增列会失败。当前并未执行该生产迁移或部署。main若后来占用同编号，应合并前重编号并重新验证，不能覆盖旧迁移。

第一阶段验证是在Node24 CI上执行：343个Vitest、8个CLI通过，typecheck和build:web通过；SQLite测试不等于真实D1已验收。第二、第三阶段不得将这个通过数沿用为自己尚未执行的验证结果。
