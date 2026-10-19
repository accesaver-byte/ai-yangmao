# 模型名称归一化核验记录（2026-10-19）

本次管理员授权：统一模型名称，清理重复及非具体模型项，修复免费模型活动的展示与搜索并上线。这里只记录执行结果，不更改活动的审批状态、官方证据或原权益条件。

## 核查范围

D1 原始快照共 473 条记录，287 条已批准，186 条已拒绝；已拒绝记录及旧审核历史保留。已批准记录有 394 种模型写法，确认 32 组重复写法和 42 种非具体模型项。本轮只改 60 条现行活动的 models 字段并写修订。另清空 Search/Fetch 工具限免活动误挂的收费模型；其原文明确模型 Token 照常计费。

## 官方名称依据

- [Z.AI GLM-5.3-Flash / FlashX](https://docs.z.ai/guides/vlm/glm-5.3-flash)：两个具体模型分别保留。
- [DeepSeek 模型调用说明](https://api-docs.deepseek.com/)与[10 月 17 日公告](https://api-docs.deepseek.com/news/news261017/)：API 动态别名与固定模型快照有区别，不据当前路由回写历史模型版本。
- [MiniMax 模型目录](https://platform.minimax.io/docs/guides/models-intro)：采用 MiniMax-M3.1-Flash 等标准名，保留 Preview。
- [OpenCode Zen](https://opencode.ai/docs/zen/)：Free 是平台提供方式，Contributor 资格保留。
- [OpenRouter 模型 API](https://openrouter.ai/api/v1/models)：对照模型 ID 与显示名，不把 openrouter/free 路由器视为具体模型。
- [NVIDIA NIM Gemma 4 31B](https://build.nvidia.com/google/gemma-4-31b-it)与[Nemotron 3.5 Super VL](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b)：核对跨平台模型名与调用 ID。
- [Black Forest Labs 模型目录](https://bfl.ai/models)及[FLUX.2 klein 说明](https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence)：保留 klein 参数规模及 pro/dev/max 等规格。
- [Vercel Laya 公告](https://vercel.com/changelog/laya-decision-model-now-available-on-ai-gateway-free-through-october-31)：laya 与 laya-free 为同一模型的不同计费路由。

- [Fireworks Muse Glimmer 训练说明](https://docs.fireworks.ai/fine-tuning/training-api/cookbook/muse-glimmer)：SFT 指免费训练方式，底座仍是 Muse Glimmer 30B。

## 合并的重复写法

| 标准名 | 本次发现的写法 |
|---|---|
| DeepSeek-V3.2 | `DeepSeek V3.2`、`DeepSeek 3.2` |
| GLM-5.3-Flash | `GLM-5.3-Flash Free`、`GLM-5.3-Flash`、`glm-5.3-flash`、`glm-5-3-flash`、`GLM-5.3 Flash`、`GLM 5.3 Flash` |
| DeepSeek-V4.1-Flash | `DeepSeek V4.1 Flash Free`、`deepseek-v4.1-flash`、`deepseek-ai/DeepSeek-V4.1-Flash`、`DeepSeek V4.1 Flash` |
| Nemotron 3.5 Super VL | `Nemotron 3.5 Super VL Free`、`nemotron-3.5-super-vl-120b-a12b`、`Nemotron 3.5 Super VL` |
| Nemotron 3.5 Lightning | `Nemotron 3.5 Lightning Free`、`Nemotron 3.5 Lightning`、`nemotron-3.5-lightning-30b-a3b` |
| Nemotron 3 Ultra | `Nemotron 3 Ultra Free`、`Nemotron 3 Ultra`、`nemotron-3-ultra-550b-a55b` |
| MiMo-V2.6-Flash | `MiMo-V2.6-Flash Free`、`MiMo-V2.6-Flash` |
| Space Bunny | `Space Bunny Free`、`Space Bunny` |
| LongCat 2.5 Preview | `LongCat 2.5 Preview Free`、`LongCat 2.5 Preview` |
| GLM-4.7-Flash | `GLM-4.7-Flash`、`ZhipuAI/GLM-4.7-Flash` |
| DeepSeek-V4-Flash-0731 | `deepseek-v4-flash-0731`、`deepseek-ai/DeepSeek-V4-Flash-0731` |
| DeepSeek-V4-Pro-0813 | `deepseek-v4-pro-0813`、`deepseek-ai/DeepSeek-V4-Pro-0813` |
| Seedance 2.5 | `Seedance 2.5`、`Dreamina Seedance 2.5`、`Seedance2.5` |
| Qwen-Image | `Qwen Image`、`Qwen-image` |
| FLUX.2 [pro] | `Flux.2 Pro`、`FLUX.2 Pro` |
| Ling 3.1 Flash | `Ling 3.1 Flash`、`Ling-3.1-flash` |
| Ling 3.0 Flash Sante | `Ling 3.0 Flash Sante`、`Ling 3.0 Flash Sante (free)` |
| GLM-5.2 | `GLM 5.2`、`ZhipuAI/GLM-5.2`、`GLM-5.2` |
| DeepSeek-V4-Pro | `deepseek-ai/DeepSeek-V4-Pro`、`deepseek-v4-pro` |
| Qwen3.8-27B | `Qwen/Qwen3.8-27B`、`qwen/qwen3.8-27b` |
| Step 3.7 Flash | `stepfun-ai/Step-3.7-Flash`、`Step 3.7 Flash` |
| Seedance 2.0 | `Seedance 2.0`、`Seedance2.0` |
| gpt-oss-20b | `openai/gpt-oss-20b`、`gpt-oss-20b` |
| Step 5 Preview | `Step 5 Preview`、`Step-5-Preview` |
| Muse Glimmer 30B | `muse-glimmer-30b`、`Muse Glimmer 30B SFT` |
| Laguna XS 2.1 | `laguna-xs-2.1`、`Laguna XS 2.1` |
| Gemma 4 31B | `gemma-4-31b-it`、`Gemma-4-31B-it` |
| Qwen3.8-Max | `Qwen 3.8 Max`、`Qwen3.8-Max` |
| Qwen3.8-Flash | `Qwen 3.8 Flash`、`Qwen3.8-Flash` |
| Wan 3.0 | `Wan3.0-video`、`Wan 3.0` |
| Laya | `convaiinnovations/laya`、`convaiinnovations/laya-free` |
| Beam | `beam`、`Beam` |

## 移除的非具体模型项

这些字段值是厂商、产品、系列统称、服务或路由器。活动本身仍保留，具体权益继续由公开说明和原证据表示。

`Gemini 3`、`Seedream`、`GPT-Image`、`Gemini`、`Gemma`、`OpenAI models`、`Anthropic models`、`Google Gemini models`、`Kimi.ai`、`Alibaba Cloud`、`MiniMax`、`Brave Search`、`Firecrawl`、`Browserbase`、`LlamaParse`、`PDF.co`、`Amazon Transcribe`、`Amazon Translate`、`Manus 2.0 Lite`、`GPT Image`、`Manus 2.0 Max`、`Manus 2.0`、`Qwen 2.5`、`FLUX`、`openrouter/free`、`Gemini Advanced`、`Hogee数字员工`、`Gemini Enterprise Plus`、`OpenAI`、`Anthropic`、`Google Gemini`、`Qwen 3.8`、`Google Antigravity`、`Qoder 全系模型`、`StepClaw`、`ChatGPT Enterprise`、`Claude`、`WorkBuddy`、`GPT`、`Grok`、`500+ closed and open-weight models`、`Manus`

## 验证边界

统一规则同时用于录入、公开 API、配额降级快照、网页、Agent 搜索与身份事实比较。不同小数版本、日期快照、参数规模、Preview、Contributor、fast mode、第三方衍生模型仍为不同项。Command A / A+、Command R / R+ 是真实不同模型，保留加号。

操作原始数据、逐活动变更清单、SQL 与备份仅保存于受保护的本机临时文件，不作为网站资源或提交内容。
