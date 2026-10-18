# Codex Day 13 重置漏收排查

2026-10-18 当次凭证；管理员明确要求排查两条 Tibo 公告并作为历史羊毛上架。

## 原因与链路

- 主公告：[Day 13/ Le limit reset](https://x.com/thsottiaux/status/2111492673890824348)，2026-10-17 16:20:57 UTC。
- 同线程回复：[Landing sometime today by EOD PST](https://x.com/thsottiaux/status/2111492738025959922)，16 秒后的到账预告，和主公告为同一次发放。
- AIHOT 重置接口的本轮 `posts` 只有到账回复，主公告存在于 `posts[0].context`，`relation=reply`、`author=thsottiaux`。旧采集器只遍历 `posts`，没有读取上下文。
- 线索 #7735 于 2026-10-17 17:27:48 UTC 入库；其原始文本只剩到账预告。关键词没有关闭本条线索，筛选为 `shadow/unsure`，没有 applied action。
- 17:30:55 UTC 官方第一方嵌入抓取也是到账回复。模型产出候选，但结构化身份事实全部为 unknown；17:31:04 UTC 因 `identity_unproven` 进入人工查重卡，扫描同平台 24 个实体后停在 manual。不是拒绝、入口过滤或确认与旧轮次重复。
- 另发现普通动态关键词只认 `Day N/ Reset`，漏认 `Day 13/ Le limit reset`；这不是 #7735 被关闭的原因，但使普通动态缺少独立发现主帖的机会。

## 生产处理与读回

沿用原候选及人工查重卡，确认新轮次，再完成首次审核；未重复建立线索。生产主条目为 `identity-e5458953-b396-4dcd-80dc-269a16bcce7a`，短码 **kqze**。

- [公开详情](https://ai-yangmao.com/#offer-identity-e5458953-b396-4dcd-80dc-269a16bcce7a)及公开 API 已读回：`reviewState=approved`、活动已结束；真实浏览器显示标题、员工证据、历史日期及暂定参考价值。
- `claimStart=claimEnd=2026-10-17`、`sourceTz=America/Los_Angeles`、`publishedAt=2026-10-17T16:20:57.000Z`；网页按访客时区另外换算截止时刻。
- 原候选“全球”和具体 Plus/Pro 档位无本轮原文支持，已移除；`audience=unclear`，公开注明具体适用账号与恢复用量以账号页为准。不承诺所有免费账号都收到重置。
- 采用既定 V2 参照：本次实读 OpenAI Plus 帮助页正常月付 $20，$20÷4×1=$5；`provisional/plan_fraction`，不作为官方赠金面额或适用套餐证明。
- 线索 #7735 经既有 reconcile 接口重算为 linked，关联 kqze；原身份卡与首次审核卡均 resolved。生产复查仅一条本轮公开活动。
- 完整原因、原帖与字段取舍保存在管理员 `reviewMemo`；没有写入公开心得。

## 源头修复与验证

`pipeline/collectors.ts` 找回同作者直接回复上下文里的主公告，核对作者、网址和 ID，排除 quote 旧轮次，优先完整原文并按推文 ID 去重。`pipeline/lib.ts` 补上同一行 `Day N/` 后带简短修饰词的 reset 写法。

先增加回归测试：旧代码 3 个断言失败；修复后针对测试 23 项通过。使用本次真实 AIHOT 响应只读重放，正确生成一条以主公告为 URL、含主帖和到账回复的线索。`npm run typecheck` 通过，`npm test` 为 1300 项 Vitest 加 11 项审核脚本测试通过。

本次生产活动已上架；采集代码修复仅本地提交，未推送或部署。GitHub 采集读取远端 main，须发布管线代码后才采用新解析；Worker 无需为这次纯管线修复重新部署。本凭证不证明后续定时任务已使用修复。
