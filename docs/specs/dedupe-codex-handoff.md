# Codex交接：第二、三阶段去重改造

状态：设计交付，尚未实施。先读[规范入口与合同补充](README.md)，再读[主SPEC](dedupe-phase2-3.md)及[12步计划](dedupe-phase2-3-plan.md)。以下整段可直接交给项目中的Codex。

```text
维护仓库 accesaver-byte/ai-yangmao（AI羊毛牧场）。

先读取 AGENTS.md、docs/data-contract.md、pipeline/learned-rules.md、docs/operations.md，以及以下四份交付：
- docs/phase1-dedupe-fix-2026-10-10.md
- docs/specs/README.md（最终合同补充，必须读取）
- docs/specs/dedupe-phase2-3.md（唯一主SPEC）
- docs/specs/dedupe-phase2-3-plan.md（12个实施任务）

先核对当前工作区、未提交改动、origin/main和PR #2。第一阶段已有分支fix/dedupe-review-stability-20261010，产品代码验证提交ba9724f5a39bff1b0640c4a1f4618ef0a9fdf5b4。使用实际最新代码，不重放旧补丁、不覆盖后续修复；PR未合并时可在自己的独立分支基于PR继续，不自行合并main。

按计划任务1–9实现第二阶段：统一subject身份、observation/candidate账本、条款版本、有限范围的拒绝决定、所有写入口的统一resolver、原子CAS提交、唯一审核任务及通知。通过阶段验收后另起变更完成任务10–12：历史只读扫描、固定计划、经批准的逻辑合并、引用兼容与冲突可逆回滚工具。不要一次大重构，也不要再复制平行SPEC。

先执行Node24基线检查，创建docs/implementation/dedupe-progress.md。每个任务先写实际行为失败测试，再实现，再执行npm run typecheck、完整npm test、git diff --check；涉及web/公开接口加npm run build:web。数据库用空库和旧库迁移harness测试，SQL与身份函数不能mock为固定成功。逐任务提交并记录SHA、红绿结果和未完成项。

必须同时保证：同优惠不同语言/页面/ID不新增同版审批；真正不同产品、机制、资格、模型池、设备代际与独立轮次不误合并；同数字的周期/单位变化有新提案；已批准公开字段与人工提案不被覆盖；没有offer的拒绝线索也有持久、可检索、有范围的决定。模型sameAs/标题相似/金额相同只能召回，不能授权合并或批准。

遵循规范补充的material_revision、identity/content revision、command状态与partition epoch。零行CAS不是SQL异常，所有依赖write必须受本次marker约束。写后超时用原commandKey读回。多候选只重试未解决项；manual补链不是reopen。历史送达pending/unknown不伪造成功、不自动重发；每日常驻榜保留既有按日展示行为。

历史工具默认dry-run，保留全部证据/审核/修订/送达记录，不硬删除旧offer、不相加估值、不把合并当新上架。旧fragment和收藏可解析到canonical。历史合并后关闭resolver也不能关闭canonical兼容读；回滚遇新人工修改必须报告冲突。

授权仅代码、测试、本地/离线演练、独立分支与PR。不授权合并main、生产数据库导出/迁移/合并/清理、部署、实际采集、付费模型调用或真实消息发送。不要自动读取.prod.secrets；有凭据不扩大授权。计划中的真实shadow运行日和生产apply由发布者以后另行授权。

没有生产快照或明确隔离D1授权就用合成/已授权本地夹具交付，并列明未执行验证。每阶段输出实际diff/SHA/PR、测试、migration及回滚说明、风险和未执行的上线步骤，不能把第一阶段通过数当作新阶段已验证，也不能只凭待办减少宣称成功。
```

## 第一阶段发布注意

PR #2包含`0016_rejection_decision_key.sql`，必须先迁移数据库、再部署Worker。本次未执行任何生产迁移或部署。实施时核对迁移编号；若main已占用，重编号后重跑迁移测试，禁止覆盖旧migration。Node24 CI的343个Vitest和8个CLI通过，仅证明第一阶段；未进行真实生产D1验收。
