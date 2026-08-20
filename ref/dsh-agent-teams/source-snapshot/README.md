# Offline source snapshot

这是 `dsh-agent-teams@0.1.8` 在固定提交上的关键契约快照，不冒充完整 Git checkout。它用于离线阅读：

- `package.json`：Bundle、Client 双面、exports、peer dependency 和验证命令；
- `cordis.patch.yml`：Profile patch 层；
- `src/types.ts`：Task、Member、Message、Team 的持久状态；
- `ARCHITECTURE_MAP.md`：关键源码文件与阅读顺序。

完整仓库由上一级 `sync-reference.ps1` / `sync-reference.sh` 获取到 `source/`。设计或编码前，Agent 必须优先检查完整 checkout 的当前文件，而不是只依赖这个快照。
