# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**持久化多 Agent 团队编排插件**：崩溃安全的任务协作层——任务 DAG、attempt 围栏、审核门、持久邮箱、预算计量、可执行审查，全部构建在官方服务 seam 之上。

- **不修改 Agent Loop**、不影子注册任何官方服务——单一权威状态经 `TeamDomainPort` 存于官方 Storage Domain（ADR-0007）。
- 消费两个参考仓库的成熟机制（`dsh-agent-teams` 的团队协议、JiuwenSwarm 的预算/审核/调度思路），映射到 DSH 原生边界，不嵌入任何第二运行时。

## 安装状态

本项目目前是 `private` 的预发布插件，**没有已接受的公共 npm、Git shorthand 或插件市场安装入口**。不要使用仓库历史文档中的 `leinasi2014/dsh-agent-swarm` 或 `npm:@dsh-agent-swarm` 形式；它们不是当前可解析的发布身份。

当前可执行的验收路径是从干净、冻结的插件候选构建一次本地不可变 tarball，再装入 fresh isolated official Profile。命令必须从本仓库运行；`--output` 必须是尚不存在的新目录：

```powershell
$official = 'D:\Source\DSH\deepseek-harness'
$proof = Join-Path $env:TEMP ('dsh-swarm-p0-' + [guid]::NewGuid().ToString('N'))
$browser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$candidateCommit = git rev-parse HEAD
$candidateTree = git rev-parse 'HEAD^{tree}'
node scripts/p0/run.mjs `
  --repo (Get-Location).Path `
  --official $official `
  --cli (Join-Path $official 'apps\cli\lib\bin.js') `
  --output $proof `
  --browser-executable $browser `
  --port 47940
node scripts/verify-p0-profile-proof.mjs `
  --root $proof `
  --candidate-commit $candidateCommit `
  --candidate-tree $candidateTree
```

该入口使用官方 CLI 的真实 `plugin --profile web add -w --ignore-scripts <absolute-tgz>` 语法。安装只贡献一个 `disabled: true` 的结构性 `cordis:group`，不会因 `plugin add` 自动启动 Swarm；Profile owner 必须在后一层对 `agent-swarm` 显式设置 `disabled: false` 才会激活其子插件。验收在隔离 `DSH_HOME` 中组合官方 Storage hub、JSON KV、Storage Domain、Session persistence 和 Swarm，且 workspace/sandbox、storage 与 session roots 相互分离。它先用官方 `workspace.create` 建账，再用 `session.create({ workspaceId })` 建立 exact live root；test-only probe 仅在该 root 尚无 turn 时追加一个匹配的空 `turn/start`/completed `turn/end` 并通过官方 `sessions.flush` 持久化，使真实 UI 拿到无 LLM、无网络、无伪造人类消息的 nonblank Session。证据记录 Workspace 回声/Session 归属、seeded/reused 模式、事件 seq/type 与 flush 参与情况。随后通过真实 Swarm runtime 创建并在重启后恢复 Captain Team，并读取该 Team 的 binding/status/snapshot 和三类分页。Fresh browser context 仅预置官方 SessionRuntime 的 `dsh.sessions.current={sessionId}` 选择记录；证据冻结其 key/value 与官方 source blob/digest，且 R2 Host 仍会独立重验 framework target，不把它当成 authority。由 `--browser-executable` 显式定位的真实 Chromium 还会验证 exact attached/nonblank root、DSH-native Team 面板、官方主题/locale、键盘打开、截图、同一 Session 的 Captain Chat handoff 与 reload。R0 按官方 loader 语义验证禁用条目后 Team action 不挂载、零 Team 数据；同一 runner 在浏览器外用 Node fetch 读取并冻结 `/swarm/v1` 的 `405`、UTF-8 空 body 和缺失 content-type，只有三项同时匹配 rc.2 Host fallback 才推导为 Swarm route 未注册，因此浏览器仍必须保持零 console/page error。Remove 再独立证明 package/inventory row 与客户端入口消失。浏览器 locator/version 会写入证据。同时覆盖优雅 unload、显式启用但缺 Storage Domain 时 fail closed。运行态目录和端口随后清理，只保留同一 tarball、digest、关键命令/清单/R2/R3 回执、截图及逐文件 bytes+sha256 manifest；不会读取或写入用户默认 `~/.dsh` Profile。

`dsh plugin`、`--dump-config` 甚至某些帮助路径都可能初始化或修复 Profile，因此不要在用户默认 home 中“试一下”这些命令。上述流程只证明一个精确本地 tarball 能在隔离的官方 Profile 中完成预发布验收；它不构成公共安装、兼容承诺或发布证明。

`link:<path>` 仅用于本地诊断，不能作为验收或发布身份。兼容范围由 `package.json` 的 peer dependencies、锁文件和 [docs/OFFICIAL_BASELINE.json](docs/OFFICIAL_BASELINE.json) 共同定义；不要从 README 中推断滚动版本状态。

### 快速开始

```
你（对 captain 说）：建一个三人团队，分解"给仓库加集成测试"并开始执行。
captain（插件驱动）：
  1. agent_swarm_create            → 建团队（captain = 当前会话）
  2. agent_swarm_add_member ×3     → continuable 成员（persona/工具围栏）
  3. agent_swarm_create_task ×N    → 任务 DAG（blockedBy 依赖 + 验收标准；职责固定时声明 target_member）
  4. （调度器自动指派 → 成员执行 → agent_swarm_submit_task）
  5. agent_swarm_review_task       → 你审核 accept/reject
```

规范清单是跨两个互斥运行模式的 20 个不同 `agent_swarm_*` 工具定义，不代表任一时刻同时暴露 20 个工具。默认模式实时注册 19 个；`experimentalFreshV2=true` 时改为仅注册 6 个纵切工具：`agent_swarm_create`、`agent_swarm_add_member`、`agent_swarm_create_task`、`agent_swarm_continue_task`、`agent_swarm_submit_task`、`agent_swarm_reassign_task`。fresh-v2 不是“默认 19 个再加 1 个”。见 [docs/04-core-protocol.md](docs/04-core-protocol.md) §4。

## 核心能力

- **任务板**：DAG 依赖、优先级、可选严格成员定向（阻塞期间持久且不回退）、revision CAS + attemptId 双围栏（后到者 fail-loud，`TEAM_TASK_STALE_REVISION` / `TEAM_ATTEMPT_STALE`）；
- **审核门**：`submitted` 绝不自行完成——captain `review_task` 是唯一 accept/reject 权威，支持可执行审查（验证命令在隔离审查根执行，证据不可伪造，#101）；
- **持久邮箱**：queued-before-delivered、按消息 ID 目标侧去重、quiet/wakeup 两种语义（wakeup 的 `delivered` 仅在模型可见后提交，#52/D1）；
- **预算**：token/request/retry/deadline 四限 + 官方对齐的完整计费 token 计量（seq 游标幂等，插件账本为唯一计量路径，#127 边界声明）；
- **团队/个人记忆**：有界持久写入与授权查询；可在 DSH「设置 → 插件 → 插件配置 → Agent Swarm」中选择官方 Provider/model、候选上限和超时，用于重排已授权 Team 候选，故障时显式回退确定性检索。
- **成员配置与详情**：分离子智能体运行 Provider 和 LLM Provider/model，持久化创建时 deny 快照与 Skill 指派；每任务动态工具改权在当前 DSH continuation seam 上明确为不支持。
- **调度**：事件驱动（idle 边沿/任务图变更/预算释放）、搁浅自愈（live-idle 重试、cold owner 证据暴露）、可替换 Scheduler Provider；
- **Fresh-v2 显式续跑（实验）**：成员在当前官方 turn 内持久化一次同 Attempt 续跑意图；只有 durable turn settlement、官方 idle、Captain `followup` 接受、目标 inbox claim、Session flush 和 `llm/stream` 派发见证全部成立，assistant 证据才让同一 Attempt 回到 running。当前只验证在线路径；冷启动恢复、未知投递对账和正式 Profile 验收仍未完成，默认关闭。
- **中断控制**：模型侧 `interrupt_member` 只在 Host 从目标当前 turn 读到持续至少 10 分钟且尚未结算的真实工具调用时开放；沉默、规划时间、无文件/Git 变化和 wait 次数均不能授权。直接用户停止走带 Host 身份证明的 Human Control，不接受模型自述证据；
- **编排桥**：官方 `WorkflowEngine`/`JobRegistry` 的 Team 桥（isolate 域注册，run overlay 为唯一 run 真相）、显式 `adaptive|workflow` 模式 + 单 owner 纪律（#77）；
- **执行根**：per-attempt worktree 隔离 + attemptId 围栏 + 重指派工作树继承 + 已接受依赖制品注入 + 崩溃泄漏对账（#100）；
- **自托管控制面**：候选冻结→验收→晋升→回滚的外部 promoter 全链（P0–P7 演练实证，#102/#122 加固）。
- **本机只读 Team 接口**：versioned `POST /swarm/v1` 与 browser-safe `dsh-agent-swarm/client`；Host 每次重绑 official live root/Session/workspace/captain Team。该接口仅在 `127.0.0.1` listener、loopback socket 与同源 authority 可验证时可用，不提供用户认证、LAN trust 或任何 write capability。预发布证据只覆盖 README 所列隔离 Profile 流程，不外推为 LAN、多用户或写操作能力。
- **DSH-native Team 面板**：官方 Session log 右侧是相邻的 Team 与 Tool Details 操作。Team 是直接的打开/关闭二态开关；面板通过 DSH 公开 Slot 的临时优先级进入官方 `details` 列，宿主允许三栏时 Chat 真实收缩。相邻 Tool Details 操作释放 Team、停止 Team 读取并打开原生右栏，使原有 DetailsPanel 原位接管；插件不维护或复制 Tool 状态。较小窗口完全服从官方 AppFrame 将 details 收缩为零的响应式规则，窗口重新可容纳时自动恢复；插件没有 Peek、compact、悬浮卡片或私有 DOM/CSS 布局补丁。卸载、HMR、Session 切换或 Team 渲染失败都会释放临时 occupant；不修改官方 WebUI 文件，不读取私有布局/Chat 状态。所有 Swarm 文案、枚举和时间格式跟随 DSH 当前语言，颜色、边框和字体只消费当前官方主题 Token。“打开 Captain Chat”仍先重验 R2 binding，再通过官方 Session 导航进入同一 root Session；不解析 transcript，也不产生 Control。

## 文档

- [docs/README.md](docs/README.md) — 全部设计文档的阅读顺序索引
- [docs/00-vision.md](docs/00-vision.md) — 产品目标与兼容立场
- [docs/04-core-protocol.md](docs/04-core-protocol.md) — 协议权威（每个决策段都可追溯到 issue/PR）
- [docs/07-implementation-roadmap.md](docs/07-implementation-roadmap.md) — 里程碑与出口标准
- [docs/11-official-first-development.md](docs/11-official-first-development.md) — official-first 开发门（Gate A/B/C）
- [docs/adr/](docs/adr/) — 架构决策记录（ADR-0001..0009；以各文件 `Status` 区分 proposed/accepted）

## 开发

```bash
pnpm install && pnpm verify     # 全链：治理→结构→lint→重复→死导出→类型×2→测试→场景审计→构建→产物
pnpm verify:gate-a              # 官方基线三方核验（remote/checkout/packages）
```

当前采用单检出单写者；候选、审查、串行集成和外部推送边界见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目绑定与权威入口见 [AGENTS.md](AGENTS.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。
