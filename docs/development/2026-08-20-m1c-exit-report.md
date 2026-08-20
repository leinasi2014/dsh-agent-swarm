# M1C exit report — lifecycle, coordination and input hardening

- Report: 2026-08-20（M1C 收尾，由项目管理工程师执行）
- Milestone: M1C（docs/07），前置 M1B exit 报告 `2026-08-20-m1b-exit-report.md`
- Verdict: **M1C complete** — issues #12/#13/#14/#15/#19 全部关闭 + CI 稳定化（PR #33）；M1D 未开始

## 1. Exit criteria 核验（docs/07 M1C）

| 要求 | 证据 |
|---|---|
| F4 有界卸载 + 诊断 | `disposalTimeoutMs=5000`（官方同名同值）、`src/runtime/disposal.ts` boundedSettle（败者 rejection 全观察）、场景 9 挂起注入测试（红→绿：无界 10019ms → 有界失败） |
| F7 usage 部分（写合并） | `recordSessionUsageBatch` 微批折叠（端口方法），seq 幂等，replay 不双计 |
| F8 定界 + 快照 | `untrustedDataBlock`（fence 自适应反超 payload）、首个模型可见快照套件（结构断言+内联快照）、场景 19 组合测试；权威仍在域检查+toolFilter |
| F10 live-status 调度 + 自愈 | `src/runtime/scheduling.ts`（邮箱优先、running 排除、CAS 守卫回滚、strandedAfterMs 宽限可关）、搁浅证据暴露 + captain 决策路径、3 个新 spec |
| 接受的伴随发现 | F11 歧义 fail-loud、F12 名字终身不可复用（官方对齐，ADR 决策入 docs/04）、F14 归档读写分权、F15 depthLimit 预检、官方兼容组（waitForChange 窗口 10s-1h、quiet 不冷唤醒+inject、keepInbox interrupt 工具、Unicode NFC 名字） |
| 场景审计 | **16/30** machine-proven（+9/16/17/18/19/20 相继转实）；78/78 测试 |

## 2. Remediation diff 清单（M1D 审查员输入，接 M1B 清单）

| 发现/任务 | Issue | PR | 合并提交 | 要点 |
|---|---|---|---|---|
| F4+伴随组（F11/F12/F14/F15+usage 合并） | #13 | #28 | `78c91a8` | disposal.ts、读权限分权、TEAM_MEMBER_NAME_TAKEN、批写 |
| 官方兼容语义组（F13 等） | #19 | #29 | `9021fd6` | wait 窗口、quiet inject、interrupt 工具、Unicode 名字；分歧表 ADR-0002 附录 |
| F10 调度自愈 | #12 | #31 | `c8b06bc` | scheduling.ts 提取、CAS 守卫、stranded 证据 |
| F8 定界+快照 | #14 | #34 | `0c9b46f` | prompts.ts fence、快照套件、场景 19 |
| 模型体验 | #15 | #35 | `f5f5b5a` | noProgress 短路、list_tasks 过滤分页、status 瘦身、输出 schema |
| CI 稳定化（测试竞态） | — | #33 | `666ef03` | #12 spec 的 driveRecoveryPasses 轮询修复（根因：settleCaptain 窗口 vs 迟到 notice；非产品 bug） |
| 治理 | — | #23/#30 | `cbf9f59`/`64ae731` | jiuwenswarm Gate C ×2（累计 diff 审计模式） |
| 复盘固化 | — | #32 | `08159a1` | 教训库 15-19、worktree 规范 §2a、merge-guard |

## 3. 已知限制（M1D 输入）

1. **官方包 `.dsh-mkdir-*` ENOENT flake**（dsh-session-persistence-jsonl 的 Win32 mkdir/rename 竞态）：当日 CI 命中 4 次（含 main 基线复现），重跑即绿。处置：手动重跑；若 M1D 期间频率仍高，升级为上游 issue + CI 级重试策略（决策归 PM）。
2. `src/tools.ts` 594/600 行：顶到护栏，后续扩工具前需先拆分（记入 M2/M9 规划）。
3. 12 个其余工具仍为人类可读渲染（schema 已完整，紧凑渲染属后续清理）。
4. 快路径 noProgress 依赖调用者传当前游标（电平触发契约，已文档化 docs/04 §8e）。

## 4. M1D 交接（下一目标）

- **前置环境依赖（用户侧）**：rc.8 世系 DSH CLI（F16 真实 Profile 装配 + `--dump-config`）。
- 审查输入就绪：原始报告 + intake + 本文件与 M1B exit 的 remediation 清单。
- 审查委派按 docs/12（审查员自主不设限）；通过后 tag 里程碑、宣布 D1 dogfood 开放。
- Gate A 于本报告执行时 PASS（官方 `141eb6f`、双参考 pin 干净）。
