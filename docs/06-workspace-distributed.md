# 06. Workspace、执行根与分布式边界

本文件区分三个经常被混用的概念：用户 Workspace、任务 execution root、远程/分布式运行。它们拥有不同权威和安全含义。

## 1. Workspace

Workspace 由官方 DSH 注册和选择。Team scope 可以引用 Workspace identity/cwd 作为用户项目上下文，但插件不写官方 Workspace 私有状态，也不把页面显示的路径字符串当作授权。

Main Brain、Captain 和 Member 的 Session cwd 仍由官方 DSH 管理。Team aggregate 只保存完成业务恢复所需的有界引用；实际文件访问继续经过官方工具、sandbox 和当前 Session 权限。

## 2. Execution root

Execution root 是一个 attempt 级租约：

- identity 绑定 `teamId + taskId + attemptId`；
- Provider 返回绝对路径、隔离级别和释放句柄；
- assignment frame 与 claim result 声明该绝对路径；
- submit/review/reassign/终止负责释放或转为 residue；
- reload 扫描 marker，区分可重连与需人工回收的残留。

它不等于开发 worktree，也不自动获得仓库 writer 权限。路径声明只指导成员将官方 shell/file 工具的 `workdir` 指向正确根；硬隔离仍取决于 OS/container/sandbox。

## 3. 当前支持边界

当前稳定语义是单机、单 Storage Domain authority、进程内调度 owner 与本地 execution-root Provider。多 Team 可以并发，但所有写入仍由一个 Team aggregate revision 序列化。

以下能力尚未配置或未完成，不得从现有本地实现推断：

- 跨主机 Member Provider 与远程文件同步；
- 分布式 CAS、lease、fencing token 和 change feed；
- 网络分区、leader failover、跨区 durable mailbox；
- 远程 secrets、机器身份和审计日志；
- Canvas 作为 Team 写权威。

## 4. Remote Provider 合同

未来 remote Provider 必须显式声明：

1. provider/model/capability identity；
2. workspace materialization 与 path translation；
3. credential source（只引用 secret name，不回显 secret）；
4. start/ack/heartbeat/interrupt/join/dispose 协议；
5. attempt fencing 与重复请求幂等键；
6. artifact 传输、大小限制、digest 与保留期；
7. 网络失败后的 unknown-outcome read-back；
8. 资源限额、费用与审计归属。

未满足任一项时 capability 必须显示 `NOT_CONFIGURED`，而不是退化成本地成功或猜测远程状态。

## 5. 分布式演进顺序

```text
本地 authoritative aggregate
  → 可替换 remote member Provider
  → remote artifact/workspace contract
  → durable distributed lease + fencing
  → replayable change feed
  → partition/recovery fault matrix
```

每一步都必须保留 TeamDomainPort 的单一 mutation 语义。不得为了远程扩展复制 Team 状态机、让每个节点各写一份 aggregate，或用 last-write-wins 掩盖 revision 冲突。
