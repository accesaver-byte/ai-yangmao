# 第三阶段 SPEC：历史身份回填、重复合并与安全回滚

状态：实施规格，尚未执行任何生产清理。版本：v1，2026-10-10。

前置：[第二阶段统一身份SPEC](2026-10-10-phase2-identity-and-decision-memory.md)。执行入口：[Codex交接计划](../plans/2026-10-10-dedupe-codex-handoff.md)。第一阶段：[代码与验证凭证](../phase1-dedupe-fix-2026-10-10.md)。

## 1. 目标、默认行为与禁止项

为所有现有活动及拒绝线索建立持久身份与决定索引，找出真实重复，经管理员确认后让公开展示、审核任务和通知都使用同一主记录。全过程可预览、分批、断点续跑、审计和有条件撤销。

默认只读preview。`--dry-run`不得写业务表、任务表或发送消息；允许把报告写到本地。写入基础映射、应用合并和回滚均需显式命令与正确环境确认。拿到管理员令牌不等于获得生产清理授权。

禁止：直接DELETE重复offers；依靠标题阈值批量合并；把同公司产品合并；覆盖人工字段；伪造新核验时间/活动日期；让旧拒绝覆盖已批准主记录；把旧alias通知重新发一遍；一条不确定关系污染整个连通分量。

业务行数和重复数量必须从执行时的实际数据库快照统计，不能沿用历史报告中的234等旧数量。

## 2. 两个独立步骤，不能混做

**基础回填（bootstrap）**为第二阶段enforce前置：一旧offer对应一entity及其版本/决定，零语义合并、零公开变更；重复行仍保留。只在新表中增加映射/历史索引，不修改旧offer或审核状态。

**语义整理（merge）**在身份解析器和alias-aware读取已完成后执行：生成重复候选，由管理员确认same/distinct，再统一canonical可见性。它不能作为第二阶段数据库迁移自动执行。

因此允许先实施本SPEC§3的基础回填以支持P2-B，其余步骤在第二阶段验收后推进。

## 3. 基础回填设计

### 3.1 输入与快照

读取offers、leads、reviews、offer_revisions、offer_proposals、rejected_offer_updates、notifications、deliveries和第二阶段新表。所有记录保留原ID、时间、reviewState、来源等级、人工字段、估值及决定理由；任何输出到共享报告的原文/用户信息必须脱敏。

报告manifest至少包含：environment、database identity（不含token）、代码commit、schema/migration版本、policy版本、读取时间、各表行数、最大主键/游标和checksum。要声称“一致快照”，必须来自经授权的完整导出/快照；普通分段在线读取只能标注rolling scan并逐行校验版本，不能称一致快照。

处理offers使用主键keyset分页，默认50条/页；TEXT主键用稳定排序，固定upper bound并记录。扫描期间可能插入排序更靠前的ID，因此末尾必须执行`NOT EXISTS(mapping)`补漏扫描；不能仅依赖最后游标。同时变化的旧行以业务版本/内容hash重试，不覆盖最新管理员操作。

### 3.2 一对一映射规则

- 每个旧offer生成/回读一个entity，写benefit_offer_links。可用命名空间`legacy-offer:{offerId}`计算确定性UUID或唯一legacy key，以支持断点重放；这只是迁移身份，不证明两个活动相同。
- 新entity.canonical_offer_id=原offer.id；confirmed仅表示这行有固定数据库身份，不能把遗留错误事实当成已证实身份。identity证据不足的保留provisional，已批准公开投影在shadow阶段不受此影响。
- 从旧字段抽结构化事实，缺字段标unknown；不得为了哈希完整补金额、资格、模型、地区或日期。估值不是权益面额，不能把usdEstimate当作官方赠金。
- 原approved：保留公开已批准版本与原review证据。原pending：建立原有待审任务映射；不要再次通知。原rejected：保存拒绝决定和scope。withdrawn/ended保持原生命周期。
- 有proposal时保留公开版本和候选版本，不能把proposal反写成现行已批准事实。manualFields和版本号必须完整保存。
- rejected_offer_updates逐条映射到相应版本，保留原id、diff、evidence、at及第一阶段decision_key；相同事实可共享version，不合并或删除不同审核事件。
- leads中直接拒绝、尚无offer者映射到candidate决策主体，不强造公开offer；未知发放方不自动绑定任一产品。
- 历史reason=duplicate但没有可信canonical指向：生成一次identity任务，不猜赢家；reason=other或理由缺失只保留exact_version/candidate作用域，不升级为全平台拒绝规则。

旧日志没有明确审批人/理由时记录`legacy_import`、原记录引用和uncertainBasis；不得伪称管理员明确做过新的结构化决定。

### 3.3 幂等台账

新增`identity_backfill_runs`：id PK、mode preview/bootstrap、manifest_json、cursor_json、state、stats_json、created_at/updated_at。
新增`identity_backfill_items`：run_id、source_table、source_id、source_version、result_json、state、error；UNIQUE(source_table,source_id,source_version,mapper_version)可通过独立mapper_version列实现，不能仅在每次run内去重。

每条/小批映射及checkpoint一致提交；失败保持可重试，不推进成功游标掩盖漏项。再跑同数据不得新增entity/version/decision。业务版本改变需追加新映射修订，不静默删除旧决定。

Bootstrap完成验收：所有旧offers有且仅有一个原始entity链接；需要回填的每条拒绝记录有可追溯新决定；proposal双版本保留；公开API/RSS/通知预览与回填前逐字段一致；没有新通知或新审核卡片。差异必须列出，不能以数量相同替代内容一致。

## 4. 重复候选生成与证据报告

复用第二阶段resolver，不另写一套“清库阈值”。结果至少分为confirmed_same、likely_same、uncertain、distinct、terms_change、conflicting_decisions。只有管理员明确确认confirmed_same才允许apply；模型评分不是管理员确认。

每组报告包含：candidate group id、成员原ID/主实体ID、标题/现行事实/政策日期/来源、批准与拒绝理由、人工字段、匹配依据、冲突字段、建议主记录及理由、受影响的线索/提案/决定/通知数量、正在执行的任务/发送、版本校验token。

不能用传递相似性合并：A近似B、B近似C不代表A=C。一个组的每个成员必须与拟选canonical具有独立same依据，并验证所有已知hard conflicts。存储distinct关系后，下次相同版本不再提出同一合并建议；新证据出现时先生成新关系核对任务。

同活动不同条款版本不等于重复行可直接折叠为最新版本。若两行实际代表独立轮次，禁止合并；若是同主体历史条款，保留两个版本及时间关系，仅统一主体和公开现行投影。

## 5. 主记录选择与人工字段冲突

建议优先级：已经被人工确认的canonical > 有效approved > 已完成较多人工核验的pending > 其他。相同级别可优先引用较多、原始创建较早的记录，但必须管理员最终确认；不能依靠sort顺序自动批准或删除。

强制审查：

- 两个approved的事实/资格/轮次冲突：禁止apply，先解决身份或版本关系。
- rejected reason=duplicate：可以作为alias，不能把rejected状态传播给approved canonical。
- rejected reason=paid_bundle等与approved决定实质冲突：需要管理员明确superseding decision，不能自动偏好任一状态。
- 管理员title/valueText/requirements/evidence/valuation/manualFields冲突：逐字段选取并记录来源；禁止last-write-wins。未解决则阻塞合并。
- 有多个活动proposal：相同entity+factsHash可以共用一任务，但各原提案内容、人工字段和关联必须保留；不同版本并列，不覆盖。
- 无approved成员：合并后仍待审或被拒，不能通过合并取得approved。
- 旧记录缺证据：合并不会自动升级为official/tested，也不会刷新lastVerifiedAt。

合并的目的不是重新计算资格、价格或历史；这些属于单独审核决定。

## 6. 采用非破坏性逻辑合并

初版不搬迁/覆盖所有外键，不物理删除offers。成员原始offer、revision、review、notification、delivery保持原ID。通过entity.merged_into和root解析形成canonical group；最多20个entity/次操作，超过上限先拆分并重新验证，禁止超大事务。

`resolveCanonicalEntity(id)`返回root及成员关系；禁止环，自指，跨产品错误别名。apply需对所有成员root revision做compare-and-swap并确认root在预览后没被合并。更新将成员root直接指向新root，避免无限链；读取仍有visited集合与最大深度8的保护，异常返回管理告警而非死循环。

`benefit_offer_links`保留原始归属；读取根据entity root获取canonical_offer_id。版本保留origin entity ID，通过group聚合，不能删除原版本。新的来源必须保存原输入ID和resolved root，以便审计和后续撤销。

### 6.1 所有读取必须兼容alias

- 公开列表、平台页、日历/图表/模型汇总、RSS、总价值统计：每root最多一个当前公开投影；不是在前端“隐藏重复”，必须服务端过滤。
- 旧`/api/offers/:alias`：先验证root的公开权限，返回canonical投影及`canonicalId`，不返回旧alias的过时权益；root不公开时404。过渡期优先200+canonicalId以兼容旧客户端，不强制301。
- 旧`#offer-alias`深链：前端按canonicalId显示同一详情并可replaceState到新ID；不能让旧通知链接失效。
- 管理接口：仍可读原记录历史；编辑/审批alias需明确跳转canonical或返回409，不能产生第二个公开版本。
- 查重索引：alias锚点仍可召回root；历史拒绝按原作用域判断，不因group里有人被拒就拒绝整组。

第二阶段enforce关闭以后也必须保留alias-aware读取。如果已经应用第三阶段合并，不能简单回滚到完全不了解identity表的旧Worker，那会重新展示重复。需保留兼容构建，或先执行经验证的unmerge；文档必须明确这个回滚边界。

### 6.2 外键与历史的处理清单

| 对象 | 合并动作 |
|---|---|
| leads.offerId / resolution.offerIds | 原值保留；展示和处理按root解析，聚合时去重；候选级终态不重开 |
| offer_revisions / reviews | 不改offer_id、不改历史正文；canonical后台可列成员历史并标origin |
| rejected_offer_updates / review_decisions | 保留原subject/version/scope；duplicate_link决定指向root，但不能扩大其他拒绝scope |
| offer_proposals / review_tasks | 保存原关联，root任务视图消重；冲突任务需管理员解决，不强制DELETE |
| notifications / deliveries | 保留实际发送主体、stage、messageId、时间和payload；只派生canonical已送达状态 |
| snapshots / source_observations / version_evidence | 保留原观察与引用，不把旧版本证据复制成最新核验 |
| identity_anchors | 原anchor保留；解析到root；冲突anchor阻塞apply，不能覆盖别的活动 |

后续若决定物理迁移外键，应另写规格和回滚，不属于本阶段默认实现。

## 7. 审核任务和通知不重复

同root+同已确认version的开放任务聚合为一个；历史任务转为linked/resolved需有合并决定引用，不删除审计。不同version任务不得因group合并而被吞掉。

新增alias本身不生成`new`或`changed`通知。旧任一成员已通知过相同真实优惠时，root继承“已通知过new”的派生状态；不能把所有旧stage简单合并成当前版本已通知。changed/ending/ended须结合实际版本、时间和活动轮次验证。

对pending/unknown发送：默认阻塞涉及该group的merge apply，要求先人工对账或在预览明确的安全方式下冻结。禁止自动重新发送来“确认”。冻结后不得让旧payload继续发送被合并的重复卡片；已送出的外部消息无法撤回作为事务回滚，必须如实保留。

通知构建和claim要在发送前校验canonical关系/revision，避免preview后merge造成发送旧重复。只在本地/隔离测试调用发送适配器mock；本次授权不包括真实群消息。

## 8. 合并命令、事务与收据

新增管理接口（仅admin，reviewer/ingest无权apply/unmerge）：

- `POST /api/admin/identity/merge-preview`：memberEntityIds、chosenCanonicalId?，只读返回proposal、conflicts、affected counts、expectedRevisions和previewHash。
- `POST /api/admin/identity/merge-apply`：idempotencyKey、previewHash、memberEntityIds、chosenCanonicalId、expectedRevisions、reason、fieldResolutions和environmentConfirmation。缺一必需字段返回400。
- `POST /api/admin/identity/merge/:id/rollback-preview`：只读列出可撤销的当前字段、后续依赖与阻塞项。
- `POST /api/admin/identity/merge/:id/rollback`：idempotencyKey、expectedRevisions、previewHash、reason。过期预览409，不自动刷新后强制重试。

新增`identity_merge_jobs`：id PK、idempotency_key UNIQUE、payload_hash、state applied/rolled_back、canonical_entity_id、decision_id、preview_hash、before_json、after_json、expected_versions_json、created_by、created_at、rolled_back_at。

新增`identity_merge_events`（或使用review_decisions的merge专用action，实施时统一枚举）：不可变记录apply/rollback及每个成员关系、字段选择和审计来源。必须保持第二阶段decision枚举同步，不能一处接受merge另一处拒绝。

apply在同一D1 batch内：验证预览/版本/产品/发送状态 → 创建本次命令收据和before image → 写合并决定 → 修改root指针/必要任务投影 → 检查后置约束 → 完成收据。后续SQL依赖本次guard成功；SQL失败全回滚；零行guard导致整个命令无副作用并409。不能在前端检查后执行无条件UPDATE。

previewHash覆盖成员、root版本、关键人工字段、开放提案、发送状态、作用域选择和算法/政策版本；不能仅对ID列表hash。相同幂等key不同payload返回409；超时重试同key回读已有结果，不产生第二次合并。

默认每次apply最多20entity且≤40条DB语句（batch内逐条计）；若计划超预算，preview报需拆分，不能部分提交一个group。每条语句最多100绑定参数；大ID集合使用分页或安全JSON展开，不拼接SQL。

## 9. 断点、并发、失败与撤销

扫描、候选生成、审核、apply有各自状态，不用一个成功标志代表整批完成。单组失败不丢其他组，run记录每组错误和可重试条件。重复执行已完成组回相同收据。

合并过程中并发采集必须使用同一root/任务revision保护；对旧root的写入不能新建绕过canonical的公开活动。并发两次合并重叠group只允许一个成功，另一个409后重新预览。

rollback不是整库恢复：只回滚本merge改过的映射/投影/任务字段，并保留apply/rollback审计。只有当前状态仍等于after image且没有依赖的后续审核、新版本、合并或发送时可自动unmerge。后续新增来源仅在能无歧义确定原归属且不丢证据时迁移；否则阻塞自动撤销，生成管理员补偿计划。

禁止以旧before image覆盖合并后用户新编辑。回滚不得删除新的拒绝决定或消息收据。出现数据库损坏才考虑整库备份恢复，恢复是另行授权的运维动作，不能用来取消一组误合并。

## 10. 上线与验收顺序

1. 在本地/隔离D1应用增量迁移，验证旧Worker兼容；确认第一阶段0016已应用。迁移编号按执行时实际台账分配，不覆盖相同编号。
2. 运行bootstrap preview；核对行数、缺陷、预计映射和拒绝scope，不改变生产。
3. 获得独立授权后执行bootstrap，断点续跑到0未映射；公开和通知快照无变化。
4. 第二阶段shadow至少覆盖两个完整采集周期，并完成所有golden/holdout验收；不能仅等时间不看证据。
5. 完成alias-aware读路径、后台冲突处理和发送保护后，输出merge preview清单。
6. 管理员先确认少量高把握样本（建议≤5组）；获授权后apply，逐组读回公开/后台/通知结果。
7. 任一误合并、丢人工字段、重复通知或守卫失效则停止扩大，保留证据，先回滚/修复；不能继续清库追求重复数下降。
8. 分批继续；提交统计、未解决清单、操作收据和回滚可用性说明，不把uncertain标成已清理。

生产验收的读取/写入须由执行时授权区分；不可默认远端API就是测试环境。

## 11. 必须通过的测试

| ID | 场景 | 必须结果 |
|---|---|---|
| P3-01 | 同快照bootstrap两次，含approved/pending/rejected/withdrawn | 第二次不新增映射/决定，不改公开投影 |
| P3-02 | 扫描中断/单页失败后恢复 | 无漏项、无重复；成功checkpoint正确 |
| P3-03 | 扫描期间插入更小TEXT主键/旧行更新 | 补漏发现；版本变化重试，不覆盖 |
| P3-04 | 拒绝lead无offer、理由other、duplicate无目标 | 不伪造平台或宽范围拒绝；缺目标身份任务 |
| P3-05 | approved主记录+rejected重复alias | root仍approved，原拒绝审计保留 |
| P3-06 | 两approved实质冲突/同日不同轮次/不同产品 | preview列阻塞，apply拒绝 |
| P3-07 | A≈B、B≈C但A与C冲突 | 不连通分量强合并 |
| P3-08 | title/value/valuation/manualFields冲突 | 未明确选择不能apply |
| P3-09 | 已发new通知和旧深链 | 不重发，旧链接可见canonical |
| P3-10 | pending/unknown发送、预览后新发送 | 阻塞或明确冻结；不得重复发 |
| P3-11 | 并发采集/管理员edit/两个重叠merge | 一个有效提交，其他409或正确root重判 |
| P3-12 | 事务第1/中间/最后SQL失败，guard零行 | 无部分mapping/任务/audit写入 |
| P3-13 | 同幂等key重试/不同payload | 同收据/409 |
| P3-14 | apply后无后续变化再rollback | 恢复映射和投影，审计保留 |
| P3-15 | apply后新审核/新版本/发送再rollback | 阻塞自动回滚，不丢后续数据 |
| P3-16 | off/shadow/enforce切换，合并后的兼容读取 | 关闭resolver不重新展示alias |
| P3-17 | 公共列表/平台/日历/图表/RSS/金额汇总 | 一root一投影，含数量和金额断言 |
| P3-18 | role伪造/过期previewHash/循环root | 403/409/受控错误，无写入 |
| P3-19 | 不同版本的两个proposal | 并列保留，不能静默覆盖 |
| P3-20 | 全部旧FK和审计关联核查 | 0断链；引用可解析到原记录与root |

使用真实SQLite迁移测试，再在隔离D1验证事务/索引/限制。每次运行完整`npm run typecheck`、`npm test`；前端改动加`npm run build:web`。保存脱敏before/after API快照、DB检查结果、命令收据和测试输出。

度量报告至少分别统计：已映射、批准重复、拒绝重复、版本更新、distinct、不确定、作用域冲突、守卫失败、可回滚/需补偿组、重复通知次数。不能只给“清理了N条”或以减少行数为成功标准。

## 12. Codex实施切片

- P3-A `scripts/identity-backfill.ts`＋只读manifest/preview、one-to-one mapper、台账和断点测试。最小bootstrap可作为P2-B依赖提前完成。
- P3-B `scripts/identity-merge-preview.ts`＋复用resolver的候选报告、冲突/传递性检查，不提供自动apply。
- P3-C `src/worker/identity/merge.ts`＋admin接口、CAS/幂等/事务、非破坏root关系；写测试先红后绿。
- P3-D 所有公开/后台/通知读取的alias兼容、旧深链、未决发送保护；不能只改/api/offers。
- P3-E rollback-preview/rollback、并发/故障注入、隔离D1验收和运维文档。

每片独立提交/PR，保持默认不开启；未完成读写与通知兼容之前不开放生产merge按钮。交付代码不等于授权清理生产数据。
