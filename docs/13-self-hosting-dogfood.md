# 自托管 Dogfood 与发布

Dogfood 验证的是用户真实安装路径，不是开发工作区能否启动。

## 四个分离的权威

1. **稳定控制 Profile（stable control Profile）**：保存已接受版本，用于观察和回滚。
2. **不可变候选包**：绑定 Git commit、tarball 绝对路径、字节数和 SHA-256。
3. **验收 Profile（acceptance Profile）**：全新 `DSH_HOME`，只安装该候选，不复制旧 Session、Team、凭据或插件私有状态。
4. **GitHub `main`**：CI 通过且验收后才成为集成权威。

候选不能自我晋升（candidate cannot promote itself）。作者不能以自己的本地结果替代独立验收；文档也不能授权凭据、网络、推送、发布或破坏性清理。

## 最小闭环

1. 从干净提交构建 tarball 并记录身份。
2. 在全新 Profile 安装，启动官方 DSH，不复用旧 Team 状态。
3. 在真实浏览器完成 Main Brain → Captain → Team → 成员 → 任务 → review 的用户路径。
4. 验证设置页、Skill catalog、成员详情、Captain Chat、多 Team 切换和窄侧栏。
5. 检查控制台、服务日志、重启恢复和卸载。
6. 发现缺陷后创建 GitHub Issue；通过修复 PR、CI、新候选重装再次验证。
7. 验收失败则保持稳定版本；验收通过才合并或发布，并保留可执行回滚路径。

## 候选进程的 Windows 权限边界

`scripts/promotion/windows-candidate.mjs` 是独立的实验性进程边界，尚未接入 `freeze`、`accept`。现有命令的环境变量隔离不能作为候选无法改写稳定状态的 OS 权限证明。

该原型复用官方 `@deepseek-ai/dsh-win32-process` 的进程与 Job API、`@deepseek-ai/dsh-sandbox-windows-acl` 的可撤销目录授权，并通过公开的 Win32 扩展 API 创建完整受限 token。`WRITE_RESTRICTED` 不足以覆盖删除权限，因此不能作为此流程的安全边界。写入和读取授权只作用于新建的私有候选根目录，既有用户目录 ACL 保持不变；取消前缀进程时，其 Job 必须清除子孙进程，随后才撤销授权和清理候选目录。

正式接入前还需完成私有 Git/CLI 工具链暂存及 Node 子进程命名管道的权限处理。Windows 命名管道不沿用此 token 的默认 DACL，普通 `stdio: 'pipe'` 子进程尚不可用；已验证的继承标准流路径不能替代完整 `freeze`、`accept` 安装及运行路径的验收，也不得通过把当前用户 SID 加回限制列表来放宽边界。

## 清理

测试结束必须说明并处置候选服务、临时 Profile、浏览器标签和临时工件。稳定 Profile、用户会话、凭据和其他工作区不得被测试清理触碰。

历史上唯一保留的恢复记录是 `docs/development/2026-08-23-worktree-cleanup-ledger.md`；它是不可变证据，不接收滚动状态更新。
