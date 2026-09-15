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

Windows 的 `freeze`、`accept-check` 要求显式传入 `--candidate-account-root`。控制器通过 `candidate-session.mjs` 读取独立账户配置；未准备、目录权限不合格、CLI 入口与已批准安装不一致时拒绝运行，不回退到控制器身份。

账户由用户以同一控制器身份提升后执行 `windows-candidate-account.ps1 -Mode Prepare` 创建。脚本只配置新的私有凭据根和盘根下的 `dsh-candidate-runtime`：工具目录对候选只读，运行状态目录可写，输出目录只允许写既有文件。既有用户目录、Profile 和系统 ACL 不被修改。凭据以该控制器用户的 DPAPI 保存；控制器校验 owner/DACL 后通过私有管道短暂读取并清零缓冲。不要在终端直接执行不带 `-InspectOnly` 的 credential helper。

执行前只读检查实际控制器数据、源码、Git common-dir 和脚本路径的权限及父链，拒绝非受信任主体的写入、删除、目录替换或 DACL/owner 修改授权。工具链复制会重定位安装内部 junction，拒绝指向原安装之外的链接；验收证据与 ledger 始终由控制器在原 drills 域写入。候选拥有独立 Git 数据目录，不能通过 linked worktree 文件到达控制器 Git common-dir。

原生进程复用官方 `@deepseek-ai/dsh-win32-process` 的暂停创建、Job 分配、恢复和 Job 收敛 API；`CreateProcessWithLogonW` 负责独立普通账户登录。候选启动器自行打开输出文件并建立 Node 子进程管道，标准流不继承控制器句柄。Profile patch 由候选身份写入；控制器复制 tarball 时校验已打开句柄的最终路径并拒绝硬链接。

账户准备与静态/fixture 检查不证明跨账户原生启动成功。首次使用仍须实际验证 SID、普通 Node 子孙管道、Job 取消、protected-root 拒绝、完整 `freeze`/`accept-check` 及清理；Windows 桌面访问、profile 初始化和创建至 Job 分配之间的宿主中断窗口仍依赖现场证据。历史完整受限 token 原型保留用于诊断，`WRITE_RESTRICTED` 和旧的继承标准流证明不能替代该账户路径的验收。

## 清理

测试结束必须说明并处置候选服务、临时 Profile、浏览器标签和临时工件。稳定 Profile、用户会话、凭据和其他工作区不得被测试清理触碰。

历史上唯一保留的恢复记录是 `docs/development/2026-08-23-worktree-cleanup-ledger.md`；它是不可变证据，不接收滚动状态更新。
