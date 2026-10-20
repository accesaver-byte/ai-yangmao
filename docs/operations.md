# 运维说明

校对日期：2026-10-15。本文描述现役命令和源码机制；当次线上版本、任务和未完成项见[整理凭证](closeout-2026-10-15.md)。字段与业务口径由[数据合同](data-contract.md)维护，文档职责见[索引](README.md)。

## 身份改造发布状态

第二、第三阶段的七个增量和后续修复已合并并发布；最初的 off 兼容上线只记录于[2026-10-10发布凭证](dedupe-release-2026-10-10.md)。强制身份去重、模型辅助和受控历史合并的后续启用及真实历史回放边界见[身份启用验证](dedupe-activation-2026-10-11.md)。运行开关、迁移台账和生产版本每次发布前实时核对，不能把旧 off 快照当当前状态。

关闭身份写入仍须保留 canonical、通知映射和缓存 generation 读取；保留全部新表和原记录，禁止为回滚删除人工决定或释放 pending/unknown 送达。历史合并只能先输出 planHash 与冲突报告，再按具体授权执行；运行预算不可因文档同步扩大。

## 查询、审核与权限

从项目根目录运行。`scripts/ym.ts`读取忽略的`.prod.secrets`；审核脚本也支持环境变量`ADMIN_TOKEN`。凭据值不进入日志、文档或提交。

```bash
npx tsx scripts/ym.ts queue
npx tsx scripts/ym.ts show <短码>
npx tsx scripts/ym.ts health --verbose
npx tsx scripts/ym.ts digest
npx tsx scripts/ym.ts urgent
npx tsx .claude/skills/yangmao-review/scripts/offer.ts plan <短码> patch.json
```

以上为读取/预览。完整补字段、memo、suggest、approve、reject、retest、unpublish见[审核技能](../.claude/skills/yangmao-review/SKILL.md)。`apply`默认保持待审，`suggest`只写建议，`--approve`须有条目批准授权。`ym edit`不含models、tags、usdMax、steps、完整evidence、publishedAt；`ym add`只补线索，后续研判才形成条目。

| 权限 | 审核员 | 管理员 |
|---|---|---|
| 读取队列/线索/条目，编辑/审批/建议/核验记录/复测 | 可 | 可 |
| 线索忽略/重试/补录，提交信源或平台 | 可 | 可 |
| 下架/撤回、平台准入、启用自动上架 | 不可 | 可 |
| 健康/分析、发送通知、处理送达台账 | 不可 | 可 |

条目页「✏️ 在线编辑」（2026-10-18）：本浏览器已用管理员或审核员密钥登录时显示，复用审核卡片的编辑表单，经 `GET/POST /api/admin/offers/:ref(/edit)` 按审核版本保存，字段合同、会员目录与上架检查照常；身份管理的条目保存为待发布修改，须在同一面板按新版本点“通过”才公开，审核员同样不能下架或标亲测。以`src/worker/admin.ts`的`REVIEWER_ALLOWED`为准。`REVIEWER_TOKENS`使用name:token列表，令牌至少16字符。角色能力不扩大本次任务授权。平台准入不等于条目批准；`reject`对已上架条目持久保存被拒证据后移除更新提案，误收条目用`unpublish`，官方明确撤回用`withdraw`并保存官方链接及理由。

## GitHub 协作与 Actions 凭据保护

`main` 的 `protect-main` 规则要求 PR、至少 1 个批准、代码所有者审核和 `check` 检查通过；新提交会撤销旧批准，审核讨论必须解决。`.github/CODEOWNERS` 将全部文件（包括它自身及工作流）指定给 `@accesaver-byte`。另设主分支更新限制，仅仓库所有者可通过 PR 合并；协作者不能直接推送或自行合并，部署密钥和 GitHub App 不再豁免。所有者自己发起的 PR 无法自我批准，须由所有者主动选择 PR 豁免合并；普通协作者没有此权限。

采集、纠正归纳、两项真实模型回归及凭据验收共用 `production` Environment：仅允许 `main` 分支，不设置 required reviewers 或等待时间。已审核合入 `main` 的代码可自动取用环境凭据运行，开发分支仍不能取用。敏感凭据仅保存在环境 Secrets，仓库级同名副本必须为空；增加新凭据时也遵循此规则，不能放回仓库级 Secrets。

**定时采集、纠正归纳、模型回归和凭据验收均无需点击 Review deployments；定时任务按调度自动执行，手动补跑也直接运行。** 人工审核保留在代码 PR 合并环节，不对已批准代码的每次运行重复审批。工作流权限调整不改变福利条目的收录、审核或自动上架业务规则。

普通 PR 的 `check` 不使用生产环境或生产凭据。默认 `GITHUB_TOKEN` 仅只读；纠正归纳为创建规则建议 PR 显式申请 contents/pull-requests 写权限。GitHub Actions 创建/批准 PR 的仓库开关保留开启以支持该功能，但机器人不在 CODEOWNERS 或主分支更新豁免名单，不能代替所有者批准或合并。

手动验收运行 `verify-credential-protection.yml`：它只检查 8 项环境 Secrets 是否非空，不调用模型、不写业务数据、不输出凭据。从 `main` 运行应无需人工审批直接成功，运行审批记录为空；从非 `main` 分支运行时应被环境分支策略阻止。

仓库已开启 GitHub Secret scanning 和 Push protection；GitHub 仅对其支持的密钥格式提供原生检测与拦截，不能据此保证识别所有自定义业务令牌。当前个人仓库不支持委派绕过审批：有写权限的贡献者仍可填写理由绕过原生推送拦截，因此须关注绕过告警，不能把推送保护当作不可绕过的门禁。不要提交真实密钥来测试拦截。`.github/workflows/` 的外部 Actions 均固定为官方仓库中核实的完整 40 位提交 SHA（注释保留原主版本），仓库 Actions 策略强制使用完整 SHA；新增或升级 Action 必须先核实官方提交，再通过所有者审核的 PR 更新，不能改回可移动的版本标签。旧开发分支须同步这些工作流后再运行 CI。

## 调度与线索到审核

**AIHOT Codex reset（2026-10-18管理员授权）**：`aihot-resets` 可启用专用自动上架，采集器使用 AIHOT 提供的 X 员工原帖链接作证据，跳过模型研判排队并走既有身份去重与版本化批准；其他线索源仍按原规则。主公告上下文修复、开关、续传及发布凭证见 [专项说明](aihot-reset-auto-publish-2026-10-18.md)。

| 执行方 | 时间基准与调度 | 工作 |
|---|---|---|
| Worker | UTC 00:00每日 | 配置了webhook时发飞书日报 |
| Worker | UTC每小时第7分钟 | 飞书48小时临期检查；东京09:00后再补跑本日漏发日报 |
| Worker → GitHub Actions | UTC每6小时第17分钟 | 全量采集 |
| Worker → GitHub Actions | UTC每小时第27分钟 | 快速线索与官方补证 |
| Hermes | 调度器时区每日09:00 | Telegram日报 |
| Hermes | 调度器时区每小时第7分钟 | Telegram加急、审核提醒及健康检查 |

Worker UTC 00:00对应东京09:00、上海08:00。Hermes未设置独立任务时区时使用调度器时区，不能从脚本“东京时间”注释推断；2026-10-09实际安装为纽约时间09:00，详见整理凭证。安装脚本会重建定时任务，不能作为文档同步命令运行。

两种collect任务共用并发组、不取消正在执行的任务，默认研判最多50条。快速通道采AIHOT与社区feed，之后研判并执行待审官方补证；全量再处理其他官方信源。已批准条目不再因旧证据页定期重抓而转待核验；新发现的明确业务变化仍生成待审更新。初抽最多15分钟，并给后续补证留时间；整轮40分钟工作窗口，Actions45分钟限时。

人工补录优先；调度给自动发现留名额，并保留20%最老积压。排序只决定先后。成功入库后才标linked；部分失败、未知平台、重要福利漏抽等转reviewing，并自动进入受阻线索官方复核。取不到原文时可用备注/摘要形成媒体级稿；失效补录不无限占据new队首。后台支持状态筛选和游标分页，全部受阻线索在待审区有进度与处理入口；可筛选已关联/已结束追溯依据。详见自动官方复核文档的受阻线索环节。

社区稿的固定官方搜索、机制一致性检查、占位、输入版本、退避和恢复由[自动官方复核](official-review-workflow.md)维护。旧采集器的 `/api/ingest/verification-queue` 返回空队列，`/api/ingest/verify` 对已批准条目只返回无需复核、不写记录；Jina正文不能借旧路径升级证据。新提案写入检查读取时版本，旧结果不能覆盖人工修改。approved旧版保持公开，仅有同源官方正文证明条款改变才进入提案；采集器附完整sourceText，纯模型漂移或拒绝过的同版条款不入队，合并后重新校验。新ID查重是独立入口，须同时验收；完整行为见数据合同。

手动补跑会写线索和待审，只在任务授权范围执行：

```bash
gh workflow run collect.yml --ref main -f fast_leads=true -f lead_limit=50
```

`DRY_RUN`不写权益/线索业务状态，真实模型请求仍记预算。`ONLY_SOURCES`限定信源抓取；官方补证由独立队列控制，诊断需要明确跳过时传`official_review_limit=0`。周度distill只提出纠错规则PR，不是发现扫描；邮件接收尚未实现；Discord 公告采集已接入，配置与边界见下节。

## 模型、预算与回归

全局活动的明确周期（分钟/小时/天/周/自然月/自然年及复合周期）由`src/shared/campaign-deadline.ts`执行，采集`toOffer`与服务端`collectedOfferIn`均可补日期；原文周期、日期锚点及精度存入evidence.claimEndDerivation。原文已有明确截止不覆盖，媒体/无锚点/个人领取后有效期不推算。普通存量校验不自动回填已批准基线。修改须同时推送采集代码并部署Worker。

海外网络门槛由`src/shared/network-requirements.ts`统一执行：采集抽取保留/补上国际产品的net，入库共享schema再次执行，none不会与net并存，其他资格与官方identityFacts不改。国内WorkBuddy、火山引擎等保持独立口径；共用平台ID按产品入口/明确版本判定，版本未明且原为none时改为unknown，不能假定国内直领。新增平台准入时须同时登记该模块的国内/国际/混合分类；未登记ID不能凭域名猜厂商归属。修改此规则须推送GitHub采集代码并部署Worker入库校验。

`pipeline/llm.ts`加载通用规则、D1 平台画像及管理员纠正。现行平台事实在 `platform_profiles`；`pipeline/platform-notes.md` 已冻结为历史快照，只在没有画像时回退。抽取优先使用画像里的 pitfalls 与 patterns。GitHub 采集读取远端代码；修改规则后只部署 Worker 不会更新管线，需推送。画像变更写 D1，不靠改这份历史文件。

模型链为Gemini免费层、OpenRouter、可选GLM、预算内DeepSeek付费兜底。免费供应商受限会本轮冷却；重要或积压超过2小时的线索可使用既有付费预算。默认`DAILY_TOKEN_CAP=0`、`MONTHLY_COST_CAP_CNY=72`（2026-10-15 管理员定为每月约 $10），实际覆盖以部署变量和Actions配置为准。预算先原子预留再结算，用量不明保留预留；RSS单篇失败不阻断后续，FORCE可以重抽。

工作流`extraction-lessons.yml`用合成文本驱动真实模型，`only_cases`以[scripts/eval-extraction-lessons.ts](../scripts/eval-extraction-lessons.ts)的cases为准，留空全部；涵盖套餐/免费额度、账单模式、日期、重置、身份认证、资助与比赛及官方活动错配。禁止付费兜底，不写条目/线索，模型仍记预算，输出保留artifact。通过不等于官网事实全部核验；失败需查具体结果，不能降低验收标准。

## 证据拦截的处置

已批准条目的历史 `evidence_missing` 只作诊断记录，不推进 reviewVersion、不生成重新审批任务，也不撤销已批准条款。新待审材料和真实条款变化仍须核实证据；X/status 第一方嵌入读取须绑定 ID/作者，finalUrl 为验证后的原帖地址，fetchedUrl 记录实际读取地址；失败或身份不符回退普通读取，不将导航或登录页当原帖。普通抓取缺失不能单独判定活动已结束，只有管理员明确亲测过权益才用 tested 级别。

管理员亲测停止领取时，管理接口`POST /api/admin/offers/:ref/withdraw`可传`basis:"tested"`、reason及实测入口evidenceUrl；默认basis为official。withdrawnAt是确认时刻，实际截止未知仍留空。legacy条目结束会清除过时提案、退出可领和自动复核队列，历史approved记录保留；identity管理的活动保留草稿并取消旧任务/租约，显式重开后才可进入新的恢复审核。

## 展示、通知与健康

页眉“最近一次抓取”使用meta.lastCollectedAt：最近已完成collect/sweep中fetchedSources>0（兼容旧stats.ok>0或旧ok=true）的时间。仅全失败批次不更新。抓取成功与抽取/核验/入库完整成功分开，后者仍保留lastSuccessfulCollect用于后台完整性告警；页面覆盖不完整提示取最近完成批次，不因存在部分成功就假报全覆盖。meta/coverage缓存使用partial-fetch-v1版本。

公开 offers/platforms 最多使用 5 分钟边缘缓存；offers 响应要求浏览器每次重验证，评论接口 no-store，后台 no-store。内部 memo、suggestion、officialReview 及完整修订明细不公开；公开简介和步骤只写领取者需要的权益与条件，核验过程写内部记录。后台不定时重画输入表单；编辑延迟挂载并保留草稿，心得持续显示未保存/保存中/已保存/失败。待审链接 `#admin-offer-ID` 登录后定位；提交带 reviewVersion，内容变化或竞争返回 409。更新提案展示公开值与候选值的增删改对比，证据拆项，忽略单纯抓取元数据变化。

Telegram审核提醒按对象版本去重，每批最多10条，临期优先并保留积压名额。`digest`/`urgent`仅预览；`dispatch digest|urgent`经Hermes实际发送，须有授权。发送前占位，成功后ack；pending/unknown不能换批次重发，人工确认后用delivery-delivered或delivery-unsent结案。正常定时任务可能已送达新条目，手动推送前查台账。

飞书日报选常驻5、新星3、末班车3，跨榜去重。新星为近14天未通知，末班车为3天内截止；不含待审、独立变更或已结束榜。webhook未配置或未验证时不能声称送达。

公开 Agent 接入源在 `integrations/agent/`，与本机 Hermes 管理技能分开。官网 `#agent` 提供安装说明，`/ai-yangmao-public/SKILL.md` 与安装脚本由 `npm run build:web` 打包；`/llms.txt` 指向服务端能力说明。匿名只读 HTTP：`GET /api/agent`、`GET|POST /api/agent/search`、`GET /api/agent/offers/:id`、`GET /api/agent/catalog`、`GET /api/agent/daily`；可选 `format=markdown`。个人条件使用查询 POST，只在当前请求计算，不保存个人档案。远程 MCP `/api/mcp` 使用无会话 Streamable HTTP，工具为 `yangmao_search_offers`、`yangmao_get_offer`、`yangmao_get_daily`、`yangmao_get_catalog`，不提供管理员操作。

发布前须应用 `0039_public_daily_digest.sql`。原飞书每日调度会生成单例固定日报，即使未配置 webhook 也生成；飞书发送与公开读取使用同一份条目和卡片。公开读取不会生成、翻译、占位或发消息。只返回最新一期，无历史查询；尚无日报明确返回 unavailable，当天尚未生成则标记最近一期日期。推送卡片与公开日报 Markdown 只展示标题、额度、简要条件、截止时间、额度有效期、信源和详情链接；官方原文、领取步骤、牧场心得和核验时间留在详情与结构化数据中。生产迁移、正式部署与飞书发送仍按该次授权分别执行，不能用查询触发或用本地演示声称线上完成。

首次上线可由管理员 `POST /api/admin/feishu/digest/prepare`，JSON `{"refreshUnsent":false}` 准备公开版，**不发消息**；若当天已有确认送达的飞书日报，优先沿用该次条目，并避免重发。冻结后身份版本失效会返回明确冲突；管理员可用 `{"refreshUnsent":true}` 重建确认未送达的版本，修订号公开展示。存在 sent/pending/unknown 记录时禁止重建，不释放待核对消息。新生成日报保存各条 lastVerifiedAt；旧发送快照未保存的时间保持未知。

飞书日报仍于东京09:00生成/发送；若只读保护或临时故障跳过，每小时第7分钟在东京09:00之后补跑本期。已确认送达跳过，pending/unknown 保持待核对，不能自动释放重发；先完成加急检查，再补跑日报，补跑挂起或失败不阻断本轮加急。东京09:00前不生成次日日报。若冻结的新星榜/末班车条目后来已由加急确认送达，补跑仅重建本期确认未发送的版本并递增修订号，避免重复推送；已发送或 pending/unknown 的日报仍禁止改写。常驻榜作为每日栏目保留。

发送占位同时核对固定日报的 day/revision；若管理员修订先完成，发送方重新读取最新版本（最多一次）；若发送先占位，修订被拒绝。部署后可运行 `node scripts/smoke-public-agent.mjs https://ai-yangmao.com` 做公开只读验收，安装器验收使用临时 --dir，不更改本机管理技能。安装中断遗留锁时先核对锁内 PID，确认进程已退出后再人工清理；安装器不自动争抢/清除现存锁。

Agent 数据缓存按公开 generation 失效，同实例冷并发合并读取；边缘缓存故障可回退数据库，额度失败使用网站共用熔断，后续跳过 D1。搜索只输出有体积预算的摘要与详情地址，groups 引用 ID，客户端按 nextOffset 翻页。会员非空清单默认不完整，只有显式 subscriptionsComplete 才作闭合匹配。安装器校验全部独立文件、使用互斥锁，最终替换失败时恢复原技能。

健康页展示最近全量尝试与coverageDegraded、快速任务、重要线索积压，以及官方补证的待处理/退避/耗尽/超时。抓取成功不等于核验成功，sweep不冒充完整collect成功。D1用量依赖`CF_ANALYTICS_TOKEN`；代码门槛读500万、写10万行/UTC日，读取超过70%按日去重提醒。未配置/读取失败不报零，实际配额以账户为准。

本机管理HTTP凭据经curl stdin传入；只重试尚未发出HTTP的DNS、连接、TLS握手失败。写请求超时或空响应不能盲目重试，须读回业务状态或投递台账。

## 发布与故障排查

### 公开匿名牧场心得

新环境发布前先应用 `0040_offer_comments.sql`，再部署 Worker 和前端，不重复执行已登记的迁移。2026-10-12 公开留言路由已在线返回 200；本次知识整理没有读取生产迁移台账或执行生产数据库操作，详见[整理凭证](closeout-2026-10-12.md)。迁移新增匿名身份、共同留言、限频三张表，并把已有非空管理员心得复制为同列表的 `admin` 留言；不改变条目条款及审核状态。新环境发布前导出 `offers` 中的旧心得和迁移台账，核对台账仅缺本次迁移，备份当前 Worker 版本。原 `adminNote` 编辑入口事务同步对应留言；详情页只有一个共同留言框。访客体验不进入通知、审核证据或 `tested` 标记。

- `POST /api/community/session`：分配/恢复匿名身份。Cookie 为 HttpOnly、SameSite=Strict，HTTPS 下 Secure；有效期一年。服务端检查六位 ID 唯一性，数据库只保存随机会话令牌的 SHA-256。
- `GET /api/offers/:id/comments?before=<id>`：倒序分页，每页 20 条，返回公开姓名、文字、时间和留言编号，不返回会话令牌、IP、内部作者编号。`Cache-Control: no-store`，可点“刷新留言”读回。
- `POST /api/offers/:id/comments`：提交 `{content, requestId}`；1–500 字，requestId 为 UUID，重试幂等。JSON 限 4 KiB，校验同源。单访客每分钟 1 条、每天 20 条；同 IP 每 10 分钟 10 条、每天 100 条；新身份同 IP 每小时最多 30 个。网络标识使用管理密钥派生的 HMAC，不保存原 IP。限频原子更新并返回 429 / Retry-After；共享网络可能共同触发限额。
- `POST /api/admin/offers/:id/comments`：同一列表中新增署名 `admin` 的留言，仅管理员可用。`POST /api/admin/comments/:id/delete`：软删除，前端有删除确认；审核员令牌无此权限。删除迁入的旧心得同时清空兼容字段，避免旧推送继续引用。

立即公开的匿名留言仍可能包含广告或不实体验，需管理员日常移除；清 Cookie 可获得新身份，网络限频用于限制这种刷屏。数据库额度降级时浏览原有羊毛快照，留言明确显示暂不可用，不返回空列表冒充“没人留言”。留言使用独立表；Worker 回滚保留这些表及已发表内容。过期限频记录在分配身份时每次最多清理 100 条。

发布前核对local、remote、当前生产版本及回滚边界：

```bash
git status --short
git log origin/main..HEAD --oneline
git ls-remote origin refs/heads/main
npm run typecheck
npm test
npm run build:web
npx wrangler deployments list
```

按授权范围先处理必要迁移，再部署Worker、推送管线。文档同步不自动批准、发送、迁移或部署。生产seed不能用于刷新全部已有记录；新厂商使用定向新增并读回准入、信源和活动状态。

部署用`wrangler deploy --keep-vars --tag <Git短SHA> --message <说明>`标记，凭证区分推送、部署及线上读回。旧部署缺marker时不能只凭时间认定代码对应。Worker回滚不回滚D1迁移，需单独恢复方案；回滚后核对页面/API/后台/台账。

`verification-queue`500先查Worker/D1查询，不重复调用所有模型。已修复逐ID绑定超过100参数的问题；历史根因和迁移台账修复见[采集事故](incident-2026-10-07-collect.md)。迁移字段若已存在但台账漏记，先验证完整效果，仅补缺失台账，不重复ALTER。

OpenRouter默认备用为`openrouter/free`；404须检查模型可用性，不能把付费模型当免费兜底。登录墙、页面不可读、额度不明、未准入平台和人工字段保护会保留待审/人工处理，具体事实须核实后裁决。

拒绝记忆迁移为0013_rejected_offer_updates.sql；首次启用须迁移后部署Worker，再推送采集器完整正文协议。文档同步本身无需重新部署。回归同时覆盖旧ID改字段、新ID重复插入、拒绝后重放、人工候选保留及真实新轮次不误合并。

`ym leads`同时输出reviewVersion；`ym dismiss <线索ID> --version <reviewVersion>`使用查看时版本，避免旧指令覆盖已完成结果。线索页面的关联/结束/重试也检查版本。

## 线索筛选（影子模式）

里程碑 1（2026-10-13 上线）在身份系统之前为每条新线索记录筛选判定与紧急度（P0–P3），**不关闭、不关联、不重排、不发布**（管理员批准的入口过滤规则除外，见下）。开关为 Worker 与 GitHub 变量 `SCREENING_MODE=off|shadow|suggest|auto`（现为 `shadow`）；`SCREENING_MODELS` 为固定的 OpenRouter `:free` 模型（逗号分隔，校准前按顺序兜底）；可选 `SCREENING_PAID_MODEL` 与 `SCREENING_PAID_PRICE_IN/OUT` 仅供 P0 兜底。每次调用经预算台账预留/结算：筛选单独记账（`SCREENING_MONTHLY_CAP_CNY`，默认 72），免费池每日 1000 次（P0/P1 预留 200、非紧急 ≤800、回填 ≤400）。后续阶段与门槛见[实施计划](superpowers/plans/2026-10-12-lead-screening-redesign.md)。

### 入口过滤规则（2026-10-16）

模型筛选仍是影子模式，但**管理员批准的标题规则例外**：线索写入时（`POST /api/ingest/leads`）按 `screening_rules` 中启用的 `title_pattern` 匹配标题，命中即关闭线索（`status=rejected`，经身份系统留拒绝记录），不再研判、搜索或进审核；`SCREENING_MODE=off` 时不生效。后台一级「初筛」页的「入口关键词规则」：

- 建议：从管理员在线索阶段的拒绝（`decision_labels`，owner）中挖掘同一类别累计 ≥3 条的共同标题词；只学 `non_ai`（含优惠券、购物券）、`ordinary_discount`、`relay_station`、`account_pool`、`personal_giveaway`。`duplicate`、`unverifiable`、`expired` 不说明“这类线索不该收”，不参与。
- 创建前校验：规则命中任何已批准条目或已关联线索的标题即拒绝（409，列出冲突标题）；可勾选“同时关闭现有未处理的同类线索”。“不再建议”记为 `declined`。停用后立即不再拦截；`hits` 记录拦截数。
- 接口（仅管理员）：`GET /api/admin/screening/rules`（规则与建议）、`POST /api/admin/screening/rules`、`POST /api/admin/screening/rules/:id/retire`。

### 查重减负（2026-10-16）

一周 283 张查重卡全部由人（管理员或代理）决定，其中 70% 是已上架权益的重复报道。改为：

- **同页重读自动确认**（`findSameSourceReread`）：按同平台 + 同一官方页面（规范化 URL）匹配已批准条目，不再要求模型生成相同的条目 ID；已批准的权益原文须仍在页面上（`pageContains` 折叠换行、全半角、标点、千分位），候选的金额、模型、门槛须都已在批准条款里（`introducesNothingNew`）。同页多条已批准条目时须恰好一条符合，否则人工。
- **同一权益合并一张卡**（`identity/perk-group.ts`）：同平台、金额/模型一致且文字相近（或文字高度相近）的未决候选并入 21 天内已开的同类卡（每卡最多 10 条），金额或模型冲突一律不并。卡片上的“关联/新建”作用于所选来源，其余来源随后按 `duplicate` 一并结案；拒绝整组拒绝。
- **积压提醒**：Telegram 每日至多一次，查重卡超过 20 张或最久超过 48 小时即置顶提醒（`IDENTITY_BACKLOG_MAX`）。
- **真实分工统计**：`GET /api/admin/review-stats?days=7`，后台「准确率」页显示。查重决定按请求 ID 区分：`ui-` 为网页点击、`fast-track-` 为快速上架、其余管理员请求为代理/脚本；线索区分系统、入口规则、人工。

### 查重卡“系统核查中”死锁（2026-10-16 修复）

症状：卡片长期停在“官方原文尚未核实 / 系统核查中”，管理员看不到决定按钮，系统也不处理；一周内身份自动处理 `resolved` 次次为 0，错误被吞成 `deferred`。原因与修复：

- **原文核实失败会循环**：系统重抓官方页后，若页面上找不到候选摘录（脚本渲染页、页面已改、原文来自媒体）或只能经 Jina 读取，`scanIdentityTask` 抛 400 且不记录，卡片保持 `needs_source`（按钮只在 `ready` 时显示），下一轮再试。现记为 `source_unverifiable`：卡片交给管理员（可决定、附同厂商活动列表以便“关联同一活动”、或 ⚡ 快速上架/拒绝），3 天后再自动复查；常规重扫不再把它锁回。
- **遗留线索耦合的候选永远 409**：候选创建时绑定原线索的处理状态；线索之后被关联/关闭/重排，提交前置条件再也不成立，每轮 `identity revisions changed`，且不计尝试次数、永远排在重试队首。现在原线索已变化时解除耦合，候选独立判定。
- **审计补充（同日）**：关联了查重卡的线索在线索队列与提醒中隐藏、自身操作被拒，卡片决定后却无人重算线索，27 条自 10-04 卡住；采集每轮调用 `POST /api/ingest/lead-sweep`，对关联卡已全部结案的线索重算（关联/关闭，或回到线索队列交人工），自动复核超过 24 小时仍 `checking` 的线索转人工并写明原因。`history_unusable` 的查重卡同样交管理员决定（原先既被排除出系统队列又隐藏按钮）。
- **身份流程不再吞错**：采集日志 `identity.errors` 按原因计数，`identity.handedToOwner` 记录交给管理员的卡数。

### 查重模型辅助下线（2026-10-17）

Worker 的规则比较器在入库时已自动结案约 95% 候选（重复已拒/已上架）；剩下的才开查重卡。GitHub 采集原先再领取这些卡、重跑同一比较器后调用免费模型，但结果只能是“仍需人工”：10-11 至 10-17 约 246 次，0 次自动决定，存下的 128 个结果全是 `retrieval_incomplete`（同产品历史超过 8 条或产品未知，根本没调用模型）。现采集只做重试、原文核实和历史扫描，不再领取 `/api/ingest/identity-tasks`，也不读 `IDENTITY_MODEL_ASSIST`（GitHub/Worker 的该变量可删除）。查重卡由管理员按“系统建议”与同厂商历史列表决定。

### 自动关闭抽查（2026-10-16）

后台一级「初筛」页的「自动关闭抽查」列出最近 7 天系统自己关闭（自动研判或入口规则）、管理员尚未看过的线索，建议每周看一次。标题提到已知厂商或含“免费、额度、赠送、credits”等词的排在“可能误关”组。每条可：选类别后「✅ 本组其余都关得对」（写 owner 标签，即里程碑 2 的校准样本；每次最多 15 条）、「✗ 误关」（`resolution.spotCheck.verdict=wrong`；入口规则的 `overrides+1`，命中 ≥10 且误关率 >10% 自动停用）、「⚡ 上架」（快速上架并把该线索改为 linked）。接口（仅管理员）：`GET /api/admin/screening/spot-check?days=7`、`POST .../spot-check/confirm`、`POST .../spot-check/:id/wrong`。

线索阶段的内容类拒绝（同上类别及 `paid_bundle`、`model_news_only`）同时进入 `/api/ingest/corrections`，研判与抽取提示词即时可见；每周 distill 把它们归纳成“研判时直接不收”的规则。

身份任务：管理员对“没有已知事实”的候选确认“与已上架 X 相同”时，只要 X 已批准且同平台即可关联（`owner_confirmed_same`）；有已知事实冲突的候选仍走原有守卫。若旧会员迁移留下部分已知事实、发放平台或机制仍未知，管理员同平台关联还允许候选与目标已批准版本的完整规范事实完全一致（忽略证据引用编号）；新增事实、不同会员资格、已有拒绝决定和非管理员操作不会通过此路径。关联复用已批准版本，不改写条款或再次发布。

公众号证据：`mp.weixin.qq.com` 文章仅当其 `__biz` 在平台 `wechat` 字段中，或该篇文章网址本身已登记为官方信源时才算官方；其他无 `__biz` 的短链、未登记账号不算。管理员通过以公众号文章为证据的条目时自动追加该 `__biz`。

## ⚡ 快速上架（管理员）

后台一级「⚡ 快速上架」页提供唯一表单；线索、查重与初筛抽查中的按钮只携带上下文跳转到这张表单。快速上架仅管理员可用（审核员 403）。管理员担保“官方发布”或“我亲测可领”，填厂商（已有厂商或新厂商名称；厂商 ID 由系统生成，不用填）、官方链接、主要权益即可，跳过筛查、官方核验与审核闸门。迁移 `0042_fast_track.sql`：`fast_track_jobs` 任务表，`offers.fast_tracked_at`。

- 链接即登记为厂商官方地址：公众号链接一律接受：带 `__biz` 或能从正文读出 `__biz` 时登记该公众号，读不到（分享短链、微信验证页）时只把这一篇文章登记为官方信源（`tier=official`、不抓取）；X 链接追加账号（已登记的员工账号 `staff_handles` 不升级为官方账号，条目证据为 staff）；已在白名单的不重复登记；平台无官网时写入 `site`；否则新增 `tier=site`、`auto_publish=0` 的信源（id `<平台>-ft-*`）。新厂商直接以 `approved` 建档。
- 提交后触发一次快速采集；`runPipeline` 最先处理快速上架队列：读链接正文，用专用提示词（管理员已担保，只补字段、不判断收录）补字段，取与主要权益最相近的候选。**先用免费模型**；免费模型失败或缺基础字段时，同一次尝试内改用付费兜底 DeepSeek（每条约 ¥0.03，与其他付费兜底共用 `MONTHLY_COST_CAP_CNY` 月度上限，快速上架排在最前）。上限用尽则只用免费模型。主要权益原文即条目额度文案，管理员填的标题/日期优先。
- 基础字段（标题、类型、领取方式、额度、模态、门槛≠unknown、截止方式、date 时的截止日）齐了立即上架；格式错误先规范化（如 UTC+8），使用完整入库 schema 预检；缺字段或校验失败携带已有字段、管理员输入与具体错误交回模型修正。两档都失败时在本轮内隔 30 秒重试（不另起采集：采集串行，新运行会排在本轮之后），共 3 次后交管理员（可点“让模型重新读取”）；两档都只补到部分字段时，送最完整的一份并在本轮重试；三次仍失败才显示「自动补全未完成」，保留错误和可选人工修正。
- **发布前字段语义核对**（2026-10-19）：抽取完成后必须另调一次模型核对分类、实际输出模态和新老用户范围；不能把全局限免写成个人首次试用，不能把付费会员等同老用户，也不能把 UI、截图、图片输入当作免费生图。判断保留来源/管理员描述中的连续原句，缺少原句的判断交回模型修正（同档最多两次，免费优先，付费兜底继续共用预算）。网络由共享版别口径补全，预检及 Worker 使用真实平台 ID。服务器校验核对记录与最终字段一致后才发布，缺记录/摘录失真或仍冲突则自动重读，不把“模型说通过”当依据。模型初稿、核对事实、纠正前后字段和模型名保存在任务 `fields_json.semanticReview`，不进入公开字段。
- **会员门槛**（2026-10-19）：管理员授权快速上架时，模型收到现行已核实会员目录，自行补 `membershipRequirement` 的产品、套餐、或/且及限制；服务端验证目录版本、所属关系和资格结构，再经受控草稿编辑发布。管理员可选填资格，已填内容优先。无法映射或目录变化时把错误交回模型，不能伪造目录 ID、删除实际门槛或直接确认普通采集结果。付费兜底的判断包含会员结构与完整 schema，不再只检查基础字段是否存在。
- **目录阻塞与进度位置**（2026-10-19）：模型只收到已核实的会员产品和套餐；选中待核实或停用目录项时立即暂停为 `membershipCatalog`，保留目录修订、问题项和来源，不浪费三轮模型重试。管理员在一级「⚡ 快速上架」页查看所有未完成任务、原因和目录入口；「补录」只处理普通线索补录。目录更新且阻塞已解除时，队列或后台同步会自动归零尝试次数、让模型重新补齐资格，不手工修改旧模型结果；管理员已明确选定资格的任务不会被静默替换。已完成记录折叠为纵向卡片网格。
- **外部决定同步**：已暂停任务若对应条目已被人工批准，或原线索已明确关联同平台已批准条目/已拒绝，自动同步到已上架/已拒绝；保留 `resolution_json` 原因。后台以独立 reconcile 请求同步，采集队列每次也同步最多 3 个。不同平台的错误 lead 关联不会被接受。`rejected` 为终态，不再重试。
- 上架走身份系统：建候选 →（如有身份任务）以管理员身份确认为新活动 → 以管理员身份通过初审。单个请求受 50 次 D1 查询预算限制，任务按步保存进度（`publishing`），流水线或后台调用 `advance` 续传，通常 4 个请求完成；同一步在新请求里仍无进展则转「需要你补充」。已批准的重复活动视为已上架；此前被拒的同一活动不自动重开。
- 关联线索标为 `linked`；从「权益活动查重」卡片发起的，上架后该查重任务按“与新条目重复”（duplicate）自动结案（迁移 `0048`，`fast_track_jobs.identity_task_id`）。快速上架 24 小时内不进入即时（临期）推送，次日飞书日报照常带上。

## 线索写入批量

`POST /api/ingest/leads` 在 enforce 模式下受每请求 50 次 D1 查询预算约束（约 3 次 + 每条新线索 3 次，命中筛选规则时约 6 次）。中继与流水线按 `LEAD_POST_CHUNK = 5` 分批发送；Worker 每条 INSERT 最多 16 行（6 个绑定列，D1 单语句上限 100 个参数）。2026-10-13 起 linux.do 连续失败即因批量过大（PR #41）。

## 线索关键词与综合福利版块

线索关键词（`pipeline/lib.ts` 的 LEAD）覆盖服务故障补偿/消耗返还和只写“全局重置/Day N Reset”的员工公告，也识别 `Day 13/ Le limit reset` 这种带简短修饰词的写法。AIHOT 动态按标题与摘要一起判断；重置接口每个事件只出一条线索，用最早的主公告并附全部回帖与事件时间。若主公告只在 `posts[].context`，仅补同作者、ID/网址一致、含福利语义的 `reply` 上文，规范化 `/i/status/` 为作者地址；不将 `quote` 旧事件或其他作者上下文选作本轮主帖。正文优先 `fullOriginalText/fullText`，同一推文去重；上下文仍只是线索，官方证据须单独读取（2026-10-18 Day 13 回归修复，发布状态见[排查凭证](codex-reset-missed-2026-10-18.md)）。社区 feed 的 `config.filter`：`all` 整版收录，`ai` 只收标题涉及 AI 产品/模型且不是中转站、号池、倍率推广的帖子（综合福利版块用），缺省按 LEAD。中继信源的代码由 Mac 主检出运行，合并并拉取后再切换配置。

官方出处搜索：配置了 Actions secret `EXA_API_KEY`（2026-10-15 已配置）时调用 Exa REST `POST https://api.exa.ai/search`（`type:auto` + `objective`，不取正文，只要结果网址），调用方以 `site:` 写的登记官方站点与 X 账号转成 `includeDomains`；未配置密钥时用 Exa 匿名 MCP 端点。两者限流或出错时改用 OpenRouter 联网搜索插件（免费模型，约 $0.007/次），按次预留并入账到同一月度付费上限，每轮最多 `OPENROUTER_SEARCH_PER_RUN`（默认 6）次。线索研判只附线索提到的平台的已有条目；`MODEL_OUTPUT_LIMIT` 为 8192，给推理型模型留出输出余量。

微信公众号文章：云端直读、Jina、Exa `/contents` 均被微信拦截（“环境异常”验证页或“微信扫一扫可打开此内容”外壳；2026-10-16 实测 Exa 返回 status=error）。`fetchPage` 识别这两种拦截页，不把它们当正文；读取器保留 Exa 尝试。只有公众号原文的线索立即转人工（`manualNow`），结论附可读到的原文，Telegram 审核提醒置顶为「⚡ 公众号福利：点开一键快速上架」，后台线索卡的快速上架表单预填链接、标题与备注。诊断某个网址能否被生产读取器读到：`gh workflow run collect.yml -f probe_urls=<网址,…>`（只读取并打印方式、长度与正文开头，不运行采集，不输出密钥；排队时会取代同组尚在等待的定时任务）。

已收录内容不反复交给模型：官方页面只有出现上次快照里没有的羊毛相关句子时才重新抽取（删句、换序、空白变化只更新快照，计 `unchangedPages`）；已批准条目被重读且全部原文摘录仍在页面上时不再提交（`rereadUnchanged`），身份侧同一官方页面重读按 `same_source_reread` 沿用已批准版本；线索自身网址就是某条已批准条目的证据原文（同一网址或同一条 X 帖子）时直接关联、不调用模型（`leadsLinkedByUrl`）。自动受阻复核只处理 3 天内的线索，管理员补录和管理员手动重试不受限，更早的线索留在后台列表。

线索关联已有重置条目时按事件日期硬性校验（流水线三条路径及 Worker 复核结果），不同轮次降为人工处理。运行统计中复核/身份队列的等待与重试记入 `backlogDeferred`，不再使整轮 `coverageDegraded`；信源未抓、研判未执行、异常和核验失败仍算覆盖不完整。

## Discord 官方公告采集

2026-10-10接入：自建服务器关注厂商官方公告，再由读取Bot通过Discord REST API读取自己的接收文字频道，不访问其他服务器的消息API。Discord follow只同步厂商选择发布的公告，不等于完整时间线。

当前接收频道：official-announcements（1558646770689384560），自建服务器1558646769938735136。GitHub Secret为DISCORD_BOT_TOKEN，Variables为DISCORD_CHANNEL_ID及DISCORD_GUILD_ID；本机配置在忽略的.codex/discord.env，Token不得进文档、日志或提交。

信源discord-official-announcements加入每小时快速通道和每6小时全量通道。只接收IS_CROSSPOST且原始guild/channel匹配sources.config.publishers的公告；系统提示、普通成员发言、测试消息、原文已删除公告不产线索。当前已核实Midjourney guild662267976984297473 / announcements952771221915840552，依据为Midjourney官方文档直链。新增厂商需先核实官方入口与原始频道，再定向扩展映射；不能只凭Webhook名称、头像或正文自称官方。

来自未登记服务器/频道的转发会被跳过（不产线索、不再让整个信源失败），其消息链接记入当轮统计 `discordUnmapped`，并列在后台 补录 → 补信源 的「Discord 频道」卡中，选平台即可一键登记。正文、embed字段及附件链接保留，原始Discord消息URL用于去重。文本命中福利关键词或附有待核实附件的官方公告先产线索，沿现有研判/官方补证进入待审；身份可靠不等于活动批准，autoPublish保持false。

检查点为snapshots.hash的discord:<最后接收消息ID>，沿新到旧分页完整补回，先成功写线索才更新检查点。限流、权限错误、未知来源、正文不可读、超过分页上限或入库失败均保留原检查点并进入信源健康失败。默认20页（2,000消息），maxPages最大100；初次读取同样分页，适合本次新建接收频道。重放由原始消息URL去重；本版本不自动重抽旧消息的后续编辑，条款变更可人工补录/重新核验。

只读验证可运行python3 .codex/discord-probe.py .codex/discord.env；只输出身份、频道和计数，不输出Token或消息全文。频道暂无官方公告时，仅证明读取链路可用，不能声称真实福利已入库。

诊断补跑用collect.yml的only_sources=discord-official-announcements、fast_leads=true、lead_limit=0、lead_review_limit=0、official_review_limit=0，跳过模型与其他业务队列；正常定时运行沿既有预算和审核规则执行。


## 选择式会员资格运维

`GET /api/memberships`返回已确认、历史及资料未确认的目录项；访客都可以选，选择器不显示统一的“待核实”尾标。目录项只记录名称、所属产品、收费属性和来源，不等于福利资格匹配成功。`GET /api/admin/memberships`返回完整目录供审核。管理员通过POST同路径创建pending产品/套餐，公开选择器随目录更新自动出现新项；`/:id/impact?kind=product|plan`预览引用影响，`/:id/verify`只确认上述目录资料，不重新审批已上架福利。新待审活动或真实资格变更按仓库yangmao-review技能确认结构化条件；已批准旧活动仅因目录映射缺失时保留原批准与原文，不生成重复活动审核。目录缺项不准按品牌或档位相似度猜测。

2026-10-11迁移报告中的85条 `needs_review` 包含非公开记录，不是85条待重新审批的上线福利。2026-10-12公开API只读快照为32条已批准旧会员条目尚无结构化匹配，其中14条当前进行中或临期；它们仍在公开目录，个人“只看确定符合的”暂不计入。这个数字随活动结束或历史合并变化，查询前实时核对。

0036新增会员目录、目录审计与offers.membership_requirement；0037以保留行的方式扩展benefit_versions到terms-v2并增加版本迁移映射。发布前备份所涉表与当前版本；D1有FTS虚拟表时整库export不支持，使用明确的`--table`导出相关表并保存只读JSON快照。

`scripts/membership-backfill.ts --snapshot <snapshot.json> --out <plan.json>`仅生成本地预演。快照包含offers、当前approvedVersions和proposals；与`--sql-out`同用时必须提供`--expected-catalog`，可用`--rollback-out`生成保护性兼容回滚。快照与生成SQL含内部数据，保存在权限受限目录，不提交Git。整批原子执行SQL，任何目录/行/身份版本不匹配停止；不拆批绕过断言。迁移仅为确定等价条目创建新V2基线，其余保留needs_review；原V1不可变。

先在备份副本验证DDL迁移、数据迁移、FK完整性及回滚，再在生产迁移、部署、推送并读回公开目录/API/后台与浏览器筛选。新响应schema=membership-v1，更新identity_public_state.generation失效公开缓存。代码回滚必须先用兼容回滚恢复V1公开指针并核查所有新V2变更；保留新增字段、目录和不可变V2历史，禁止直接回到不识别V2的旧Worker处理新写入。


## D1配额熔断与公开快照

公开快照必须只含已批准字段，由`scripts/build-public-snapshot.ts <受限备份.sqlite> <快照ISO时间> public/public-snapshot.json`生成并随静态资源部署；每次部署保留或更新该资产，原始数据库备份不得上传。`D1_PUBLIC_SNAPSHOT_UNTIL`设置未来时间时，公开启动接口走快照，后台和采集返回只读503，定时任务暂停；期限后重试数据库。明确的D1额度错误也会触发快照退路。

`D1_REPAIR_RELATED_INDEXES=1`使恢复后的调度先幂等创建reviews(offer_id)、leads(offer_id)索引，再执行原任务；0038迁移登记相同索引。不得为节省读取消除身份回填的快照并发保护。判断额度异常先用Cloudflare分析接口取得日/小时/查询热点，避免继续消耗D1；不同adaptive数据集不能算精确占比。当前应急部署与尚待验证事项见[D1恢复凭证](d1-quota-recovery-2026-10-11.md)。

### 官方短帖补证与误关恢复

OpenRouter 官方上线公告的 Try it 短链、展开链接与卡片按 [专项规则](openrouter-evidence-recovery-2026-10-18.md)处理。X 原文与导航元数据分开，落地页证据绑定其自身 URL。仅缺额度描述或模型空输出不能关闭该官方线索。

后台“自动关闭抽查”的“误关”按钮会恢复审核；旧 wrong 但未恢复的线索同样列出。`POST /api/admin/screening/spot-check/:id/wrong` 接收列表的 `expectedVersion`；返回 `more=true` 时用返回的新版本继续，`recovery.state=completed` 才表示恢复完成，不能把恢复当上架。已关闭拒绝记录仍在，恢复决定取代旧拒绝，负面学习不再使用已纠正/已被取代的记录。该操作仅管理员可用，仍保留版本和每请求查询预算。

身份查重历史选项显示已上架、已拒绝或待审状态。对于身份未能证明且所选旧记录没有已批准版本的关联请求，接口明确提示改选已上架主条，或按重复拒绝并记录原对象；不自动批准或重开旧拒绝条。

误关恢复区分原始线索与已抽取候选：`lead-closure-v1` 的 observation-only 拒绝快照只作历史凭证；恢复时写取代旧拒绝的 reopen 决定，并将线索置为 retry、清空活动任务、立即进入正文研判和官方补证，不把整页快照生成待核对权益。聚合忽略已移交重研判的旧快照；普通完整候选仍按原身份任务恢复。中断后可继续恢复，不重复写决定。Linux.do 帖子读取优先 post/cooked 正文，Jina 文本按帖子边界去除导航、相关推荐和页脚，保留回复、图片及证据链接；无法识别时保留原文供人工核对。

快速上架补字段按实际发布内容生成请求修订号：历史回填检查失败已占用旧请求时，管理员纠正字段后以新修订恢复，保留旧凭证，仍经权益身份去重，不删除或覆盖旧请求。管理员可在needs_owner任务的complete请求中指定basis=official或tested，以明确亲测证据；审核员不能访问该接口。

## 快通字段真实模型重放验证

`gh workflow run collect.yml --ref main -f fast_track_review_job=<已有任务ID>`：读取该任务保存的真实模型初稿和当时正文，调用生产相同的独立字段核对函数与语义校验器，检查会员结构与目录；调用完成后才读取已批准主条目进行比对，主条目不会作为答案传给模型。此模式不重新发布或修改权益、任务和审批，只将模型用量计入既有预算，输出 `fast-track-semantic-verification` 凭证。用于重放真实错例，不能用成功的空队列运行替代。该输入与 `probe_urls` 不应同时使用。
