# 去重修复与后续 SPEC：最终交付入口

日期：2026-10-10。

**最终合并候选是 [PR #5](https://github.com/accesaver-byte/ai-yangmao/pull/5)，分支 `fix/dedupe-phase1-reviewed-20261010`。** PR #2 是原始开发/验证分支，最终交付为避免覆盖其并发更新而单独保留到本分支。以下文档中凡提到“第一阶段 PR #2”或旧修复分支，应理解为历史验证来源；开始后续开发时以 **PR #5 与最新 main** 的实际状态为准。

## 文件顺序

1. [Codex 分批执行计划与合同补充](superpowers/specs/2026-10-10-dedupe-handoff.md)
2. [第二阶段：统一活动身份、条款版本与审核记忆](superpowers/specs/2026-10-10-dedupe-phase2.md)
3. [第三阶段：历史回填、重复合并与回滚](superpowers/specs/2026-10-10-dedupe-phase3.md)
4. [第一阶段实际修复、红绿测试与迁移注意](phase1-dedupe-fix-2026-10-10.md)

三份 SPEC 是待实施规范，不代表第二、第三阶段已写完或已上线。第一阶段只修复三个确定缺陷：已识别重复仍回队、同数字周期变化被抹掉、拒绝提案的记忆/审计/删除不原子。

## 给 Codex 的执行说明

请先读取 AGENTS.md、现役 data-contract/operations 和上述文件。核对 PR #5 是否已经合并：已合并，从最新 main 建新分支；未合并，从 `fix/dedupe-phase1-reviewed-20261010` 建后续分支并说明依赖。不要重复实现第一阶段，也不要回到原始 PR #2 的临时草稿/验证文件。

保留本地未提交改动。按 handoff 的 S2-A 至 S2-H、P3-A 与 P3-B 单元分小 PR 实施。每单元先运行失败回归，再做最小实现，运行完整 typecheck/tests；涉及公开界面与构建，追加 build:web/UI 验证。身份判断、条款变化和发布批准必须分开，不以调低相似度阈值替代持久身份与拒绝范围。

历史处理默认只读盘点、dry-run 和计划生成；保留旧 ID、原审核历史和发送记录；实际合并需 planHash、明确批准、版本守卫、原子审计和可解释回滚。没有单独授权，不合并 main、不部署、不执行生产迁移/回填/合并、不线上重新采集、不发送消息。

## 第一阶段发布前置

本分支包含 `migrations/0016_rejection_decision_key.sql`。确认目标数据库与备份/恢复点，核对编号未冲突，先迁移再部署 Worker。此处是发布要求，不是生产操作已执行的记录。回滚 Worker 时保留新增列/索引和拒绝记忆。

测试使用 Node 24 与迁移驱动的 SQLite 集成环境；真实 D1 staging/生产仍须单独验收。原始产品代码验证提交为 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`；最终 PR 另有常规 CI，不能以旧日志代替后续改动的测试。供应链 audit 的4个high受影响依赖项未在此修复中升级，发布前应另行评估。
