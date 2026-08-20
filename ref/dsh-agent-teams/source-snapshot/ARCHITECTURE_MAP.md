# Upstream architecture reading map

按此顺序阅读完整 checkout：

1. `README.md` / `README_ZH.md`：外部能力、边界、安装方式。
2. `package.json` + `cordis.patch.yml`：Bundle、Host/Client 双面与 Profile 组合。
3. `src/types.ts`：持久协议数据。
4. `src/state.ts`：文件持久化、mailbox lease、原子替换、状态校验。
5. `src/members.ts`：continuable child、persona、tool restriction、模型路由快照。
6. `src/scheduler.ts`：idle/status 边沿、ready task、自动重试与 dispatch 回滚。
7. `src/tools.ts`：授权、任务状态机、attempt fencing、消息投递与队长接管。
8. `src/events.ts`：Session event 兼容策略；注意未知事件对回放的影响。
9. `src/index.ts`：Prompt、Command、HTTP 与可选 Web surface。
10. `src/client/`：Conversation/UI 注入与活动面板。
11. `scripts/lifecycle-verify.mjs`、`scripts/stress-verify.mjs`：故障矩阵与恢复验证。

提取设计时必须区分：

- 可复用协议：DAG、attempt fencing、mailbox、durable member；
- DSH 正式契约：`ctx.subagents`、`ctx.tools`、`ctx.agents`、effects；
- 上游实现选择：本地 JSON 文件、单进程锁、全局 Prompt、专用 UI；
- 已知不足：共享 checkout、跨进程一致性、验证门、预算和团队记忆。
