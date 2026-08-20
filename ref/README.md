# Reference sources

本项目在 `ref/` 中固定两个源码参考，二者用途不同，不能互相替代：

- `dsh-agent-teams/source/`：DSH Bundle、continuable member、任务 DAG、attempt fencing、持久邮箱、事件驱动 Scheduler 和 Host/Client 插件的直接实现参考。
- `jiuwenswarm/source/`：SwarmFlow、Worktree、预算、Team Memory、Skill Evolution、工具权限和 Distributed Team 的产品与故障模型参考。

两份源码都是只读证据，不是本插件的依赖。DSH API 仍以目标安装版本和官方 `deepseek-ai/deepseek-harness` 源码为准；不得把 JiuwenSwarm 的 Python Runtime 或类型直接嵌入 DSH capability contract。

每个目录的 `SOURCE_POINTER.json` 记录固定 commit，`sync-reference.ps1` / `sync-reference.sh` 可重建完整 checkout。`dsh-agent-teams/source-snapshot/` 仅是离线关键契约快照，不能代替完整仓库。

JiuwenSwarm 上游在固定 commit 中包含 Git LFS 视频；当前上游部分媒体对象可能返回 404。同步脚本默认跳过 LFS smudge，因为插件设计取证只需要源码和文档文本。
