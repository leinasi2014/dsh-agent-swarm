# 01. DSH 插件与源码分层原则

本项目扩展 DeepSeek Harness，不复制 Harness。官方 DSH 继续拥有 Profile、Session、Agent Loop、模型调用、工具执行、Workspace、设置和客户端外壳；插件只在公开 Provider、Consumer、事件、Storage Domain、RPC 和 UI slot 上组合 Team 能力。

## 1. 单一权威

- Session 日志是模型对话与工具历史的权威。
- `TeamDomainPort` 是 Team roster、任务 DAG、attempt、邮箱、预算、公共目标和公告的唯一写入口。
- 官方 Storage Domain 保存 durable Team aggregate；进程内 Map、UI state、浏览器缓存和 transcript 解析都不是业务权威。
- 状态先持久提交，再发布事件、receipt、RPC 结果或 UI 更新。
- Main Brain、Captain、Member、human principal、Team、Session、revision 和 attempt 是不同身份，不能互相替代。

## 2. 目录与职责

```text
src/
  index.ts                 稳定插件入口，只导出 manifest、Config、apply、public API
  plugin/
    config.ts              用户配置 schema、默认值和组合预检
    apply.ts               DSH composition root 与 disposer 装配
  domain/                  纯 Team 业务规则、状态、错误、revision/attempt 围栏
  runtime/                 调度、成员、审查、权限、预算、恢复、Workflow/Jobs policy
  storage/                 Team/overlay/private-memory 的 Storage Domain adapter
  tools/                   26 个模型工具 Consumer，按 lifecycle/task/mail/read/memory 分组
  human/                   Captain liaison、human control、question/review adapter
  host/                    Host service 与 producer/read assembly
  rpc/                     /swarm/v1 有界读合同、artifact 和 service
  client/                  DSH-native Team Workbench、设置卡和本地化
  patterns/                将外部编排概念编译为原生 Team DAG 的纯函数
  migration/               旧存储迁移；不参与正常运行
  public-api.ts            稳定可导出类型与 Provider seam
```

`src/index.ts` 必须保持薄入口；配置只在 `plugin/config.ts` 定义一次；工具注册只从 `tools/index.ts` 汇总。大型文件按真实职责拆分，不为目录美观引入第二状态机或兼容 wrapper。

## 3. 允许的依赖方向

```text
index → plugin/apply
plugin/apply → tools | human | host | rpc | runtime | storage
tools | human | host | rpc | storage → runtime/domain contracts
runtime → domain contracts + official DSH services
storage → domain contracts + official Storage Domain
client → frozen RPC/read contracts + official client UI packages
domain → framework-neutral types and validation
```

- `domain/` 不依赖 client、RPC、Host 或具体存储实现。
- `client/` 不导入 Runtime、Store 或 DSH 私有实现，也不写 Team 状态。
- `tools/` 不直接改 aggregate；它们校验 caller 后调用 Runtime/Domain port。
- `runtime/` 不通过 DOM、transcript 或本地文件推断 Team truth。
- official/reference checkout 只提供固定版本证据，不进入发布包和运行依赖。

## 4. 生命周期

每个 register、provide、listener、timer、waiter、route、Storage Domain、subagent 和 execution root 都必须有 owner 与 disposer。启动顺序遵循：配置预检 → durable domain → runtime → private overlays → tools/Host/RPC/UI contributions；卸载按相反顺序停止 admission、drain、dispose、close。

任何启动失败都必须收敛为零半挂载面：不留下已发布服务、监听器、route、活跃成员或写权限。未知结果先停止写入并从权威读回，不能靠重试猜测。

## 5. 扩展选择

新增能力按顺序选择：复用官方 seam → 注册可替换 Provider → 添加只读 Consumer/projection → 扩展插件自有 domain。只有官方 seam 确实缺失且证据充分时才提出上游需求；不得直接修改 Agent Loop 或官方 UI 私有状态。

同一决定只存在于一个登记权威。新实现更新现有协议、能力、测试或路线文档，不再新增同题 ADR、阶段报告和审查报告。
