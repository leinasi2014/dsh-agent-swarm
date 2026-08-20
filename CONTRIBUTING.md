# 贡献与开发流程（GitHub 集成版）

本文件定义从“接任务”到“任务关闭后处理”的完整标准流程。治理宪法见 [AGENTS.md](AGENTS.md) 与 [docs/11-official-first-development.md](docs/11-official-first-development.md)；工程门禁见 [docs/08-testing-verification.md](docs/08-testing-verification.md) §9。冲突时以 AGENTS.md 为准。

## 1. 开发前置（每个里程碑 / 每次官方可能漂移时）

```sh
pnpm verify:gate-a   # 官方 remote + 两个参考仓库 pin 联网核验
```

- 官方 remote 已移动 → 触发 Gate C（冻结受影响能力、diff、迁移），不得直接继续。
- 每个里程碑开工前确认 `docs/07-implementation-roadmap.md` 的 Gate A 记录仍然有效。

## 2. 分支模型

| 规则 | 说明 |
|---|---|
| `main` | 唯一集成分支，保持线性历史，必须始终 CI 绿 |
| 功能分支 | 从 `main` 切出，命名 `<type>/<slug>`（`feat/…`、`fix/…`、`docs/…`、`chore/…`、`refactor/…`） |
| 禁止 | 直接向 `main` 推送、force push、merge commit（用 rebase merge 保持线性） |
| 历史分支 | `codex/glm-review-fixes` 是 M0/M1A 历史快照，不再开发 |

### 2a. 并行 worktree 隔离开发规范（2026-08-20 起，PM 多智能体委派默认模式）

多任务并行时，每任务一个独立 git worktree，物理隔离杜绝树竞争：

**布局与生命周期**

```sh
# 创建（主树在 main、干净状态下）
git worktree add ..\dsh-agent-swarm-wt-<slug> -b <type>/<slug> main
# 初始化（每个 worktree 独立执行；pnpm store 硬链接，秒级）
cd ..\dsh-agent-swarm-wt-<slug> && pnpm install
pwsh -NoProfile -File ref/dsh-agent-teams/sync-reference.ps1
pwsh -NoProfile -File ref/jiuwenswarm/sync-reference.ps1
pnpm verify:structure   # 自检：refs/门禁就绪
# 回收（PR 合并后）
git worktree remove ..\dsh-agent-swarm-wt-<slug> && git branch -d <type>/<slug>
```

**分工纪律**

| 角色 | 领地 | 职责 |
|---|---|---|
| PM（主树） | `D:\Source\DSH\plugin\dsh-agent-swarm`，**永远停在 main** | 审查（fetch 远端 diff）、治理、守卫合并、worktree 调度 |
| 实现智能体 | 自己的 worktree，**分支已检出、禁止 switch** | 实现+测试+verify+PR；禁止触碰主树与其他 worktree |

**任务分配与合并**

- 并行任务优先选**不相交文件面**；交叠面（如同改 tools.ts）在委派合同中声明"保持内聚，冲突由 PM 合并时解"。
- **合并保持串行**：PM 逐 PR → `node scripts/merge-guard.mjs <pr>`（双绿守卫，见 §4）→ rebase 合并；后合并者如冲突，由 PM rebase 解或退回该任务的智能体。
- 并行上限 2-3 路（审查与冲突成本随路数上升）；worktree 是 git 内置能力，与 ADR-0008 的 D2"插件自我开发"边界无关——后者指插件运行时的自托管能力，此处是开发流程的标准 git 隔离。

## 3. 提交与本地门禁

- Conventional Commits：`feat|fix|docs|chore|refactor|test(scope): 摘要`，正文写“为什么”。
- 提交前 lefthook 自动对 staged 文件跑 oxlint；**提 PR 前 `pnpm verify` 必须全绿**（结构/规模上限 → lint → 重复 → 死导出 → 双类型检查 → 测试 → 构建 → 产物）。
- 新增 src 文件超过 600 行会直接失败；例外必须在 `scripts/verify-project.mjs` 登记原因与归还里程碑。

## 4. PR 流程

1. 推送分支 → `gh pr create --base main`（模板自动加载，逐项勾选）。
2. CI（`.github/workflows/verify.yml`：参考 pin 核验 + 官方证据 + 完整 verify + Gate A 联网核验 + 覆盖率）必须绿。
3. 审查通过后用**双绿守卫合并**：`node scripts/merge-guard.mjs <pr>`——它会轮询到全部 check 终态、要求零失败且至少一 pass 才执行 rebase 合并（私有仓库免费版无 required checks，守卫把"双绿才合"从纪律变成机制；禁止裸 `gh pr merge`）。
4. PR 描述用 `Closes #N` 链接 issue，合并即自动关闭并推进里程碑。

## 5. Issue / 里程碑 / 标签体系

- **Milestone** = 路线图里程碑（M1B、M1C、M1D、M2、M3、Backlog=M4+），与 `docs/07` 一一对应；里程碑完成以 docs/07 的 exit criteria 为准，不以 issue 清空为准。
- **type:** `feat` / `fix` / `docs` / `chore` / `refactor` / `test`
- **area:** `domain` / `runtime` / `storage` / `tools` / `docs` / `ci` / `security`
- **finding:** `F2`–`F17`（独立审查发现编号，便于从 issue 追溯到审查报告与回归验证）
- 无截止日期约束：进度按 exit criteria 驱动，不按日历驱动。

## 6. 单个任务完成之后的处理（标准收尾清单）

1. 本地 `pnpm verify` 全绿；新增行为有对应测试层证据（docs/08 §1）。
2. 同一 PR 内完成文档同步（AGENTS 规则 12：README、受影响设计文档/ADR、`docs/09-sources.md`、`docs/10-fusion-audit.md`、roadmap、Skill——仅当官方事实或集成所有权变化时）。
3. PR 合并（rebase）→ issue 自动关闭 → 检查里程碑剩余任务。
4. 触及审查发现（F 系列）的修复，在 issue/PR 中引用发现编号，供 M1D 回归审查汇总精确 diff。

## 7. 里程碑完成之后的处理

1. 对照 `docs/07` 该里程碑 exit criteria 逐项核验，更新 roadmap 状态与 `docs/10` 审计基线（同一 PR）。
2. 打里程碑 tag：`git tag m1b && git push --tags`（M1 完成后打 `v0.1.x` 预发布由 M1D 决定）。
3. 里程碑引入新官方事实 → Gate A 记录更新（`docs/11` 变更记录）。
4. **M1D 专属**：委派独立 GLM-5.3 回归/安全审查（按 `docs/12`，不设时长/轮次/token 上限，审查员拥有最终 verdict）；通过后才允许 D1 单写入者 dogfood（ADR-0008）。
5. 后续里程碑的 D2/D3/D4 开放同样以 ADR-0008 就绪等级为准，不因 issue 清空而自动开放。

## 8. 独立审查与自托管边界

- 审查委派、取证、整改、复审遵循 [docs/12-independent-review-management.md](docs/12-independent-review-management.md)。
- 自托管/自我开发遵循 [docs/13-self-hosting-dogfood.md](docs/13-self-hosting-dogfood.md) 与 ADR-0008：稳定控制面与候选面分权，运行中的插件不得自我晋升。
