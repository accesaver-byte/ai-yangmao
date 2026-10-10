# 第一阶段：重复审核链路修复与验证

日期：2026-10-10。基线：`7cea69d95d2c27e2c1ebd7641a94bab2a696901d`；已验证的代码提交：`ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`。

## 本次实际修复

1. `pipeline/run.ts`：初抽收到服务端 `duplicateId` 时关联主记录，不再把已解决重复当成失败送回 reviewing。没有明确关联对象的 skipped、真实 error、多候选部分失败仍保留重试。
2. `src/shared/review-stability.ts`、`src/worker/index.ts`：以同一官方来源中确实替换的权益事实为准，允许“每天100积分→每月100积分”等数字相同的实质变化进入提案。公开已批准版本保持不变；无实质变化的改写不重审；正在人工编辑的提案字段仍受保护。
3. `src/worker/admin.ts`：拒绝更新提案时，拒绝条款记忆、审核日志、提案删除通过 D1 batch 事务提交。新 decisionKey 把后两条 SQL 限定到本次成功插入；版本不匹配时全部不写并返回409；SQL失败回滚，不能只删除提案而遗失拒绝记忆。

新增 `migrations/0016_rejection_decision_key.sql` 和对应 Drizzle 字段。保留基线已有的 Mistral 原文身份匹配与来源范围检查，没有降低相似度阈值，也没有加入全局自动合并。

## 验证证据

验证在隔离分支的 GitHub Actions / Node 24 上执行；Worker 集成用仓库现有的 migration-backed SQLite harness，不是生产 D1。

- 基线：typecheck 通过，331 个 Vitest 测试、8 个 CLI 测试通过。
- 新增12个回归/保护测试。产品修复前6个失败，涵盖已拒/已批准重复回队、两种人工编辑状态下的同数字周期变化、拒绝时版本竞争、审核日志失败回滚。
- 第一轮红测发现测试 helper 假设所有500响应为JSON；修正测试 helper 后重新红测，确认6个均为行为断言失败，而不是JSON解析异常。
- 修复后：`npm run typecheck`、完整 `npm test`（343个 Vitest + 8个 CLI）、`npm run build:web` 和 `git diff --check` 全部通过。
- 基线和红测运行：https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054647933
- 修正红测及完整绿测运行：https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054794747
- 第二次运行的 `phase1-red-green-validation` artifact 包含日志、实际修复patch、源文件快照、已验证提交与npm audit结果；artifact设定14天保留。

为访问Node24和真实锁文件依赖，执行期间使用了临时分支专用验证workflow和补丁runner。最终PR差异已移除这些临时文件，不修改任何现有workflow。没有读取生产密钥、运行线上采集、发送消息、部署或修改生产数据库。代码diff已自检；未声称经过独立第二位审查者审查。

## 上线顺序（本次未执行）

合并不等于部署。发布者必须核对当前生产版本、确认D1备份/恢复点，再先应用增量迁移，后部署Worker，最后执行不发送消息的验收。

1. 在隔离环境检查已有迁移，再应用0016，执行同一套测试；确认旧记录的decision_key为NULL且仍可读取。
2. 经管理员单独授权后，按现行operations.md对正确的生产D1应用迁移。
3. 确认迁移完成后部署新Worker；不要让新schema先于D1列上线。
4. 如需回滚，回滚Worker版本并保留新增列/索引；不要DROP拒绝记忆或清空历史。

`0016`编号以本分支为准；若main后来增加同编号迁移，合并前重新编号并重跑migration-backed测试，禁止覆盖别人的迁移。

## 第二/第三阶段实施SPEC

先读 [Codex执行入口](superpowers/specs/2026-10-10-dedupe-handoff.md)，再读 [第二阶段：统一身份与审核记忆](superpowers/specs/2026-10-10-dedupe-phase2.md) 和 [第三阶段：历史回填与合并](superpowers/specs/2026-10-10-dedupe-phase3.md)。这些是待实施规格，不是已实现或已上线功能。

本PR不是完整语义去重系统。跨语言/跨页面统一身份、结构化拒绝范围、从未生成offer的拒绝线索、通用资格冲突、并发不同ID身份约束、明确重开审核、候选级部分失败账本、跨页面条款变化三态，以及历史重复合并，属于后续SPEC，不在此补丁中宣称完成。

安装时 `npm audit` 报告4个high依赖项：miniflare、sharp、source-map-js、wrangler；其中存在传递依赖关联，不能解读为4个独立的线上可利用漏洞。本次不升级锁文件；发布者应单独审查实际运行面和升级兼容性。完整audit JSON保存在验证artifact中。
