# Official-first 开发

插件只通过官方 DSH 的公开扩展面工作。官方 DSH 服务和 Session log 始终是运行与会话权威。

## 固定基线

- 官方源码基线由 `docs/OFFICIAL_BASELINE.json` 固定。
- 当前审计基线包含官方 DSH commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。
- 实际 API 以本仓库安装的 `@deepseek-ai/*` 包、类型声明和公开测试为准。
- `ref/` 只读，只能通过仓库提供的同步脚本刷新。

## 允许的扩展面

- Plugin 注入和 disposer；
- Provider、Consumer、tool、event；
- storage form 与 Bundle composition；
- 官方公开客户端组件、设置扩展和主机上下文。

禁止私有路径导入、猴子补丁、复制官方状态机或直接改 Agent Loop。

## 修改流程

1. 在已安装包和公开类型中确认 seam，而不是凭记忆猜接口。
2. 在 `src/host/` 隔离官方适配，核心领域与用例不感知主机细节。
3. 为注册动作提供明确生命周期所有者和 disposer。
4. 权威提交后再发布投影；模型可见状态必须能由 Session log 和插件存储重建。
5. 官方基线、包版本或 seam 变化时运行 `pnpm verify:compatibility`。
6. 参考项目重新固定版本时，在手动 Gate C 运行 `pnpm verify:anchors`，逐项处理缺失文件、越界行号和上下文标识符不匹配诊断。该检查覆盖两个参考仓库的简单 `path:line` 引用；当前文档未使用此类引用时，零命中只表示没有可检查的行号锚点，不代表完整的语义验证。

## 包与客户端边界

根导出提供插件配置、注入和服务 API；`./client` 只提供浏览器安全的 UI 入口。客户端不得导入 Node、文件系统、进程或服务端密钥能力。

## 兼容性结论

类型检查、模拟测试或静态源码审计只能证明对应层级。只有冻结包在全新官方 Profile 中加载并完成真实浏览器交互，才可声称该路径与当前官方基线兼容。
