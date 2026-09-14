# 测试与验收

本文件定义唯一的测试分层与产品验收口径。测试数量、日志和截图不能替代可执行产品路径。

## 证据层级

1. **单元测试**：纯函数、领域约束、序列化和错误映射。
2. **契约测试**：工具 schema、Provider/Consumer、RPC、存储表单和官方公开类型。
3. **组合测试**：插件注入、当前工具注册与按角色可见性、生命周期 disposer、权限投影。
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

## 团队效率计量标准

本节是效率采样和优化比较的统一口径；不会自动改变模型、预算、权限、调度或取消策略。通信阶段以 [04-core-protocol.md](04-core-protocol.md#51-通信交互与效率约定) 为准。先证明任务正确完成，再判断是否更快；派工回执、成员唤醒、成果可用和最终审核不能互相替代。

### 样本与时间边界

每个样本固定实例、官方与插件版本／提交、模型 provider/model、reasoning effort、Main/Team/Session、turn 以及存在的 work_request/task/attempt 关联。记录采样时刻、时区、事件 seq 范围、时间精度和来源。完成轮次、进行中轮次与取消轮次分别统计；UI 累计值、单轮值和团队合计不得混用。没有可读字段或边界时标为未知，不用估值补成精确测量。

| 指标 | 口径与边界 |
| --- | --- |
| 单轮 elapsed | 同一时钟域中 `turn/start` 至对应 `turn/end`；进行中只报告已观察时长 |
| 业务请求墙钟时间 | 用户实际提交至首次满足该请求验收条件的可用结果；另列最终审核／收尾时间。跨 Session 并行时间不能相加当作墙钟时间 |
| 派工阶段 | 能取得配对证据时分别列 Main 接收、工单提交、Captain 处理、assignment claimed、成员执行、成果提交和审核时间；缺一边界则该段未知 |
| 模型包络 | 配对的 `step/start` 至已结算 `assistant/message`；包含这两个边界内的调用准备、provider 等待和流生成，不覆盖此前的上下文组装与 pre-step，不是纯模型计算时间 |
| 首条流记录前段 | 有原始持久 stream 时间时单列；日志缓冲、provider 排队和隐藏推理未拆分时，不称为精确 TTFT 或插件开销 |
| 工具耗时 | 配对的顶层 call/result；PTC 子调用归属原 rootCallId/parentCallId/subCallId，单列但不再叠加到父 `run_code` 时长 |
| 等待与返工 | 单列主动 wait、依赖／人工等待、需求澄清、输入修正及无效重试；相互重叠时报告区间，不能简单相减声称得到纯计算时间 |

有可分离的时间戳才能给出插件提交、队列等待、唤醒与模型阶段的耗时。只有总耗时不得归责某个组件。并行模型步骤及工具用区间和计数表达；时间之和大于墙钟时间并不自动表示统计错误，必须说明重叠关系。

### Token、请求与错误

沿当前官方 `TokenUsage` 定义分别记录 `inputTokens`（非缓存输入）、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens` 和 `totalTokens`。完整输入为前三项已报告值的合计；任一组成项缺失则合计只能标为已知部分，不能把未报告当成已测零。缓存命中率为 `cacheReadTokens / 完整输入`，仅在组成字段完整且分母大于零时报告；已报告的零缓存读允许得到 0%。保留官方规范化的 total，与组成字段对账；来源已知时注明 provider 原报或 adapter 依据权威计数推导，不自行补值。不要把 input 再包含缓存、把缓存当输出或按显示总量推算费用。

`reasoningTokens` 只报告供应商实际给出的值及其定义，不能按推理文本长度估算，也不能不明是否已包含便加到 output/total。步骤按同 Session 的已结算 `assistant/message` 去重，`assistant/attempt`、失败／未结算步骤和标题请求另列；缺少传输证据时，物理 HTTP 请求次数和供应商内部重试次数未知。团队合计只加互不重复的 Session/turn/step 使用量，不把 UI 累计值、Team 累计账本与其底层步骤再次相加。

正常工具计数、PTC 子调用计数、失败根因次数和重试次数分开。按实际失败调用身份及可取得的 rootCallId、parentCallId、subCallId 关联内层失败和对应的外层 `CODE_RUN_FAILED`，不把同一次失败的包装再算成独立缺陷。一个 rootCallId 内可以有多个独立子调用失败，不能全部合并；无法唯一关联时标为未知。参数纠正、revision 保护、权限拒绝、运行环境、产品缺陷和用户主动操作分别归类，并记录最终恢复结果；保护正确触发不等于整个团队失败。

来源使用官方 Session reader／公开帧扫描语义及必要的 Team 白名单投影；多帧 `session.v3.jsonl.zstd` 不能只解第一帧就称作完整日志。采样保留运行版本的实际事件名：例如 rc.2 现场的 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`。上文 managed proof 消费者的既有 `tool/code-dispatch*` 合同是另一项兼容边界；不能通过重命名原事件伪造匹配，也不能用效率报告冒充该产品验收通过。

### 比较、观察阈值与优化验收

使用同类任务、相同验收条件和可比配置比较前后版本，每次只检验一个主要改变；GLM 与 Qwen 的比较记录具体模型、effort、缓存状态与任务难度。模型不同或用户改需求时保留分组，不把混杂差异称为插件提升。

业务比较的样本单位是一次纳入范围的业务请求，N 为全部纳入请求数，同一请求重试不增加 N。可用成果成功率为满足验收条件的请求数除以 N，首试成功率为首次尝试即满足验收条件的请求数除以 N；终态失败、取消、未知和进行中的请求均保留在分母并分别列数。含未决请求时，这两个比例只能称为截止时刻的已观察成功比例，不能当作最终成功率。单轮或模型步骤指标另报其样本单位及 N，不混用业务请求分母。

必须同时报告上述数量与比例、墙钟时间、模型步骤数、完整输入量、输出量及返工原因。时长统计注明已完成子集数量及未完成请求的截止观察时长；N 小于 20 时展示逐样本或范围与中位数。使用百分位须写明实际样本数和算法，样本数小于 100 的 p95 标为探索性。不能只选最快或成功的轮次。团队忙碌程度不是产出指标。

初始观察条件：单纯提交／回执超过 30 秒、有界预检超过 3 个模型步骤、同一失败修正两次仍未恢复，或出现无新事实的重复规则／预检／唤醒。命中只触发分类和原因采集，不是 SLA、运行失败条件或自动中断、更换模型、提高权限的授权。观察条件应按任务类别及足够样本修订；正确性门槛始终包含无重复副作用、未知结果不冒充失败／成功、失败可恢复和成果满足验收。

优先尝试轻量回执、合并独立必要读取、稳定规则引用、准确产物路径及减少无效重试。不能为降低时长而省略必要检查、写入证据或审核。采样不得额外调用模型、反复唤醒团队或妨碍实际制作。脱敏报告只含必要事件类型、时间、seq、关联 ID、工具名、错误码、配置白名单和数字用量；不导出正文、system prompt、隐藏推理、凭据或无关 Session。

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
pnpm verify:policy          # 治理、指令或登记文档变化时
pnpm verify:candidate
```

只有官方 DSH 或参考兼容性参与本次决策时才运行 `pnpm verify:compatibility`；输入未变化时复用已接受回执。

`verify:candidate` 执行工程检查，并消费外部控制器提供的产品证据。未设置 `P0_PROOF_ROOT`、`P0_EXPECTED` 和 `P0_EXPECTED_SHA256` 时，产品结果为 `NOT_CONFIGURED`；工程 CI 成功不能替代真实验收。配置不完整、摘要不匹配或证据所指 commit/tree 与实际干净 checkout 不同会失败。

当前 managed-Team 证据使用 schema 2，绑定固定官方版本、冻结包和独立控制器的 expected JSON，检查真实建队、Captain 资料、异构成员执行与审查、浏览器刷新以及重启后的新请求和新 attempt。schema 1 的旧 DEV_SMOKE 仅作兼容检查。CI `workflow_dispatch` 接受不可变 HTTPS ZIP 的 `proof_url`、`proof_sha256`、`expected_sha256`；`accepted_verifier_ref` 必须是经独立审查的固定 commit，且不同于候选。候选自行消费证据不等于独立验收。这一路径证明单个 managed Team；双 Team 交互和 Captain 自动唤醒根会话仍须分别实测。

## 浏览器验收

每条浏览器用例必须包含：

1. 明确的 Profile 与不可变插件包身份；新安装用全新 Profile，升级/恢复用保留原数据的 Profile；
2. 用户可执行的导航与交互；
3. DOM/可见文本/状态变化断言；
4. 控制台错误与服务错误检查；
5. 结束后的服务、Profile 和临时工件处置说明。

身份与通信场景须分别证明本人选择四项资料、保存读回后提交头像、同伴真实提问与关联答复、使用反馈提交以及 Captain 审查。面板交流强度请求须区分排队、工具保存和权威读回，并验证重启后的有效值。侧栏须覆盖首次进入未接管的 Session、已知成员切换及用户主动关闭/收起；不能用截图或固定睡眠代替对应状态断言。

重启后官方冷 Session 列表可能缺少运行时 inbox projection，缺失不等于队列为空；结合正式 Session 事件和持久化读回判断保留与消费。构建产物使用独立路径并核对已安装 host/client 的摘要，不能以安装命令成功替代版本一致性。

## 个人记忆与 Skills 模块的新增验收合同

统一开发方案的新增切片分别保留 RED/GREEN 和当前候选证据：自动轻量目录须验证真实 assemble、身份变化/撤权、显式完整目录和压缩/冷恢复；性能比较记录相同任务的读次数、耗时和实际请求输入，不以消息变少推断任务完成更快。

私有维护覆盖写队列中取消/撤权、失败原子性、旧记录重开、记录修订冲突、逻辑重试幂等与容量满额。召回覆盖自领/过期任务、无命中撤下、作废/任务变化、实际请求归属、压缩与重启、跨成员和同名新 Session 隔离。

独立 Skills 模块覆盖真实专用 Session 的授权清单、持久收件/恢复、历史快照与增量原子记录、去重/分页/保留缺口/来源回退、不可变资源摘要、作者不能自批、批准失效、两队独立 allow-list、精确版本分配/实际加载与安全回退。一个真实缺陷须有旧版、新版和相邻反例验证；模型自报、目录存在或 assigned 成功均不替代使用效果证据。

### Issue 关闭标准

Issue 只有在修复已进入 GitHub `main`，CI 通过，且达到该 Issue 声明的最高证据层级后才能关闭。重复 Issue 可以注明主 Issue 后关闭；部分完成、只有草稿或只有本地验证的 Issue 保持开启。
