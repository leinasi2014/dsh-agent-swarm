# 功能覆盖与缺口

本文件是架构、后端与 UI 的单一对齐表，不记录滚动状态，也不创建另一套里程碑。

## 当前覆盖

| 能力 | 现状 | 权威实现 |
| --- | --- | --- |
| Main Brain → 独立 Captain → Team | 已实现核心关系 | `src/runtime/`、`src/domain/` |
| 多 Team 独立存在 | 已实现存储与读取 | `src/storage/`、`src/rpc/` |
| Team 创建、成员、任务、review | 已实现核心协议 | `src/tools/index.ts`、`src/runtime/` |
| 26 个 Team 工具 | 已注册 | `src/tools/index.ts` |
| 私有记忆与共享记忆 | 已实现基础能力 | `src/runtime/member-private-memory-service.ts`、`src/storage/` |
| Team 工作台与 Captain Chat | 已实现主要 UI | `src/client/` |
| 插件设置与 Team Skill allowlist | 已实现基础 UI/服务 | `src/client/settings/`、`src/runtime/` |
| 身份档案与像素 SVG 头像 | 已实现基础投影 | `src/domain/`、`src/client/` |
| 任务执行根隔离 | 已实现本地边界 | `src/runtime/workflow/` |

## 未完成或未达产品级

| 缺口 | 影响 | 跟踪 |
| --- | --- | --- |
| 非法 LLM 路由在 spawn 后才失败并污染花名册 | Team 无法可靠启动 | Issue #176 |
| Captain Profile 修改后的运行时刷新 | 配置与运行态可能不一致 | Issue #175 |
| 成员职业/简介/工具中文展示不完整 | 详情页语义错误或难用 | Issue #149 |
| 头像生成的误失败提示 | 身份创建体验不可靠 | Issue #145 |
| 官方 Composer 双按钮 | 主聊天交互重复 | Issue #159，上游边界 |
| Skill Evolution 自动提案、验证、发布与回滚 | 成长闭环未完成 | 产品路线 |
| 远程执行根与分布式调度 | 仅本地可用 | 未来能力 |
| Canvas 工作区专用能力 | 不属于当前核心插件 | 不采用 |

## 所有权

- `src/plugin/`：插件配置与装配根。
- `src/domain/`：稳定领域对象和不变量。
- `src/runtime/`：用例、调度、权限、生命周期。
- `src/storage/`：插件自有持久化表单。
- `src/rpc/`：读模型和窄写入入口。
- `src/tools/`：模型可调用工具注册。
- `src/client/`：设置、工作台、Captain Chat 与成员详情。
- `src/host/`：官方 DSH 主机适配。

依赖只允许从装配层指向用例与适配器；领域层不得依赖 UI、RPC 或官方私有实现。

## 明确不采用

- 不创建第二个 Agent Loop、第二套 Team 状态机或替代 Session log 的权威。
- 不把 Canvas、JobRegistry 或共享 CSS 变成插件核心权威。
- 不通过修改官方 DSH 源码修复插件问题。
- 不用新增 ADR、验收包装器或阶段报告替代产品实现。

## 达到 90% 产品就绪的优先顺序

1. 修复路由预检与失败成员原子回滚，恢复 Team 启动可靠性。
2. 完成 Captain 独立会话、成员详情、设置 Skill catalog 的真实 Profile 验收。
3. 补齐重启恢复、多 Team 并行和任务 review/reassign 浏览器回归。
4. 完成 Skill 成长闭环的最小可用版本。
5. 冻结包、CI、全新安装、回滚和 GitHub 发布说明全部通过。
