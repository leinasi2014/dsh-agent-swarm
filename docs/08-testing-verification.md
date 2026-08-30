# 测试与验收

本文件定义唯一的测试分层与产品验收口径。测试数量、日志和截图不能替代可执行产品路径。

## 证据层级

1. **单元测试**：纯函数、领域约束、序列化和错误映射。
2. **契约测试**：工具 schema、Provider/Consumer、RPC、存储表单和官方公开类型。
3. **组合测试**：插件注入、26 个工具注册、生命周期 disposer、权限投影。
4. **恢复测试**：同一 Team 在进程重启后可由 Session log 与插件存储重建。
5. **包测试**：从冻结 tarball 在全新 Profile 安装、加载、禁用与卸载。
6. **真实 Profile/浏览器测试**：用户可见页面完成真实点击、导航、输入和断言。

后一层可以支撑更高结论，但不能反向替代前一层。服务启动日志不是浏览器 E2E，静态截图不是交互验收。

## 3. 回归场景索引

以下编号是测试名称与文档之间的稳定索引，不是旧里程碑或实时进度。

1. 同一 revision 的并发 claim 只能有一个赢家。
2. 旧成员运行期间 reassign，旧 attempt 必须失效。
3. 大量迟到或伪造 attempt 更新不能改变状态。
4. mailbox 持久化后的投递失败可恢复。
5. inbox 已接收但 ack 前崩溃仍保持 exactly-once 可见性。
6. spawn 成功但 Team commit 失败必须对账并收敛。
7. 移除持有工作成员时保持任务与 ownership 一致。
8. DAG 拒绝自依赖、重复依赖、缺失依赖和环。
9. 插件 disposal 会排空已准入操作并拒绝新操作。
10. claimed、in-progress、submitted 和 verifying 在重启后恢复。
11. bytes、tasks、members 和 tokens 的边界精确生效。
12. 多字节消息在 byte limit 上按字节裁决。
13. review reject 后使用新 attempt 重试。
14. execution root 清理失败保留可诊断状态。
15. remote reservation 过期并拒绝 late ACK。
16. workspace member 不能伪造 Captain、task 或 budget 权威。
17. mailbox 配额可随 ack 释放且不会永久耗尽。
18. 多轮 reject/reassign 保持 attempt 历史有界并拒绝 stale attempt。
19. 任务和消息中的指令样文本只作为受限数据。
20. 歧义 membership、depth、archive、quiet delivery 与官方语义一致。
21. 并行 coding attempt 获得互相隔离的 execution roots。
22. Worker 不能写稳定制品、控制存储、凭据或官方 checkout。
23. Worker 与候选 Profile 不能修改冻结证据。
24. command failure、review reject 和 human deny 阻止完成与晋升。
25. stale attempt、lease、bootstrap ACK 或竞态 merge 不能晋升候选。
26. 候选加载、reload、recovery 或 teardown 失败时保留稳定 Profile。
27. acceptance Profile 与 stable control Profile 隔离。
28. promotion 与 rollback 记录 commit、digest、Profile 和 evidence identity。
29. retry、recursion、concurrency 和 retention 上限可约束故障。
30. dogfood 缺陷进入 fenced Issue/任务而不是直接改权威状态。
31. workflow 与 late direct-driver 并发时由 ownership fencing 隔离。
32. orchestration mode 明确决定唯一调度者并抑制越权自愈。
33. phase、parallel、pipeline、nested 和 human 节点编译到同一 Task DAG。
34. usage settlement 在 provisioning、closing、reload 和乱序下 exactly-once 折叠。
35. 缺陷或损坏候选被拒绝且不影响稳定控制面。
36. promotion 有 generation fencing，失败探针触发有界 rollback。
37. retry 成本持续计入同一 Team budget ledger。
38. reservation 不足时延后 claim，释放后恢复并跨重启保留。
39. budget exhaustion 挂起工作而不制造 stranded retry，恢复预算后续跑。
40. member 问题经 root Captain 和官方 question Provider 双向持久路由。
41. member 不能直接向 human 提问，Provider 缺失时 fail closed。
42. duplicate、late、expired 和 cancelled control 不能修改新 attempt。
43. typed control 在变更前检查 Team、task 和 attempt fences。
44. free text、伪造 caller、非法 payload 和虚假 human principal 不能授权 control。
45. scoped request identity、outcome-unknown quarantine 和 disposal 保持幂等。
46. Team v2 聚合升级与跨重启 relay effect 使用持久 receipt 对账。
47. receipt read face 提供有界、隔离、不可篡改的 cursor snapshot。
48. Host read service 仅从精确 live root Agent 派生 Team authority。
49. 多个 workflow run 共享一个持久 Team budget ledger。

Scenario audit: implemented = 1-9, 11, 12, 16-21, 27, 28, 31-45, 47-49; not yet proven = 10, 13-15, 22-26, 29, 30, 46.

产品级核心路径还必须证明：Main Brain 创建至少两个独立 Team；每个 Team 有独立 Captain Session；成员身份、Skill catalog、任务 review、重启恢复、窄侧栏和全新 Profile 安装均通过真实浏览器交互。

## 4. 执行顺序

日常修改先跑最小受影响测试。冻结工程候选前依次运行：

```powershell
pnpm verify:isolation:status
pnpm verify:policy
pnpm verify:structure
pnpm verify:candidate
```

只有官方 DSH 或参考兼容性参与本次决策时才运行 `pnpm verify:compatibility`；输入未变化时复用已接受回执。

## 浏览器验收

每条浏览器用例必须包含：

1. 明确的全新 Profile 与插件包身份；
2. 用户可执行的导航与交互；
3. DOM/可见文本/状态变化断言；
4. 控制台错误与服务错误检查；
5. 结束后的服务、Profile 和临时工件处置说明。

## Issue 关闭标准

Issue 只有在修复已进入 GitHub `main`，CI 通过，且达到该 Issue 声明的最高证据层级后才能关闭。重复 Issue 可以注明主 Issue 后关闭；部分完成、只有草稿或只有本地验证的 Issue 保持开启。
