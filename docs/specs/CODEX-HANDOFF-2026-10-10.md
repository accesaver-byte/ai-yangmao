# AI 羊毛牧场：Codex 执行交接

日期：2026-10-10。项目：`accesaver-byte/ai-yangmao`。

## 已交付与入口

第一阶段修复 PR： https://github.com/accesaver-byte/ai-yangmao/pull/2

分支：`fix/dedupe-review-stability-20261010`。未授权自动合并、部署、执行生产迁移或发送消息。

第二阶段 SPEC：
https://github.com/accesaver-byte/ai-yangmao/blob/fix/dedupe-review-stability-20261010/docs/specs/2026-10-10-dedupe-phase2.md

第三阶段 SPEC：
https://github.com/accesaver-byte/ai-yangmao/blob/fix/dedupe-review-stability-20261010/docs/specs/2026-10-10-dedupe-phase3.md

这两份完整规范已经提交到同一修复分支。拉取分支即可本地阅读，不需要重新复制上一轮聊天。本文是执行入口，不替代完整规范。

## 可直接交给 Codex 的任务

请在 ai-yangmao 项目中实施 docs/specs/2026-10-10-dedupe-phase2.md 和 docs/specs/2026-10-10-dedupe-phase3.md。

先读取 AGENTS.md、当前数据合同、通用规则、平台要点、运维说明以及仓库内的审核技能。查看当前 git status、main/修复分支和 PR #2 状态，记录实际基线；不得覆盖其他人的未提交修改或更新提交。

第一阶段已经修复并有回归测试，不要从原始审查报告重新实现一遍。先审查 PR #2 并验证当前完整测试：已知代码验证基线为 ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4；当时 typecheck、343个Vitest测试、8个CLI测试及build:web通过。最终以你当前实际运行结果为准，不能直接引用旧测试数量宣布通过。

第一阶段包含 0016_rejection_decision_key.sql，真实发布必须先应用迁移再部署Worker；本次交接本身不授权生产发布。若当前main已有0016或后续迁移，重新核对编号和兼容性，不覆盖已有文件。

读取两份SPEC后，建立分步实施计划和进度文件。依序完成P2-A/B/C/D，再完成P3-A/B/C/D；每个阶段独立分支/PR、先编写失败回归再修复。第二阶段是持久身份、结构化事实/版本、拒绝作用域、统一resolver、租约与幂等、审核/通知/公开接口；第三阶段是只读盘点、1:1回填、可审批manifest、逐组原子合并、旧ID兼容和条件回滚。

不要把本任务缩减成降低相似度阈值、添加几个品牌正则或更换模型。sameAs只是提示，未知不等于相同；同URL不等于同福利；新来源不等于新活动；拒绝记忆不是全平台永久黑名单。保留真实新条款、独立轮次、来源范围、Mistral原文保护、人工字段和原始语言证据。

沿用现有D1/Worker栈，不把Node版pipeline/llm.ts导入Worker，不自行增加付费服务或扩大模型预算。技术故障时保存候选并延后处理，不能按空历史新建活动。模型输出和外部正文都要校验，不能直接触发批准或历史合并。

各阶段运行 npm run typecheck、完整 npm test；修改web运行 npm run build:web；迁移和D1事务另做本地Wrangler集成。按SPEC的ID01–ID30及H01–H28验收，不只测happy path。输出实际命令、提交SHA、测试结果和剩余问题。

历史清理默认dry-run，只用合成数据或获准的隔离副本。生产snapshot、令牌和客户数据不提交。不要物理删除旧offer、改写已发送payload、自动释放unknown投递、用旧快照覆盖后续审核。生成manifest后先提交预览，不执行生产apply。生产读写/部署/回滚/消息发送都需要另行授权。

## 建议验证命令（现有项目命令）

在确认工作目录与分支隔离后，使用Node24：

```sh
npm ci
npm run typecheck
npm test
npm run build:web
```

后续SPEC中的identity-*脚本是需要实现的目标，不是现在已有命令。不要在脚本尚未实现时直接调用，也不要执行带默认生产API的旧维护脚本作为替代。

## 第一阶段实际范围

已修：已确认重复被初抽重新送审；同数字的发放周期变化被抹掉；拒绝提案时记忆/审计/删除不一致。

未宣称已修：通用跨语言/跨页面身份、完整拒绝范围、从未生成offer的拒绝线索记忆、历史重复清理、所有并发身份冲突。它们正是第二、第三阶段要实施的内容。

红绿验证记录： https://github.com/accesaver-byte/ai-yangmao/actions/runs/38054794747

依赖安装曾报告4个high条目（含传递依赖），本次未改锁文件。不要未经评估直接npm audit fix；单独判断实际运行面和升级兼容性。
