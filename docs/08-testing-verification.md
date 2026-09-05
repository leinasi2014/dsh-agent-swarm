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

## 当前候选的 managed-Team 证明

`verify:candidate` 在工程门通过后，使用同一个 `verify:p0-evidence --candidate` 入口消费外部控制者冻结的产品证据。原 `p0:profile-proof` 的 schema 1、DEV_SMOKE 和 R2/R3 兼容性收据继续保留，不能替代 schema 2 的真实模型 managed-Team 路径。fixture gate 只证明消费者能接受/拒绝指定形态，不证明产品已经运行。

控制者在候选之外保存 proof root 与 `controller-expected.json`，并独立固定 expected 文件 SHA256。不可从待验 manifest 推导 expected 身份，也没有生成 PASS 骨架或自动晋升命令：

```powershell
node scripts/verify-p0-profile-proof.mjs --candidate --root <proof-root> --expected <controller-expected.json> --expected-sha256 <controller-pinned-sha256> --candidate-repo <candidate-checkout>
```

省略 `--candidate-repo` 时核对当前目录的实际 Git HEAD/tree。前三个配置亦可用 `P0_PROOF_ROOT`、`P0_EXPECTED`、`P0_EXPECTED_SHA256` 传入。只有三项全部未提供才输出 `NOT_CONFIGURED` 并允许工程检查完成；空白、部分配置、文件缺失、坏 JSON 或任一身份不匹配均失败，不回落到 fixture 或 skip。`NOT_CONFIGURED` 不是产品 PASS，不能据此关闭需要真实产品证明的 Issue。

expected JSON 必须包含 `proofKind: "managed-team"`、`candidateCommit`、`candidateTree`、`artifact: {sha256, bytes}`、`official: {commit, tree, version}`、`profile: {dshHome, provider, model, profileName}`、`manifestSha256`。四个 Profile 字段必须非空且逐字匹配，`dshHome` 为绝对路径。manifest 位于 `evidence/manifest.json`，使用 `schemaVersion: 2`、`proofKind: "managed-team"`、`status: "pass"`、`provenance: "controller-observed-live"`，并保留 P0 的 candidate、完整 tarball artifact、official 前后 clean 身份和 evidenceFiles 的相对路径/字节/SHA256。状态字符串本身不提供信任；独立控制者的 digest、规范来源读回与非作者复核才是信任来源。

`managed` 固定包含 Main Brain/Captain Session ID、至少两个 member Session ID、`sessionsBefore`/`sessionsAfter` 文件引用与下列六个 `phases`。每阶段 `team` 引用实际 Storage Domain Team 的白名单投影：schemaVersion/id/revision/name/captainSessionId/managedOrigin/phase/captainProfile/members/tasks/attempts。成员保留 name/sessionId/provider/phase 和已存在的四个身份属性；任务保留 id/revision/status/ownerSessionId/currentAttemptId；attempt 保留 id/taskId/generation/memberSessionId/phase。只取实际已存在字段，不补造值。

| 阶段 | 必需规范证据 |
| --- | --- |
| creation | `team`、Main Brain 的 `call`、`userMessageSeq`；真实用户消息先于模型的 create_managed，结果精确关联独立 Captain 与 managedOrigin |
| profile | `team`、Captain 的 `call`；set_captain_profile 四项身份属性与存储吻合，返回 revision 精确为 expected+1，稍后读回 revision 可以增加 |
| members | `team`、`calls`；每个成员具有实际 add_member 成功回执、独立 Session、正确 Captain parentSession |
| review | `team`、对应的 `submissions`/`reviews`；每名成员实际提交，Captain 精确接受同 task/attempt/revision；异构来自各成员提交前的实际 request/header 模型，至少两个不同 model |
| ui | `team`、`observation`；内置浏览器固定同 Team，刷新前 revision 对应 members 采样，刷新后对应当前 Team；见下方可见字段投影 |
| restart | `team`、`reopenedTeam`、新 `submissions`/`reviews`、`process: {beforePid, afterPid, stoppedAt, startedAt}`；重启前后 PID 不同，重开状态等于 UI 阶段规范状态，四类 Session header 与已导出事件前缀不变，随后产生新的执行与接受 attempt |

Session 白名单保留原 header 的 version/id/createdAt/parentSession/origin/seedLength/agentPreset，以及原 event 的 type/seq/time。request/header 仅保留 data.header.config 的 provider/model；user/message 仅保留 source.kind 与原内容的 contentSha256；turn/start 保留 turn，turn/end 保留 turn 与 reason.kind。禁止导出 request/context、system/tools、隐藏推理、原始代码或凭据。

Native tool/call 保留 turn/step/callId/name，arguments 为原 JSON 解析后选出的固定参数字段；tool/result 从 canonical message.source 和 tool-result block 投影 turn/step/callId/isError/text。PTC 必须保留原 tool/code-dispatch-start 与 tool/code-dispatch 的 rootCallId/parentCallId/subCallId/name/arguments，后者另含 isError 和实际公开 text content；父 run_code 的原 call/result 仍保留，代码参数省略，父结果只导出 textSha256。消费者核对唯一配对、父调用包围、实际 turn、成功结果及 lineage。Native 引用为 `{sessionId, callSeq, resultSeq, turn, callId}`；PTC 引用以 rootCallId/parentCallId/subCallId 代替 callId。禁止把 PTC 子调用改写为 native 事件。

UI observation 为 `{source: "in-app-browser", teamId, beforeRevision, afterRevision, captainProfile, members, tasks, screenshot}`。仅对照实际可见字段：Captain 的 displayName/profession；成员卡片 name/displayName 和逐一打开详情的 provider/model；任务 id/status（从可见本地化状态映射枚举）。Session ID、attempt generation 等隐藏字段由 Team/Session 证据验证，不假装 DOM 显示。截图是已声明 hash/bytes 的 PNG，仅支持 UI 结论，不能单独证明任何阶段。

CI 默认 PR checkout 仍是 synthetic merge；不能拿 head 收据证明 merge。手动 workflow_dispatch 可提供控制者的 HTTPS proof ZIP URL、ZIP SHA256、expected JSON SHA256，以及可选已接受 verifier 的完整 commit。ZIP 根含 artifact/、evidence/、controller-expected.json；下载失败或错 digest 必须失败。未提供 accepted verifier 时另报独立接纳 `NOT_CONFIGURED`，候选消费结果不称为独立验收；提供时必须不同于候选，加载该版本的既有入口，失败不能改用候选自验。

修改 verifier 的首个候选由已接受 base 能执行的工程/治理检查和非作者语义评审共同接纳，明确旧 schema 的能力边界；完成 expected-target 合入与读回后才能将新 verifier 激活为后续独立验收基线。候选不能选择自己的身份或 manifest 为信任根，不能自行接纳或晋升。

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
