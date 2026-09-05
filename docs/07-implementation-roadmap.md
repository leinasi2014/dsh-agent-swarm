# 07. 到 90% 产品就绪的交付路线

本路线从当前代码事实出发，不保留旧 milestone 字母/编号，也不登记实时任务状态。Git、测试、真实 Profile/browser 证据和项目动态 provider 决定某项是否完成。所有交付遵循 official-first：先复用官方公开 seam，再实现插件能力。

## 1. 当前基线

已存在的可执行产品纵切：

- Main Brain 创建多个 managed Team，每个 Team 有独立 Captain Session；
- Captain 招募 continuable members，设置 identity/goal/announcement，建立任务 DAG；
- Scheduler/Workflow 分配 fenced attempts，成员提交，Captain/Review Provider 接受或 rework；
- Team aggregate、mailbox、budget、memory 和 overlays 通过官方 Storage Domain 持久化；
- 26 个模型工具、read Host、`/swarm/v1`、Team Workbench V3 和 Plugins 设置页已在源码中组合；
- unit、composition、restart、fault、UI、package 和 Profile-proof 检查已有工程入口。

当前仍是预发布：公共发布、通用 browser writes、Canvas、remote/distributed 和完整发布级 E2E 未完成。因此本文不声明“当前已达到 90%”。

## 2. “90% 产品就绪”定义

90% 是一次可审计的产品门，不是按文件或测试数量估算的百分比。达到该门需要：

1. **核心代表场景稳定**：fresh official DSH Profile 中，Main Brain → 两个独立 Captain → 异构成员 → 依赖任务 → review/rework → accepted result 全程可复现。
2. **身份与权限可信**：Main Brain、Captain、Member、human principal、Team、Session、revision 和 attempt 不混用；所有越权/stale 路径 fail-closed。
3. **持久与恢复可信**：重启、reload、interrupt、失败重试、budget exhaustion、storage/write failure 和 residue 都有权威读回。
4. **主要 UI 可用**：多 Team、身份、Skills/tools、任务、公告、设置、Captain Chat、loading/stale/reconnect/error 和基础 accessibility 通过真实 browser 验收。
5. **可安装可回退**：immutable tarball 在隔离 Profile 中安装、禁用、重载、升级、回滚和卸载；没有 listener/route/session/storage 泄漏。
6. **发布 claim 诚实**：文档、package、兼容矩阵和已知限制与同一候选一致。

剩余 10% 可以包含非核心的 Canvas、远程成员、distributed scale 和自动 Skill Evolution；未交付项必须明确 unavailable，不能伪装成部分完成。

## 3. 交付顺序

### A. 冻结核心产品合同

目标：把当前宽广实现收敛为可维护的稳定核心。

- 冻结 Main Brain/Captain/Member identity topology、26 工具 schema、Team aggregate 和 read RPC v1。
- 删除或合并重复入口、旧 alias 和无真实 Consumer 的 speculative seam。
- 为 Skills、tools、model route、settings 和 multi-Team projection 建立一致的 bounded contract。
- 确认每个 optional Provider 的启用条件、capability disclosure、disposer 和 fail-closed 错误。

出口：协议/fixture digest 固定；受影响 contract、lifecycle、restart 和 negative tests 通过；没有第二 authority 或无法解释的兼容路径。

### B. 完成用户主路径

目标：让用户无需阅读内部协议即可完成团队交付。

- 优化 managed Team onboarding：完整目标传递、Captain identity、成员角色/Skills/模型选择和首批任务创建。
- 补齐 Workbench 的任务/成员可读性、设置校验、空态、错误、stale/reconnect 和键盘/屏幕阅读器行为。
- 保持 browser 主要为 read/navigation Consumer；用户修改 Team 先通过正确 Captain Chat 完成。
- 对真正需要 direct control 的少量操作，逐项建立 verified human principal、idempotency、authoritative read-back 和 unknown-outcome handling；未通过的操作保持 unavailable。

出口：fresh Profile/browser 中完成双 Team 代表场景；无可见 Chat/console/page error；UI 与工具读回相符。

### C. 强化恢复与运行边界

目标：失败不会制造“看起来完成”的 Team。

- 覆盖 Storage Domain 重启/写失败、Session 恢复、mailbox crash window、attempt stale/retention、budget carry/exhaustion、workflow cancellation 和 execution-root residue。
- 验证 tool policy、Skill allow-list、Captain/member model route 在 restart 后仍按声明生效。
- 验证 unload/reload/HMR 的 admission → drain → dispose 顺序；所有 route/listener/timer/waiter/subagent 有明确 owner。
- 记录 local/process-scoped 能力上限；不把本地 mutex、Storage Domain 或 workspace hint 描述为 distributed safety。

出口：代表性 fault matrix 全绿；每个 unknown outcome 有 stop/read-back/reconcile 路径；资源清理可读回。

### D. 打包、兼容与候选验收

目标：把仓库能力变成可安全安装和回退的产品候选。

- 从冻结 commit 构建一次 tarball，记录 digest，并在 fresh isolated `DSH_HOME` 安装。
- 验证 `plugin add`、默认启用、Settings、`--dump-config`、禁用、reload、upgrade、rollback、remove 和缺依赖 fail-closed。
- 运行 candidate gate、官方/reference compatibility gate（仅在触发时）、真实 Profile/browser E2E 和风险对应的非作者审查。
- 同步 README、产品/协议/验证文档和已知限制；保持 `private: true`，直到公共发布另获授权并有发布身份。

出口：同一 immutable candidate 的 package、Profile、browser、restart 和 cleanup 证据一致；集成到预期 target 后读回。

## 4. 90% 之后

这些是独立 feature pipeline，不阻塞核心产品就绪：

- Canvas-native read/write Consumer；
- remote member Provider 与跨主机 workspace；
- distributed CAS/lease/fencing/change feed；
- accepted evidence 驱动、需要人工批准的 Skill Evolution；
- 公共 npm/marketplace 发布与长期兼容承诺。

## 5. 每个切片的完成合同

每个独立能力使用最小纵切：

```text
用户结果
  → 明确 owner / non-goal / acceptance
  → 最小实现与受影响检查
  → immutable candidate
  → 真实边界 smoke（需要时）
  → 风险对应 review
  → 串行集成与 target read-back
```

- 一个失败只阻断依赖它的能力；read path 不等待无关 privileged write。
- accepted candidate 未集成时，先处理 integration debt，不拉取依赖功能。
- 计划、文档、开放端口、agent 活动或 mock success 不等于交付。
- 官方 API、reference pin 或目标 Profile 发生决策性变化时才重跑兼容 Gate A；否则复用未变化 receipt。
- 仓库 writer 只能通过 `pnpm isolation open|status|close|reconcile`；产品 execution root 不授予开发 worktree 权限。

## 6. 验证入口

```bash
pnpm test -- <affected-test>
pnpm verify:isolation:status
pnpm verify:candidate
pnpm verify:policy          # 本路线或其他登记权威变化
pnpm verify:compatibility   # 官方/reference 事实参与当前决策
```

详细场景和 claim ceiling 见 [08-testing-verification.md](08-testing-verification.md)。
