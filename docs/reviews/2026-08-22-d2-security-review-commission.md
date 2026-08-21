# D2 开放前置条件 A — 独立安全/架构审查委派书（v1 生效稿）

- 委派人：项目管理工程师（ZCode 会话，受用户全权委托）
- 状态：**生效**（2026-08-22 定稿；基准 = main @ tag `m3` 后 HEAD，PM 定稿时记录）
- 目标：D2 全面开放的对抗性核验（M3 出口报告 §3 前置条件 A；docs/08 §8 场景 37 计划位）
- 立项依据：`docs/development/2026-08-22-m3-exit-report.md` §3、`docs/development/2026-08-21-m3c-acceptance-design.md`（ADR-0008 对照表）、`docs/development/2026-08-22-m3c-drill-report.md`（P0-P7 实证 + OQ 裁决）

## 1. 审查目标与威胁模型

对 D2 并行自托管的**控制面**做对抗性安全/架构复审。被审面（全部在 `scripts/promotion/` + dogfood 四域拓扑 + 已合并的 M3 运行时面）：

1. **晋升/回滚面的完整性**：代际 fencing 的绕过面（并发 promote、伪造 ledger、指针链篡改、quiesce 判据的时序窗口）；P4a/P4b 演练未覆盖的第三形态；
2. **隔离不变量**：候选/验收/稳定三域的边界（路径逃逸、进程逃逸、env 泄漏、验收域的凭据边界——设计声明"验收面只收工件不收凭据"的实证核验）；
3. **执行根与审查根的组合安全**：#100 声明级围栏 + #101 审查根在 D2 并行场景的组合失效面（两根交互、根内命令的逃逸面、泄漏对账的绕过）；
4. **stable 面**：~/.dsh 与运行中稳定 Profile 的接触面枚举（P0-P7 零接触是实证但非穷举——找演练未走的路径）；
5. **台账与证据链**：hash 链的伪造面（tests 已覆盖单元级；审查端到端形态）。

## 2. 审查员与权限事实

- 审查员：独立审查席位（与全部实现会话分离；建议 GLM-5.3 只读席位 + 可选 Codex 席位交叉）
- 权限：只读 + 诊断命令可跑（sandbox 评估类）；**无写入**——报告为最终消息，PM 逐字转录
- **无用户设定的时长/轮次/token 上限**（宪法与 docs/12 §1；PM 不得施加）

## 3. 证据包索引

| 输入 | 路径 |
|---|---|
| M3 出口报告（含 D2 宣言与前置条件） | `docs/development/2026-08-22-m3-exit-report.md` |
| D2 设计注记（含 ADR-0008 对照表 + OQ 裁决） | `docs/development/2026-08-21-m3c-acceptance-design.md` |
| P0-P7 演练报告（九相台账 + 双型失败注入） | `docs/development/2026-08-22-m3c-drill-report.md` |
| 控制面实现 | `scripts/promotion/`（freeze/accept-check/promote/rollback/status/drill/lib） |
| 契约测试 | `tests/promotion-contract.spec.ts` |
| 执行根/审查根实现 | `src/runtime/execution-roots*`、`src/runtime/review/*` |
| ADR-0008 | `docs/adr/0008-self-hosting-dogfood-control-plane.md` |
| 官方基线 | `docs/OFFICIAL_BASELINE.json`（Gate A release 锚定） |

## 4. 严重度标尺与 verdict

沿用既有分级（P0 现实可触发权限丧失/数据损坏；P1 现实可触发高影响；P2 有条件/受控；P3 低影响/流程）。verdict：`D2-OPEN`（无 P0/P1，可全面开放）/ `CONDITIONAL`（附阻断清单，维持受控开放）/ `BLOCKED`。

## 5. 报告路径

`docs/reviews/2026-08-2X-d2-security-review.md`（PM 转录，入库后不可变；intake 单独成文）。前置条件 B（sandbox 硬围栏决定）的输入 = 本审查的执行根隔离发现项。
