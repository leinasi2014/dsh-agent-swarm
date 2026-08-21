# dsh-agent-teams upstream pin

- Repository: `https://github.com/NanmiCoder/dsh-agent-teams`
- Branch: `main`
- Commit: `0c21e5d2f45ec1ea7c9ee89ffc4ee77d1cb9262e`
- Package version: `0.1.8`
- License: MIT

## Why this is the single local reference repository

它是真实可安装的 DSH 插件，而不是另一套 Agent Runtime。关键价值包括：

1. 当前 Session 作为 Captain，成员是 continuable subagent；
2. 显式任务依赖与自动 ready 判定；
3. `attemptId` 作为执行 capability，转派后陈旧结果被拒绝；
4. mailbox 先持久化、再尝试 live delivery，并有 lease/ack/retry；
5. 成员 `running/idle` 边沿驱动 Scheduler，不依赖常驻轮询；
6. Host、Client、Bundle、构建和真实组合验证都在一个仓库中可观察。

## What must not be copied blindly

- 它把团队协议、状态、Scheduler、工具、Prompt、HTTP 和 UI 集中在一个包中；本项目要拆成 capability family。
- `.agent-teams/team.json` 与进程内锁不提供跨进程事务。
- 成员共用 Captain cwd，没有 Worktree、Remote Worker 或 Merge Gate。
- 模型声称完成与可验证完成之间缺少独立 Review/Verification Gate。
- 上游依赖 rc.6；新开发必须按当前官方 DSH 源码和目标 Profile 的实际 exports 校准。

## Refresh

在 Windows PowerShell 中运行：

```powershell
.\sync-reference.ps1
```

在 Bash 中运行：

```sh
./sync-reference.sh
```

脚本将完整源码检出到 `source/` 并固定到上述提交。更新 pin 时必须同时修改 `SOURCE_POINTER.json`、本文件和 `docs/09-sources.md`，然后重新执行架构差异审查。
