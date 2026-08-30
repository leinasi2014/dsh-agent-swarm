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

## 清理

测试结束必须说明并处置候选服务、临时 Profile、浏览器标签和临时工件。稳定 Profile、用户会话、凭据和其他工作区不得被测试清理触碰。

历史上唯一保留的恢复记录是 `docs/development/2026-08-23-worktree-cleanup-ledger.md`；它是不可变证据，不接收滚动状态更新。
