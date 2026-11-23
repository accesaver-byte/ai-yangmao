# AIHOT Antigravity / Claude / Grok Bot reset 自动上架

管理员于 2026-11-22 明确授权：Antigravity 与 Claude 的额度重置“与 Codex reset 一样”自动上架；2026-11-23 扩展到 Grok Bot。执行路径、身份去重、版本化批准、持久续传和撤销方式沿用 [Codex 专项说明](aihot-reset-auto-publish-2026-10-18.md)，以下只记差异。

## 授权范围

| 产品 | 信源 ID | AIHOT 接口 | 平台 | 登记账号 | 署名 |
| --- | --- | --- | --- | --- | --- |
| Codex（2026-10-18） | `aihot-resets` | `/api/v1/codex-resets` | `openai` | @thsottiaux（staff） | `policy:aihot-codex-reset-v1` |
| Antigravity | `aihot-antigravity-resets` | `/api/v1/antigravity-resets` | `google` | @_mohansolo（staff） | `policy:aihot-antigravity-reset-v1` |
| Grok Bot（2026-11-23） | `aihot-grok-resets` | `/api/v1/grok-bot-resets` | `xai` | @bot（official，X 商业标签 SpaceX Super Intelligence） | `policy:aihot-grok-reset-v1` |
| Claude | `aihot-claude-resets` | `/api/v1/claude-resets` | `anthropic` | @ClaudeDevs（official）、@lydiahallie（staff） | `policy:aihot-claude-reset-v1` |

- 三个产品在 `src/shared/aihot-reset.ts` 的 `AIHOT_RESET_PROFILES` 各有一份配置；信源 ID、kind 和接口地址必须与配置完全一致才适用授权，各自的 `sources.auto_publish` 单独开关。授权不扩展到 `aihot-items` 或一般福利。Grok Bot 重置卡、写明 SuperGrok / X Premium 等付费资格的原帖保留审核。
- 账号须同时登记在对应平台的 `x_handles` / `staff_handles`：Lydia Hallie 于 2026-11-22 登记为 Anthropic `staff_handles`。
- 候选的抽取版本为 `aihot-<产品>-reset-v1`，续传按候选的版本找回所属产品，关掉某个产品的开关只停该产品。

## 与 Codex 的差异

- 必须有 AIHOT 事件；没有事件时不回退到读英文原帖，保留常规审核。
- Codex 才有“Day N”编号与 Plus 月价四分之一估值；Antigravity / Claude 不估值。
- Claude 重置卡（`reset_credit`）以原帖写明的使用截止日为 `claimEnd`（如 “before December 10” → 12-10）；没写截止日保留审核。Antigravity 重置卡没有模板，保留审核。
- Claude 套餐按已核实会员目录映射：Max → Max 5x / 20x，Team → Team Standard / Premium；目录中没有的套餐（如 Ultra）保留审核。Antigravity 原帖若写付费套餐资格，暂无映射，保留审核。
- 原帖写 “everyone affected” 等只面向受影响账号的，或 AIHOT 记录了适用范围（`scope`）而原帖没写成可结构化套餐的，保留审核。
- Claude 的“5 小时和每周的用量限额”是额度名称，不按“每周重置”周期安排拦截；真正的周期说法仍拦截。

## 上线状态

上线、开关与首轮核验以 PR 和运行记录为准；本文件只证明 2026-11-22 的授权与设计。
