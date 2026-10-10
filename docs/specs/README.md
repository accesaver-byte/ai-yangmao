# 去重改造：规范入口与最终合同补充

状态：设计交付，第二、第三阶段尚未实施。此目录不替代现役data-contract/learned-rules的收录口径。

本次交给Codex的文件只有以下三个实施入口：

1. [主SPEC：第二阶段统一身份与拒绝记忆；第三阶段历史治理](dedupe-phase2-3.md)
2. [实施计划：12个独立可测试任务](dedupe-phase2-3-plan.md)
3. [可直接粘贴给Codex的交接提示](dedupe-codex-handoff.md)

已实现内容及真实测试证据见[第一阶段修复记录](../phase1-dedupe-fix-2026-10-10.md)，对应PR #2。不得按旧的平行草稿另外建立一套entity/表结构；最终名称以主SPEC的subject为准。

## 合同补充与冲突处理

以下细化属于主SPEC的组成部分；实现时同步写回对应章节和测试。与实现计划的口头简称冲突时，以这里的精确定义为准。

### 任务版本与通知版本

`review_cases`必须增加`material_revision INTEGER NOT NULL DEFAULT 1`，与已有`revision`分开。revision用于任务编辑的CAS；material_revision仅在可影响判断的新实质事实、有效重开或人工裁决时递增。补充相同来源、lastSeen、seenCount和模型改写不递增material_revision。审核通知键为`caseId:materialRevision:channel`。

subject的identity_revision在身份/有效别名更正时递增；content_revision在已批准事实版本变化时递增。纯抓取/核验元数据不使两者变化。任何影响解析结果的身份、决定、条款修改仍必须推进对应partition epoch。不能因提醒版本不变而跳过数据库竞争保护。

### 命令状态与事务标记

`identity_commands`增加`partition_id`、`expected_epoch`、`status`（applying/complete）。一个请求的commandKey和requestHash永久配对；同key不同payload返回409。

事务第一条条件INSERT只有在epoch、目标revision及权限前提仍成立时建立本command。后续所有SQL依赖本次成功marker；最终同一事务保存完整result_json和complete状态并推进epoch。CAS零行时全部依赖写零行；SQL失败全回滚。事务外不能持久保留可被误当成功的applying结果。响应丢失后用原key读回，不换key再次创建。

### 身份未定与候选级状态

有强证据的确定同主体、同版样例必须自动关联，不得为得到“零误合并”把整个golden标为uncertain。仅有弱相似而无足够身份依据的样例，可以进入一个身份核对任务；不能承诺所有无共同锚点的任意多语言输入天然聚为一个任务。记录这类人工负担和真实逃逸，不能隐瞒。

lead汇总以完整candidate账本为准：全部已解决且有offer可linked；全部被既存拒绝决定抑制且无offer可rejected，但只引用原决定、不虚构新业务拒绝；有未决身份/补证case时reviewing并挂case，已接手candidate不重跑初抽；deferred只重试对应candidate；invalid保留诊断或人工修正，不算业务拒绝。legacy offer_id不得伪造。

### 通知与回滚边界

首次上架与条款变化事件按canonical subject/获批version幂等。飞书常驻榜的按日重复展示是既有产品行为，应保留并加测试，不受“首次提醒只一次”规则误伤。pending/unknown送达既不能自动确认为sent，也不能因新批次指纹而重发。

历史合并后，无论IDENTITY_MODE是否关闭，canonical映射、公开去重与旧ID兼容仍须生效。回滚只关闭新解析，不降级到不认识映射的Worker。单组撤销遇合并后的人工修改、候选或送达需报告冲突，不回写旧快照覆盖新事实。

### 数据约束与运行范围

legacy_offer_id确认映射须全局唯一，不能因产品更正而形成两个根；其他官方强别名按平台和scope唯一。`approved_terms_id`实际创建时补FK到offer_terms_versions，初始化可以先空指针再在事务内更新。不要因为循环引用先后顺序困难而永久省掉关系校验。

此交付不包含生产数据库快照，不授权生产读取/迁移/合并、部署、付费模型评测或消息发送。shadow运行日和线上误判率只能由以后经授权的真实验收提供；现有第一阶段343个Vitest与8个CLI通过，不可当作第二/第三阶段已完成测试。
