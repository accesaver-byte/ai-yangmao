# 双人协作与发布边界

## 仓库与职责

2026-10-15 通过 GitHub API 核实：

| 名称 | 仓库 | 用途 |
|---|---|---|
| `origin` | https://github.com/552385743265hb-code/ai-yangmao | 你的 Fork，推送功能分支 |
| `upstream` | https://github.com/accesaver-byte/ai-yangmao | 同事原仓库，获取更新、接收 PR |

两个仓库默认分支均为 `main`。核对时二者与本地起点均为 `d31366d`。当前 GitHub 身份可管理自己的 Fork，对原仓库仅有读取权限；原仓库合并由有权限的同事完成。

本机已设置 `remote.pushDefault=origin`、`push.default=simple`；`upstream` 的 fetch URL 保留原仓库，push URL 设为 `DISABLED`，防止误推。该设置只在本机 `.git/config`，不会随提交传播。

本次分支：`chore/windows-local-development`，只整理 Windows 本地开发、公开数据导入工具与协作文档，不包含首屏性能优化。原有 `main` 保留为同步基线。

## 每个功能的固定流程

1. 开始前运行 `git status --short`。有未提交改动时先在所属分支整理提交；不通过强制切换、清空目录或覆盖文件解决。
2. 获取同事更新，快进本地基线。以下命令分步执行；任何一步报错立即停止，不继续向后运行。

   ```powershell
   git fetch upstream
   git switch main
   git merge --ff-only upstream/main
   git switch -c feat/具体功能名
   ```

   功能分支可使用 `feat/…`、`fix/…`、`chore/…`。如果 `main` 已分叉，先检查差异，不使用 `reset --hard` 或强推。

3. 在本地实现和验收：`npm.cmd run typecheck`、`npm.cmd test`；前端改动增加 `npm.cmd run build:web` 和浏览器操作验收。数据库及测试数据使用本地模式，说明未覆盖的线上行为。
4. 只暂存本次功能的明确文件，检查 `git diff --cached` 后提交。不要提交 `.dev.vars`、`.prod.secrets`、`.wrangler/`、数据库备份、线上快照、令牌或客户数据。
5. 用户明确要求推送/提 PR 后，推送功能分支到自己的 Fork：

   ```powershell
   git push -u origin feat/具体功能名
   ```

   PR 的 **base repository** 选择 `accesaver-byte/ai-yangmao`、**base branch** 选择 `main`；**head repository** 选择你的 Fork，分支选择本次功能分支。不要误把 PR 提到自己 Fork 的 `main`。

6. PR 说明包含问题、改后行为、验证结果、数据库/配置影响和未验证范围。同事审阅合并。若原仓库更新且需要处理冲突，在功能分支合并 `upstream/main`，解决后重新验证，默认不强推重写共享历史。
7. 合并后重新 `git fetch upstream`，在干净工作区切回 `main` 并 `git merge --ff-only upstream/main`，再开始下一项功能。自己的 Fork `main` 如需更新，在发布触发边界确认后单独同步；功能分支无需等待 Fork `main` 更新即可基于 `upstream/main` 开发。

## 自动化核对结果与限制

本次抓取原仓库最新 `main` 后，核对了当前 `.github/workflows/` 中五个文件：

| 工作流 | 触发方式 | 行为 |
|---|---|---|
| `check.yml` | push / pull_request | 安装依赖、类型检查、测试；没有 Worker 部署步骤，未包含前端构建 |
| `collect.yml` | workflow_dispatch | 运行采集管线，可能写业务数据；Worker 定时通过 API 调用它 |
| `distill.yml` | 每周定时 / 手动 | 归纳纠正规则，可能推送规则分支、创建 PR |
| `extraction-lessons.yml` | 手动 | 调用模型做抽取回归，可能产生模型用量 |
| `valuation-v2.yml` | 手动 | 真实模型估值验收，可能产生模型用量 |

当前树没有 `wrangler deploy` 的 Actions 工作流。原仓库 Actions API 还列出两条历史 Phase 1 验证工作流登记，它们不在当前 `main` 文件树中，不作为现役部署配置。检查结果来源显示 GitHub Actions；读取到的最近五条 GitHub deployments 列表为空。

自己的 Fork：Actions 总开关 `enabled=true`，本次工作流列表 `total_count=0`；不能据此推断未来推送一定不运行工作流，也没有主动启用/触发任何工作流。

**尚未确认 Cloudflare 控制台中的 Workers Builds / Git 集成。** 当前身份无法读取原仓库私有 Webhook 设置，自己的 Hook 查询也缺少所需 scope；空 deployments 列表不证明不存在外部自动部署。需要同事提供或共同核对 Cloudflare 的仓库绑定、生产分支、非生产分支构建开关和部署命令。没有为本次核对申请更大权限或改动平台设置。

`wrangler.jsonc` 仍指向正式站点 `ai-yangmao.com` 和原 D1 绑定。`npm run deploy` 会构建并执行 `wrangler deploy --keep-vars`；`db:migrate` 和 `seed` 使用远端模式。它们不属于日常本地开发步骤。采集工作流使用 `API_BASE` / `INGEST_TOKEN` 等运行配置，不能把生产凭据复制到 Fork 来尝试运行。

## 合并与上线分别处理

本地提交、推送 Fork、创建 PR、同事合并、正式部署、线上核验是六个不同状态。PR 通过不证明已上线，部署成功也不证明真实用户流程通过。

建议正式发布继续由同事或双方明确指定的负责人执行，发布前确认合并提交、目标账户与域名、迁移、备份及回滚方案，并按 `operations.md` 留证。若 Cloudflare 已设置合并即发布，应在合并前完成发布确认，不能先合并再当作尚未部署。

本轮仅配置本地同步来源、创建分支与整理本地提交；不推送、不创建 PR、不触发工作流、不部署、不写生产数据。
