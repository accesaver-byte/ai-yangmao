# 第一阶段：重复审核链路修复与验证

日期：2026-10-10。基线：`7cea69d95d2c27e2c1ebd7641a94bab2a696901d`；已验证的产品代码提交：`ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4`。PR #2尚未合并或部署。

## 本次实际修复

1. `pipeline/run.ts`：初抽收到服务端`duplicateId`时关联主记录，不再把已解决重复当成失败送回reviewing。没有明确关联对象的skipped、真实error、多候选部分失败仍保留处理。
2. `src/shared/review-stability.ts`、`src/worker/index.ts`：以同一官方来源中确实替换的权益事实为准，允许“每天100积分→每月100积分”等数字相同的实质变化进入提案。公开已批准版本保持不变；无实质变化的改写不重审；正在人工编辑的提案字段仍受保护。
3. `src/worker/admin.ts`：拒绝更新提案时，拒绝条款记忆、审核日志、提案删除通过D1 batch事务提交。新decisionKey把后两条SQL限定到本次成功插入；版本不匹配时全部不写并返回409；SQL失败回滚，不能只删除提案而遗失拒绝记忆。

新增`migrations/0016_rejection_decision_key.sql`和对应Drizzle字段。保留基线已有的Mistral原文身份匹配与来源范围检查，没有降低相似度阈值，也没有加入全局自动合并。

## 验证证据

验证在隔离分支的GitHub Actions / Node24上执行；Worker集成用仓库现有的migration-backed SQLite harness，不是生产D1。

- 基线：typecheck通过，331个Vitest、8个CLI测试通过。
- 新增12个回归/保护测试。产品修复前6个行为断言失败，覆盖已拒/已批准重复回队、两种人工编辑状态下的同数字周期变化、拒绝时版本竞争、审核日志失败回滚。
- 第一轮红测发现helper假设所有500响应都是JSON；修正helper后重新红测，确认6个都是实际行为断言失败，而非JSON解析异常。
- 修复后：`npm run typecheck`、完整`npm test`（343个Vitest + 8个CLI）、`npm run build:web`、`git diff --check`全部通过。
- 基线/第一次红测：https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054647933
- 修正红测与完整绿测：https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054794747
- 文档整理后的标准CI：https://github.com/accesaver-byte/ai-yangmao/actions/runs/38056324913 ，typecheck及npm test通过，对应`3f7fda1f059a387cee0c0ca5aba6d12c1aad3ce4`；当前文件链接修订不改变产品代码。

红绿运行的`phase1-red-green-validation` artifact包含日志、修复patch、源文件快照、已验证SHA和audit结果，设定14天保留。临时分支验证workflow与bootstrap已从最终代码树移除；历史红测和临时运行不一定为绿色。没有读取生产密钥、运行线上采集、发送消息、部署或修改生产数据库。已自检，没有独立第二位审查者审查的声明。

## 上线顺序（本次未执行）

合并不等于部署。发布者须核对实际生产版本和D1恢复点，在明确授权后：先应用增量迁移，再部署Worker，最后进行不发送消息的验收。

在隔离环境验证0016与旧记录兼容；旧decision_key为NULL仍可读取。生产操作按现行operations.md执行，不能让新schema先于D1新增列上线。回滚Worker时保留新增列、索引和拒绝记录，不DROP历史。

若main后来新增相同迁移编号，合并前重新编号并重跑migration-backed测试，禁止覆盖他人的迁移。

## 第二、第三阶段设计交付

先读[规范入口与合同补充](specs/README.md)，再读[唯一主SPEC](specs/dedupe-phase2-3.md)、[12步实施计划](specs/dedupe-phase2-3-plan.md)和[Codex交接提示](specs/dedupe-codex-handoff.md)。这些是待实施规范，不是已实现或已上线能力。

本PR不是完整语义去重系统。跨语言/跨页面统一身份、结构化拒绝范围、从未生成offer的拒绝线索、通用资格冲突、并发不同ID身份约束、明确重开审核、候选级部分失败账本、跨页面条款变化三态及历史合并，属于后续SPEC，未在本补丁中宣称完成。

## 依赖警告

安装时`npm audit`报告4个high依赖项：miniflare、sharp、source-map-js、wrangler；存在传递依赖关联，不能理解为4个独立线上可利用漏洞。本次锁文件未修改；发布前应单独评估实际运行面及升级兼容性。完整audit JSON保存在验证artifact中。
