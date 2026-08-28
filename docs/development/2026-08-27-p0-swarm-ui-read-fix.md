# Dogfood 缺陷登记：SWARM_UI_READ_FAILED（Team 面板读取失败）

- 缺陷标识：SWARM_UI_READ_FAILED（P0，dogfood）
- 责任 lane：`p0-swarm-ui-read-v2`（owner terra-p0，分支 `codex/p0-swarm-ui-read-v2`）
- 修复候选 commit：`a29173ddf35475c13f0265a2a9b9dd6850246628`（未 push）
- 复现环境：控制面 `DSH_HOME=C:\Users\windo\.dsh-swarm-dev`，Web GUI `http://127.0.0.1:3180`，插件为同版本本仓库构建（main @ e406861）

## 现象

DSH Web GUI 顶部“团队”图标可打开右侧原生 Team 面板，但概览始终显示“团队状态暂不可用 / SWARM_UI_READ_FAILED”；刷新与重试均无效；浏览器 console error/warn 为 0；而后端 Team 真实存活（Captain 会话在 Team 内、成员与任务在运行）。即 UI read 通路失败但错误被吞成笼统文案。

## 复现（根因链，引用 Team memory-4/5 的 qa-oracle 定稿）

1. 宿主 `/swarm/v1` 读 RPC 全链路健康（capabilities/binding/snapshot/page 直连均 200 + 合法 envelope；后端失败本会以 typed `DashboardReadError` 代码呈现）。
2. 宿主投影对成员 role **逐字透传、不截断**（`src/host/host-read-service.ts:231` `role: member.role`）。真实成员 role 长度：roster[0]=391、roster[1]=308、roster[3]=272（均 >256）。
3. 客户端冻结 schema `rosterRow.role = boundedString(256)`（`src/rpc/read-rpc-artifact.ts:79`，maxLength=256）。客户端 `assertSwarmReadRpcValue('snapshot', v)` 校验 live snapshot 时因 `$.roster[0].role` 超上限抛**裸 Error**（非 typed `DashboardReadError`）。
4. 裸 Error 走 controller 非 typed 路由 → `normalizeError` fallback（`src/client/team-dashboard-controller.ts:350-354`）→ 折叠成笼统 `SWARM_UI_READ_FAILED`。
5. UI `TeamDashboardContent.tsx:56` 只显示 `error.code`，真实 `error.message` 仅进 `title` tooltip。网页 DOM `title` 原文恰为 `$.roster[0].role is too long`，与复现完全一致。

## 责任边界

属**读取侧消费者 schema 过严 + 契约/投影边界不一致**，非写入侧数据损坏：

- 写入/权威侧（Team 状态机 + storage）把成员 role 当作任意长度自由文本——真实成员职责描述本就 >256 合理；
- 读侧冻结 schema 却按 256 上限收紧，二者在 read-RPC 消费者边界冲突。
- `SWARM_READ_RPC_CONTRACT_DIGEST_V1` 由 `canonicalSwarmReadRpcJson({contract, fixtures})` 独立可复现校验（`tests/read-rpc-client.spec.ts:34-39`），src 内无二次校验点。

## 修复

约束：不得删除/截断真实 role；不得放宽到无限/无界；不改官方 DSH 源码；不建第二套状态机。

1. **契约一致（role 上限有界提升 + 同步 digest）**：`src/rpc/read-rpc-artifact.ts` 新增 `ROSTER_ROLE_MAX_LENGTH = 2048`，`rosterRow.role = boundedString(ROSTER_ROLE_MAX_LENGTH)`；`SWARM_READ_RPC_CONTRACT_DIGEST_V1` 更新为 `caa66390ea754b9c28575314b418d8ea71468fb7e04557c864926371d1340abf`（临时 spec 重算确认，覆盖 391/308/272 且仍有界）。
2. **UI 不吞错（显式真实 error.message/code）**：`src/client/TeamDashboardContent.tsx` `Status` 将真实 `error.code + error.message` 内联显式展示（nowrap + ellipsis 有界容器，完整值进 `title`），不再只显示 code、把 message 藏进 tooltip。
3. **有界展示（视觉截断、权威值不裁剪）**：`Rows` 对 `secondary`（含成员 role）加 `title` 保存完整值 + `overflow:hidden / textOverflow:ellipsis / whiteSpace:nowrap` 视觉有界；权威 role 数据原样保留。

## 测试（回归矩阵）

| 层面 | 用例 | 断言 |
|---|---|---|
| validator | `read-rpc-client.spec.ts` role 391（>256） | `assertSwarmReadRpcValue('snapshot', …)` not.toThrow 且 role 逐字原样返回 |
| validator | `read-rpc-client.spec.ts` role 2049（>2048） | `assertSwarmReadRpcValue` toThrow（新上限仍有界，>上限 fail loud） |
| controller | `team-dashboard-controller.spec.ts` 长 role roster | 达到 `ready`（不落 `SWARM_UI_READ_FAILED` fallback、`error` undefined、role 未截断） |
| UI | `team-dashboard-ui.spec.tsx` error alert | alert 可见 textContent 同时含 code 与真实 message（非仅 tooltip） |
| UI | `team-dashboard-ui.spec.tsx` 长 role 成员视图 | `small` 的 `title` 等于完整 role；`overflow='hidden'`、`textOverflow='ellipsis'`、`whiteSpace='nowrap'` |

收据：`pnpm test` 74 files / 442 tests exit 0；针对性 spec read-rpc-client 5/5、team-dashboard-controller 9/9、team-dashboard-ui 5/5；`pnpm verify:candidate` EXIT=0（无 NOT_CONFIGURED/FLAKY）；`pnpm verify:isolation:status` PASS（2 allocations）；tarball `.worktree\p0-swarm-ui-read-v2\dsh-agent-swarm-0.1.0.tgz`（SHA256 `CECB426E145AF422D3A9B893FA599D754071EFC830402CADB5AB406F675BA9E7`）。
