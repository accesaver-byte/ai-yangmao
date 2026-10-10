# Codex 执行入口

日期：2026-10-10。项目：`accesaver-byte/ai-yangmao`。

**本轮交付使用 [PR #3](https://github.com/accesaver-byte/ai-yangmao/pull/3)**，分支 `fix/dedupe-verified-20261010-3f21d987`。PR #2是原工作分支；它在操作期间出现了额外并行提交，不要与本PR重复合并。SPEC-02中对PR #2的引用仅指原始修复历史，执行以本入口和当前分支实际文件为准。

完整规范：[第二阶段](2026-10-10-dedupe-phase2.md)、[第三阶段](2026-10-10-dedupe-phase3.md)。两份均为待实施设计，不是已经上线的功能。

## 可直接执行的开发任务

在开始前读AGENTS.md、现役数据合同、通用规则、平台要点、运维说明和仓库内审核技能；检查git status、main及PR #3状态，记录实际基线。不要覆盖其他人的未提交修改或较新提交。

第一阶段三个修复已完成：成功查重不再回审核队列；同数字的周期变化按官方事实生成提案；拒绝记忆/审计/提案删除原子提交。不要从原审查报告重新实现。八个代码/测试/迁移文件与已验证提交 `ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4` 字节相同；当时343个Vitest测试、8个CLI测试、typecheck和build:web通过。你必须实际重跑当前版本验证，不能引用旧数字宣布通过。

读取两份SPEC，建立可提交的实施计划与进度。依序完成P2-A/B/C/D，再P3-A/B/C/D，每个阶段独立分支/PR，先失败测试再实现。第二阶段统一实体、来源观察、事实版本、拒绝范围、resolver、候选级回执、并发/租约和审核通知；第三阶段实现只读盘点、幂等回填、审批manifest、逐组事务合并、旧ID兼容及条件回滚。

不要把要求缩减成降低相似度阈值、添加品牌正则、扩大prompt或换模型。sameAs只是提示，未知不等于相同，URL不等于福利，新来源不等于新活动，拒绝也不是永久平台黑名单。保留Mistral原文匹配、lead-scope来源边界、人工提案字段、估值合同及原语言证据。真实新条款和独立新一轮活动必须能进入审核。

沿用D1/Worker栈，不把Node版pipeline/llm.ts导入Worker；模型任务用现有预算与provider，不擅自增加付费服务。技术失败保存候选并延后，不能把历史库不可读当作没有历史。所有自动和人工写入入口使用同一身份服务，不能保留旧接口绕过。

执行typecheck、完整npm test；涉及web执行build:web；新增迁移/事务须本地Wrangler D1集成。按ID01–ID30、H01–H28验收并记录命令、结果、SHA和未解决问题。使用合成fixtures；网络模型不应成为单元测试的必要条件。

## 发布边界

第一阶段新增 `0016_rejection_decision_key.sql`，必须先迁移再部署Worker。main出现迁移编号冲突时重编号并重测，不能覆盖别人已有迁移。

本次交接不授权合并main、生产导出/迁移/apply/revert、部署、采集或发送消息。历史清理默认dry-run；先展示manifest和组内冲突，生产执行须单独批准。不得物理删除旧offer、改写已发送payload、自动释放unknown投递、恢复旧快照覆盖后续决定，或提交生产原文/令牌。

SPEC列出的identity-*脚本和API是要实现的目标，现在不能假定存在。不要以运行默认指向生产的旧维护脚本代替。

## 现有验证命令

确认隔离分支、Node24及正确目录后：

```sh
npm ci
npm run typecheck
npm test
npm run build:web
```

[原红绿验证](https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054794747)。安装时报告4个high依赖条目（含传递关联），本次未改锁文件；单独评估实际运行面和升级兼容性，不盲目npm audit fix。
