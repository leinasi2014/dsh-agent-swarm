# 04. Team 核心协议

本文件定义插件运行时必须共同遵守的身份、状态、并发、权限、持久和错误合同。实现细节可以重构，以下语义不能被 UI、Provider 或兼容层绕过。

## 1. 身份拓扑

```text
Main Brain Session（Team 外）
  └─ managed create → 独立 Captain Session
                         └─ Team aggregate
                              └─ continuable Member Sessions
```

- Main Brain 传递完整用户目标并创建 managed Team；之后只做跨 Team 观察和路由。
- Captain 是 Team 的唯一管理主体，负责招募、职责/职业、任务、公告、公共目标、审核、交流策略和重派；Captain 与 active Member 各自创建和维护自己的公开身份，成员不取得他人的资料编辑权或队长管理权。
- Member 只能读取其所属 Team，并在分配给自己的当前 attempt 上提交工作。
- 一个 Session 可参与显式寻址的多个上下文时，隐式 Team 解析必须拒绝歧义。
- UI 中的“当前队长会话”与 Main Brain Chat 必须清楚区分；打开 Captain 只导航官方 Session。

## 2. Team aggregate

一个 Team 至少包含：

- `teamId`、scope、状态、revision、创建/更新时间；
- root Captain Session 绑定与 Captain identity profile；
- member roster、runtime descriptor、profile phase 与失败原因；
- task DAG、每任务 revision、owner/target、attempt 历史与 review 结果；
- mailbox message/receipt；
- public goal、announcement、shared memory、budget/usage；
- bounded effects、verification declarations 和恢复信息。

Team 阶段为 `staged | active | archived`：`staged` 是 Plan-first 声明态（尚无 Captain Session/成员/任务，`captainSessionId` 为空标记），`active` 进入正常编排，`archived` 为终态；`discardReason='discarded'` 标记被放弃的计划草稿（staged→archived，幂等）。

聚合通过 schema 验证后整体提交。新增 durable 字段（如 `planDraft`）必须同时修改类型、Storage Domain schema、state validator、reload 测试和读 projection；只改 TypeScript 类型不算实现。

### 2.1 Plan-first staged 审批

- `agent_swarm_create_managed(stage=true)` 仅创建 staged 聚合，不 provisioning Captain；same-managed-origin 重复调用幂等返回既有 staged Team。
- `agent_swarm_set_plan` 写入有界 `planDraft`（成员声明含可选 route/deny，任务图用 plan-local key + dependencies + target），revision CAS。
- `agent_swarm_approve_plan` 先把 staged→active 原子提交（durable authority first），再 provision 声明的专用 Captain、成员与任务图（key→真实 task id、target→member session、依赖接线）；`ask_user=true` 走官方 `ctx.userQuestions` 单一问题，放弃选项直接归档；缺服务 fail-closed。
- 审批提交后任何 provisioning 缺失都由激活恢复路径补齐（`recoverApprovedTeam`：补 Captain/缺失成员/空任务图，幂等），不静默回滚。
- `agent_swarm_discard_plan` 归档 staged 草稿且不创建任何工作，幂等；被放弃的 Team 不会隐式复活。
- staged Team 不参与调度/成员资格；只读投影暴露 `plan` 摘要（声明成员/任务数），Main Brain 绑定允许唯一 staged Team。

有未完成工作的 managed Team 冷恢复根协调者时，已有 `sessionController` 的 Host 使用官方 `resolveAgent`，由它恢复 preset、已保存路由及 pending 模型选择；该根 Agent 归 Host 所有，不进入插件的销毁清单。无 Controller 的组合只从官方 `foldRequestHeader` 恢复 provider/model、显式 reasoning effort 与 token 上限，再用官方 `installModelSelection` 保持 persona 变量和请求路由一致；缺少路由，或存在模型选择历史却缺少官方 `modelSelection` projection 时明确失败，不猜全局默认。已存活根协调者保持原有绑定与所有权。取消插件恢复只停止本次等待和后续子任务投递，不取消或销毁 Controller 正在共享恢复的根 Agent。

根恢复验收须覆盖真实首轮请求写入 Session → 销毁整个 Context → 冷恢复 → Captain 正式上行消息唤醒根协调者，核对 persona 中的模型变量、实际 provider/model/reasoning effort 与最终 turn；只证明 Captain 或成员继续执行不足以通过根协调者恢复。

## 3. revision 与 attempt 围栏

- Team mutation 在聚合 revision 上串行提交。
- 面向现有 task 的控制操作携带 `expected_revision`；stale revision 返回结构化冲突，不做部分写入。
- 每次执行生成唯一 attempt；submit/review/reassign 绑定当前 attempt 和 task revision。
- 旧 attempt、外来 owner、错误 target、重复 effect 和终态重放必须拒绝或幂等返回，不能覆盖较新状态。
- review reject、重派和自动调度的组合必须保持单一当前 attempt；缺少原子 seam 时保持失败可见，不伪装成功。

## 4. 任务与调度

任务状态围绕 `pending → in_progress → submitted → completed` 演进；review 可将 submitted 返回 pending 形成新的 fenced generation，失败/取消/归档按显式终态记录。`blockedBy` 形成有向无环图；只有依赖完成、预算允许、owner 可用且 orchestration owner 允许时才 ready。

Scheduler Provider 只选择可调度对象，不直接写 aggregate。Runtime 在 Domain port 上完成 claim，再把 assignment frame 投递到 continuable Member。投递只有在 frame 成为模型可见历史后才记为 delivered；pending inbox acceptance 不是稳定可见证据。

Member 消费排队分配时，插件在官方 `agent/pre-step` waterfall 返回前从 Team domain 重新核对所属 Team/member 仍 active、task 仍 in_progress 且 owner/currentAttemptId 匹配、attempt 仍 running。已提交、终态、换代或失去成员身份的旧分配不进入模型历史；混合批次保留正常反馈。只有失效分配且没有后继输入时拒绝该 step；还有输入排队时，改为一条不含旧任务正文或 attempt capability 的取消通知，让本回合正常结束并由官方 loop 继续 claim 后继消息。此通知会有一次模型调用，进展依赖本回合结束；不假称官方支持零调用跳过 turn。该消费过滤不改写历史或私自完成任务，队列移除仍由官方 inbox claim 记录。分配帧中的 task revision 用于后续 mutation CAS；消费边界按当前 task/attempt 生命周期判断，不能仅凭消息中的旧数字推断执行权限。域读取失败使本次 admission 失败，不把不可核验的旧分配放行；边界之后发生的状态变化仍由 submit/review 的 CAS 拒绝。

`adaptive` 模式由成员 idle/event 驱动；`workflow` 模式由 Team-backed Workflow run 驱动。一个 Team 同一时刻只有一个 orchestration owner，显式 Captain 操作仍受 revision/attempt 围栏。

### 4.1 开放认领

Task 可选 `assignmentMode: automatic | open-claim`，旧记录缺省为 automatic。open-claim 不得同时设置固定 target；只有依赖完成且符合现有准入条件的开放任务显示“待认领”。自动 Provider 的候选列表及结果验证均排除开放任务，最终 Domain claim 仍要求实际 actor 等于 assignee，保留 active Member 和 Captain 本人已有的自领权。依赖、busy、预算、reservation、revision CAS 与当前 attempt 围栏全部继续生效。Captain 给他人安排开放任务须经同一 revision CAS 原子改为 automatic 并设置 target，再沿现有分配路径执行。

沿用唯一 orchestration owner 和 Team mailbox 通知当前符合资格的空闲成员。自动任务安排先执行，再向剩余空闲成员发布开放任务通知；既有 reserved/owned attempt 的恢复不受候选过滤影响。Task 保存可选 `openClaimNotice: {revision, recipientSessionIds}`，只保留当前任务 revision 的有界收件人集合。邮箱入队与收件人标记在同一 Team 事务提交，队列满不标记，沿现有 activity/idle/recovery 重试；回执裁剪或重启不对同一任务 revision 和收件人重复通知。通知记账只递增 aggregate revision，不改变 task revision；退休成员从集合移除。Captain 不需要给自己发送邮箱消息，但可直接自领。

开放通知有仅内部可生成的类型标记。投递前重读实际 task 仍 open-claim、同 revision、pending、无 owner、依赖可执行及目标 active；任务已认领、变更或收件人退出时明确 obsolete。暂时 busy 或预算不足保留 queued，不能因已经记过通知就永久丢失机会；异步恢复后继续核验。通知只提示读当前任务和尝试本人认领，不携带 attempt capability，也不承诺仍可认领。两个成员同时认领最多一次提交成功，失败者读取当前结果或结束回合，不轮询争抢。

## 5. 成员招募与身份

成员身份包含技术名、显示名、短职业、人格、个人简介/identity card、可选安全像素 SVG、model/provider、Skills 与工具权限投影。像素头像只允许一个有限 `svg` 根和 bounded `rect` 子元素；验证必须发生在 durable member commit 前。

模型可用 `pixel_avatar` 提交 32×32 字符网格及最多 16 色的十六进制 palette；`.` 表示透明，其余像素引用调色板。工具把同色连续像素压缩为矩形，再通过既有 SVG allowlist 校验，唯一持久资产仍是 `pixelAvatarSvg`。网格和原始 SVG 不能同时提交；格式、未知颜色、全透明、复杂度或最终资产超界均在 mutation 前失败。头像由本人先确定并保存姓名、职业、性格和简介，读取确认后再按个人喜好设计；可以是人物、动物、物件或抽象图案，不强制按岗位画人物。缺少先前已保存的四项文字资料时，头像提交失败，不能用同一次 patch 补文字绕过此顺序；像素数量与色数仅是结构事实，视觉质量须真实预览，未保存资产的占位不冒充作品。

成员创建顺序是：输入/route/tool-policy/identity 预检 → provisional provisioning → 官方 continuable child 启动 → descriptor/phase 提交 → 可调度。启动失败必须保持单一失败记录且可恢复容量，不能产生重复可见员工。当前 route 预检和失败 roster 回收的完整修复仍由 GitHub Issue #176 跟踪，未完成前 UI 必须显示真实失败状态。

Captain identity 独立于 Member roster。`set_captain_profile` 成功提交后，Host/RPC 下一轮 projection 必须发布新 revision；占位文案不能被解释为 Captain Session 创建失败。

身份资料由现有 Team Domain 单一负责。staged plan 和 add_member 只声明不可变名册地址、简短 Team 职责、职业及运行配置；姓名、性格、简介和头像由成员本人确定，Captain 不得代填或修改这些个人字段，但可以调整职业。旧存储资料保持可读；旧计划尚未创建的成员不继承计划里的个人资料，失败招募重试仅允许沿用原记录的相同身份。成员在入队或首次任务时查名册，以 active membership 和当前 Team revision CAS 修改本人资料；他人的个人字段一律拒绝。Captain 通过 set_captain_profile 定义自己。缺项和失败如实显示，工作仍可继续，不无限重试。

字段规范：显示名是本人公开姓名，名册地址仅用于稳定路由；role 是简短 Team 分工，profession 是专业职业；personality 是稳定性格，biography 是真实背景和专长，不能写成任务清单、临时阶段、路径或权限禁令。后两者各限 1024 个 Unicode code points，沿用 Domain、Storage、Host/RPC 校验。成员按当前身份的性格和专长表达、询问和合作，不虚构资历、记忆或完成结果。UI 资料保持单行，溢出省略，悬停显示完整实际内容。

公开身份每次经官方 system-prompt/assemble 从当前 Team aggregate 读取，加入官方持久 user-role context snapshot。姓名、职业、性格、简介与 Team 职责作为有界 fenced data；模板字符保持字面，新快照替换旧资料语义，不能改变工具或权限。身份内容或有效交流策略改变时产生新快照，相同内容不重复追加。当前身份及同伴协作规则通过独立可信 system section 提供，更新旧 continuable persona 的相关指导而不重写历史 descriptor；用户显式 complete persona 仍由官方保持原样，不承诺覆盖其行为规则。无 active membership 不注入。资料 patch 不改 Session、role、模型、Skills 或任务状态，descriptor label 仍是创建时事实。恢复继续校验精确 Session、parent、origin、Team 标签与 provider。验收分别覆盖所有权、头像顺序、CAS/失败原子性、存储重开、实际模型请求和 UI 回读。

成员可通过 agent_swarm_send_message 直接向活跃同伴提问、答复并把反馈用于成果，Captain 不必代传。通过交流策略准入的 wakeup 可恢复空闲成员，超额主动唤醒降为 quiet；忙碌成员在后续 step 收件，不打断当前请求。quiet 仅入队；delivered 只证明投递，不能当成已阅读或已答复。同伴沟通不授予无关写入或新 attempt 权限；回答完毕、提交、遇阻或无工作时结束回合，不轮询。协作验收需有 A问B、B答A、A使用反馈提交、Captain审查的实际请求与持久 Session 证据。

交流强度 quiet/balanced/active 分别允许每名成员在滚动 60 秒内主动唤醒同伴 1/4/12 次；默认 active。超额消息持久保存为 quiet，不丢弃，不自动延迟唤醒，也不要求重发。Captain 上下行不受该限额约束；reply_to 必须引用对方发给自己的原始消息，其首次答复豁免，不能串联回复制造豁免。限频与首次答复证据均沿用 Team messages，重启保留；保留回执数量很小时会保守减少主动唤醒空间。此设置控制主动唤醒和协作节奏，不是硬性消息发送速率。

插件 communicationIntensity 沿现有设置的 restart 生效规则；Captain 的 agent_swarm_set_communication 使用 Team revision CAS 保存即时生效的 override，inherit 清除覆盖。当前强度注入参与者上下文；Host/RPC 投影展示生效值和来源。团队面板通过官方 Captain user prompt queue 提交用户的明确调节请求，不模拟 Captain 身份调用工具；只有更新后的 Team revision 与目标值匹配才显示已生效，忙碌时如实显示等待队长处理。

DSH `0.1.5-alpha.2` 的 continuable child 可由私有 owner 注册；`agents.roots()` 本身不证明顶层身份，root 权限还须核对 `session.header.parentSession`。官方带标记的 `send_message` 仅在精确存活 child 向真实 direct parent 发送时继承上行权限，仍经过后续官方 guard；同名替换工具与向下/跨成员发送不获得豁免。冷恢复的 Team Skills 在 `agent/session-start` 后、首个 step/工具调用前从权威 aggregate 重建，解析失败不得放宽权限。

## 6. 工具与权限

插件在 `src/tools/index.ts` 汇总 `agent_swarm_*` 工具，按以下能力组维护：

- managed/team/member lifecycle；
- Captain profile、goal、announcement；
- task create/claim/submit/review/reassign；
- mailbox send/wait；
- budget、shared/private memory；
- status、members、tasks、jobs、managed Teams 等 read surface。

工具 schema 的 `name` 是机器协议，`description` 是模型和 UI 的语义来源。普通 UI 应显示本地化短说明，不直接堆函数名；不能解析时诚实显示 unavailable。

权限是单调收窄：官方 preset/tool runtime 决定可用上界，插件 `allow/ask/deny` 不能扩大它。Captain-only 工具对 Member 永久不可用；显式 deny 与成员角色限制在 provisioning 时冻结进 descriptor，既有 Session 不因设置页改动而被重写。

工具权限设置从精确 live Session 的官方 `tools.schemas(agent)` 读取有界、只含工具名和用途的目录，通过既有 SettingsScope 保存互斥 allow/ask/deny；未配置项继承，已配置但当前目录缺失的名称保留并明确标记。冷 Session、读取失败和空目录是不同状态，不能以硬编码工具集代替真实目录。

`ask` 表示成员的具体调用先交所属队长批准。它在官方 `tools/pre-execute` 内等待，不改子会话的用户审批 `never`，不让队长代执行工具。队长自身调用继续遵循官方限制，不向自己发起申请。每次申请绑定当前 Team、精确 Agent/Session、open turn、执行 token、callId/rootCallId、冻结参数和工具定义；用既有 Team mailbox 唤醒队长，由 Captain-only 决策工具批准或拒绝。先保留下游 next 决策，仅 allow 时申请队长审批；批准仅释放该成员这一次仍存活的调用，并仍须通过官方单调 guards，下游 deny/ask 不被覆盖。

待审批表只拥有当前执行的 Promise，随该工具调用取消、超时、插件卸载或身份失效而销毁，不是第二份 durable 权限状态；Team 消息与官方工具调用/结果日志保留请求和决定证据。通知保持 queued 时原调用继续等待，消息的消费等待窗口结束不等于审批取消；只有有效决定才释放原调用。重启不恢复旧许可，迟到、重复、跨 Team 或跨成员的决定不得执行工具，错误明确提示不要重试旧请求 ID。队长不可用、审批工具被禁止或通知取消/失效明确拒绝；并发数量和请求体大小有界，等待观察原始取消信号并在卸载时收敛。

Team 消息的 `wakeup` 复用官方 steering：忙碌成员在最近的后续 step 消费，闲置或冷成员可被唤醒，不等待整个当前 turn 结束。`quiet` 只向已存活成员注入 next-step 上下文且不唤醒；其 delivered 表示收件箱接纳，并不证明模型已消费。两种投递都不打断在途模型请求或工具；wakeup 只有实际记录到模型可见历史后才确认 delivered，仍在收件箱时保持 queued，禁止重复发送。

## 7. Skills 与成长

插件设置提供新 Team 默认 Skill allow-list，Team 可保存自己的 allow-list；成员只能使用 host catalog 与 Team allow-list 的交集。Skills 名称来自实际 catalog projection，用户不手填服务器路径。

私有记忆、共享经验、Skill proposal、验证、独立批准、发布/回滚是不同层。当前已实现成员私有记忆和 Team shared memory；自动经验提炼、语义检索、自动晋升和 Skill Evolution 尚未交付，不能从职业、头像或记忆推断能力。

新 Team shared memory 在 `TeamDomain.addMemory` 的同一 Storage Domain transaction 内强制脱敏，覆盖 `content` 和每条 `evidenceRefs`；没有工具绕过或关闭开关。识别到的值替换为 `[REDACTED]`，保留标签、引号/反引号、Markdown 星号格式和键值表格结构。支持以下明确形式，不声称通用个人信息识别：

- 凭据标签（英文不区分大小写）：`API key/api_key/api-key`、`access token`、`refresh token`（同样允许下划线/连字符）、`password/passwd/pwd/secret/key/token/authorization`，以及 `API密钥/访问令牌/刷新令牌/密码/口令/密钥/令牌`。标签和值之间用冒号、全角冒号、等号、英文 `is`、中文 `是/为`，或 Markdown 键值表格的单元格分隔符。值为单行引号/反引号包围文本，或截至空白、逗号、分号、中文句号、表格/URL `|&?#` 分隔符的非空文本。`Authorization: Bearer …` 保留 Bearer 并遮蔽其后的凭据。
- 常见 ASCII email 地址；独立的大陆手机号 `1[3-9]` 开头共 11 位，可带 `86/+86` 和一个空格/连字符前缀，嵌入字母、数字、下划线或路径/标识符分隔符中的数字不据此判定。标注 `phone/mobile/telephone/tel/手机号/联系电话/电话/手机` 的号码支持数字、空格、括号、点和连字符；显式 `identity number/id number/card number/credit card number/bank card number/身份证号/证件号/银行卡号/信用卡号` 值也脱敏；证件/卡号允许空白分组，每个数字起始词元连同附着的字母或连字符尾部整体遮蔽，不截取数字前缀。任意任务 ID、时间戳、姓名、地址、无标签的任意字符串不视为已证实的 PII。
- 纯星号、`[REDACTED]`、`<redacted>`、`redacted`、`masked`、`已脱敏` 占位符保持原样；重复写入已脱敏值保持幂等。入库仍按原有规则去掉首尾空白，但原始输入及变换后 UTF-8 字节均须满足 content 16,384 / 每条引用 2,048 的上限，超限或无效输入返回不含原值的固定字段错误 `TEAM_INPUT_LIMIT/TEAM_INPUT_INVALID`。

权限、归档、记忆条数上限与提交原子性不变；失败不消耗 memory ID、不推进 revision。只处理新共享记忆，历史记录不重写；成员 private memory 和官方原始 Session/tool-call 输入日志不在这个入库策略范围内。

## 8. 持久化、读取与 UI

- `agent_swarm` Storage Domain 保存 Team aggregate。
- workflow、human interaction 和 private memory 使用独立插件 domain，不能偷改 Team schema 权威。
- Host service 和 `/swarm/v1` RPC 只返回 bounded、caller-scoped projection。
- Team Workbench 只读取 projection；页面轮询以 revision/内容变化发布，不得永久缓存占位数据。
- 多 Team 切换通过 Main Brain/Host projection 选择 Captain Session，不在侧边栏维护第二套 Team registry。
- official Session list/Chat 仍由 DSH 拥有；插件只提供可读 label 与导航。

任务正文使用同一只读入口的 `taskDetail` 方法：请求显式携带当前调用 Session 的 `target.rootSessionId`、`target.teamId` 与 `taskId`，继续经过 Host 关系核验；响应 `binding.rootSessionId` 是解析后的 Captain，不能据此替换后续请求的调用 Session。返回前复核 Team 修订与 Captain 绑定，界面也须核对当前 Session、Team、任务及响应绑定，丢弃切换或关闭后的迟到响应。

详情白名单保留任务摘要，并增加 `description`、`acceptanceCriteria` 和可选 `output`；同一任务的尝试增加可选 `output`、`diagnostic`、`assignmentDeliveredAt`、`replacesAttemptId` 及 `evidence` 数组。旧 snapshot/page 摘要不因此扩大。证据字符串只是保存的引用，不证明文件存在、可访问或已验证；诊断不等同于退回原因，分派送达记录时间不等同于模型开始、提交或审核时间。未保存的来源角色、审核者和阶段事件不推断补齐。

`attempts.scope` 固定为 `retained`，只表示当前 aggregate 保留的本任务尝试；先按任务筛选，再按 generation 降序、ID 升序返回最多 100 条，并报告 `retainedCount`、`returnedCount`、`limit` 和 `truncated`。没有保留尝试的已有任务返回 available 与空数组；任务不存在返回 `TEAM_TASK_NOT_FOUND/404`。既有保留策略已移除的历史不计入 retained 数量，`truncated: false` 也不表示完整历史。

详情文本不静默截短：description 与每项 output 上限各 65,536 Unicode 码点，subject 512，diagnostic 8,192；完成标准与证据各最多 64 项、每项 2,048 码点，依赖最多 100 项。snapshot/page 的任务标题同样支持 512 码点，不能在进入详情前拒绝 Domain 合法标题，摘要字段白名单保持不变。这些窗口覆盖默认 Domain 的 64KiB 文本与 64 项依赖限制；自定义更大限制或更大历史内容超出窗口时返回 `SWARM_RPC_PROJECTION_LIMIT/413`。读取失败与未记录字段分别显示，不能以空内容掩盖超限。

Team 注册 DSH SidebarRight 的独立页签，沿用官方布局与主题 tokens。卡片、视图、执行树、详情与名称展示统一由 [10-team-ui-layout.md](10-team-ui-layout.md) 定义。摘要和进度必须从同一 aggregate 派生；团队切换只更换绑定读目标，不能把旧团队的正文放到新卡下，也不能把未完成读取当成新团队可用。归属路径与当前会话标记必须使用 Host 核验过的关系。

不添加顶部 Team 按钮；关闭后可从官方侧栏的新页签引导页重新打开 Team。现有 controller 随当前 Session 只读观察，首次载入、创建团队及重连后取得完整 Host 投影才自动申请页签，不显示无团队空卡。关闭、切到其他官方页签或收起右栏后，同一 Team 的刷新不得抢回焦点；加载期间关闭同样有效。官方 tab.id 仅在 Session 内唯一，插件按 Session 与 tab.id 跟踪绑定；组件卸载只表示正文不可见，只有 tab.signal abort 表示实际关闭。切换 Session 时保留各自页签；新的 Team 可重新显示。新打开的队长/成员 Chat 优先选中 Host 验证的所属 Team；主会话默认选择未归档 Team，用户显式选中的其他或历史 Team 在当前 Session 内保留。轮询、请求取消和卸载仍由原 controller 生命周期负责。

成员 Chat 复用已安装 DSH 的公开 `ISessions.refreshSubagents/list/openSubagent`：刷新后从 `list` 的 `subagentsByParent` 中取 `ready`、healthy continuable child 的精确 Captain/member 地址，再导航，不构造私有路由；`subagentAddress` 仅查询已导航地址，不能用于首次打开。Host 以请求 Session 的官方 live/persisted header 与当前 active roster 为依据，校验成员→Captain→无父级主会话的关系及相同 scope，才在 local-single-user 只读 RPC 中提供该主会话的兄弟团队目录与显式选中团队的读取。普通 child、移除/旧身份、跨 scope 或缺失关系不获得该扩展。`teams.binding.rootSessionId` 仍是请求 Session，可选 `mainSessionId/mainSessionTitle/currentTeamId/currentMemberName` 是经验证的导航投影；主会话标题仅取官方公开 Session 标题，成员名仅取所属 Team 当前公开资料，缺失不编造。每次 section/read 继续重新验证请求身份和关系，UI 不能缓存成权限。

成员导航前重读绑定和成员行；返回主会话前重新读取团队目录验证 mainSessionId，再交给官方根会话列表导航。已核验的同 Team 活跃 Captain/成员切换可保留只读投影，同时对新 Session 重新读取并验证绑定；无关 Session 清空旧正文，不复用其权限。各 Session 的官方页签分别保留，打开动作通过 `SidebarRightNavigator.openTabIn(targetSessionId)` 精确寻址；只有实际 `observeTab` 才确认 docked。首次 store 尚未接管时依靠既有权威读取节奏重试，不能向旧 Session 的 seat 写入，也不能把调用成功当作页签已显示。该 UI 临时状态不成为业务权限，注册/轮询继续随既有 controller/coordinator 卸载释放。验收覆盖多团队目录、快速反向切换、首次导航、导航竞争、冷读取、错误父级/成员、主会话返回及官方页签切换与侧栏收起。

### 8.1 公共文本消息与显式公开回报

公共群聊的首个写入切片采用官方 Connection RPC 认证通道 `/swarm-public`，以 `v1/history`、`v1/append`、`v1/requestResult` 为版本化端点，由 Host 的 `connection.rpc.handle` 注册并随 Context 注销。官方 channel 只允许单段路径；客户端调用相同通道与端点，最终 HTTP 路径为 `/swarm-public/v1/...`。官方 Host/Origin 与 BrowserAuth 检查先于业务 handler。handler 内派生的作者仅表示本 Host 已认证的 `local-operator`，Cookie 不提供多用户 userId，不能冒充已有 `authenticated-human` principal。wire 不接受作者、principal 或 Captain 身份。请求的 Session 与 Team 仅用于选择目标，Host 重验真实 scope、官方 Session 关系和当前 Team；旧 `/swarm/v1` 仍是原有只读合同。

部署依赖 Connection 在自身提供方作用域注入 `webServer` 并挂载频道，同时保留调用方的声明与撤销所有权。`0.1.5-alpha.2` 原包在兄弟插件提供 WebServer 时存在注入错误；源码中的 `patches/@deepseek-ai__dsh-client-connection@0.1.5-alpha.2.patch` 固定测试依赖，真实 Host 也须安装对应 Core 包。仅安装 Swarm 插件不会替换 Host 的 Connection；根 Context 直接提供 WebServer 的 fixture 不能证明该部署条件成立。

v1 定义人类公共文本默认交给当前 Captain，以及 Captain/成员显式发布带 `replyTo` 的公开回报。新发送仅向具有有效 `managedOrigin`、准确 Main→Captain 关系、可由现有 managed recovery owner 恢复的 active 托管 Team 开放；普通、staged 或已归档 Team 明确不可发送，读取可用性不授予写权。Host 公开读取、追加与查询原请求结果；Agent 回报从实际工具执行上下文派生作者并验证当前同队权限。个人 Session 的完整输出不会自动转贴到群里，公开回报也不会隐式唤醒全员。v2 的多提及与共享目录按下一节扩展同一消息权威，图片、工作请求及目标控制继续沿后续切片接入。

公共消息扩展现有 `TeamDomainPort` 与同一官方 Storage Domain Team aggregate。一次 transaction 保存服务器分配的消息 ID、提交顺序和时间、冻结的作者展示资料、正文、原消息引用、逻辑请求身份及定向投递意图。请求身份绑定 Team、真实作者和完整规范化载荷；同身份同内容返回原结果，内容改变则拒绝。旧 Team 缺少公共字段仍可原样读取。消息与请求凭据均有明确数量和字节上限；首片容量满时拒绝新追加，不能靠丢弃幂等记录释放容量后允许旧请求重复执行。公开读取按稳定消息顺序分页并报告实际范围，不把部分页面描述成完整历史。

官方 Session 日志仍是模型实际收到输入的权威。公共消息提交不等于已消费：定向意图由现有 runtime owner 串行投递，持久化的版本化 frame 冻结原消息 ID、接收人和完整实际输入，恢复时不按新姓名或新模板重建比较文本。复用 `frameVisibility` 的 claimed、pending、absent、unknown 判断：只有经持久化确认的 claimed 才结清消费记录；pending 与 unknown 不盲目重投，absent 才重新投递。首次发送与冷恢复共用同一路径；空任务板上未结清的公共投递也必须触发现有 managed recovery，不能新增另一套规划或消息循环。

同请求 ID 重试只确认原提交，不是继续命令；冷启动发现耐久 pending 时保持 queued/deferred，用户显式提交的新公开 ID 经 Team、lineage 与容量校验后才通过现有 prompt 驱动已有 Inbox，原 frame 不重投，unknown 不作为激活或重投依据。

同一官方 live Agent 仍在运行时，当前 turn 已从 Inbox 取出、尚未写入 user/message 的精确输入属于 unknown；继续组装模型请求期间不得重投或提前确认。该判断从官方 turn 与 inbox splice 日志重建，取消移除、实际 user/message 和 turn 结束使在途记录收敛。没有对应 live driver 的冷恢复不继承这项临时保留，仍按耐久输入事实决定是否补投。

提交成功后响应丢失、客户端取消或断线，界面保留原请求 ID 与冻结载荷，显示结果待确认；查询权威结果或以同一身份重试，不能生成新 ID 重发。查询无法验证目标或读取存储时不得返回确定的 not-found。群草稿按当前 Host、查看者与 Team 隔离；完成回调只结算原操作，只有原草稿版本未继续编辑时才清空。未提交草稿及待确认操作的浏览器恢复范围须明确说明，客户端记录不成为公共消息权威。

代表性验收包含：认证缺失/错误来源与跨 Team 拒绝；同请求并发、不同载荷冲突、提交后丢 ACK；公开回报丢工具结果后的同请求重试；发送中切群；真实 Captain 消费与显式回复；无任务 Team 冷恢复；claimed 后、Domain 确认前崩溃不重复输入。工程 fixture、真实模型、真实重启与生产部署分别记录。

### 8.2 稳定身份提及与共享目录

多提及沿用 `/swarm-public` 的认证与目标读取边界，增加 `v2/history`、`v2/append`、`v2/requestResult`、`v2/directory`。版本适配只选择严格输入解析和输出投影，认证、请求查询、事务、分页及投递继续共用原 owner。v2 追加字段为 `schemaVersion: 2`、`target {rootSessionId, teamId}`、`requestId`、有序 `content` 和可选 `replyTo`。结构段只有 `{type: 'text', text}` 与 `{type: 'mention', memberId}`；`memberId` 是当前 Captain 或成员的精确 Session ID，完整身份为 `(teamId, memberId)`，不建立另一份身份表。wire 不接受作者、label、parent、frame 或独立收件人数组。

规范化先合并相邻文本段、去除空文本段，再裁去首尾文本段的外围空白，不改内部空白、段顺序或 Unicode 形式。重复提及仍在原位置显示，接收人按首次出现的 ID 去重；没有提及才默认 Captain，不按姓名或 `previousSessionIds` 猜测替补。Host 对真正的新提交重新核验全部当前身份、状态与官方 lineage，并在同一事务的 Team revision 围栏内从公开资料冻结 label。草稿可缓存姓名供编辑展示，wire 只提交 ID。摘要绑定版本、Team、实际作者、请求号、规范化结构段及 `replyTo`；label 与目录 revision 不属于摘要，改名后的原请求重试仍返回原展示快照。

新的人类输入中，未转义的 ASCII `@` 且其紧邻前字符不是 ASCII word `[A-Za-z0-9_]` 时，视为候选起点及未确认提及；句首、中文及标点后适用，邮箱中的 `a@example.com` 保持字面。UI 候选与发送检查、Host 对文本段的校验使用同一纯函数，Host 不解析姓名。Esc 只关闭候选，不解除未确认状态；选择当前目录中的精确成员后才产生 mention 段，普通复制粘贴仅产生文本。字面 `@` 使用反斜杠转义：其前连续 `n` 个反斜杠为奇数时，渲染为 `floor(n / 2)` 个反斜杠和 `@`；偶数不转义，仍按候选起点检查；其他反斜杠原样保留。wire 和持久 content 保留转义形式供摘要与重试，只有展示正文解码，解码后不二次扫描。历史 v1 文本、已提交请求及 Agent 公开回报正文不套用新提及检查。

新持久记录带 `formatVersion: 2`，保存规范化 content、Host 生成的 `mentionLabels [{memberId, label}]`、一致的渲染正文和版本化投递集合；旧记录保持原字段、原摘要和 frame v1，不批量改写。新的人类消息一次事务保存全部接收人的 `recipientSessionId`、`parentSessionId`、`frameVersion`、完整 frame 及初始 queued 状态；新 frame 明确标识版本 2。Agent 公开回报仍为不请求投递。wire 只投影接收人、公开状态、时间及原因，不暴露 parent、frame 或摘要。沿用文本字节、消息数及 aggregate 总字节上限，结构段数另设并返回 Host limits；接收人数受当前合法 roster 与 Captain 限制，总容量计算包含全部 frame 和最大回执预留，不能部分追加。

逐人状态为 queued、带 `claimedAt` 的 claimed，或带 `settledAt` 和 `recipient-removed` / `team-archived` 原因的 not-delivered。确认退出终态前，既有 delivery owner 的同一串行段必须排除在途 admission 并读回耐久 frame；claimed 证据优先结清，只有已证明 absent 且域内身份移除或 Team 归档才可标记 not-delivered。进程内 map 为空不证明未投递，pending、unknown、临时离线和读取失败不能转为永久终态，也不能重投。成员投递复用原 managed recovery：先恢复精确 Main，通过 Core `withContinuableChild` 的 callback lease 恢复并保活 Captain，再由现有 `subagents.prompt` 只提交真实成员输入；不制造父消息、不绕过 subagent ownership、不增加恢复循环。callback 使用 lease signal，真实后代的既有 ownership 接续父级保活。该 Host API 由 `patches/@deepseek-ai__dsh-subagent@0.1.5-alpha.2.patch` 对固定发布包增加；补丁来自 Core 的实际构建代码和类型声明，不新增 Remote 或模型工具。运行环境须装入匹配的 Core 产物，仅安装 Swarm 包不会替换宿主依赖。

请求唯一键跨版本保持 Team、真实作者与 requestId；只有摘要算法按版本分派。先验证当前认证和目标可读 scope，再查原作者的已提交记录，存在时按原版本摘要核验并返回冻结事实；当前接收人、归档及容量检查只约束新提交。v2 接受新消息；v1 append 仅返回已提交且原摘要一致的 v1 请求，未找到则返回明确版本错误，不创建新 legacy 消息。v1 requestResult 对不存在返回真实 not-found，命中 v2 则版本错误；v1 history 的所请求页面含 v2 记录时整页版本错误，不能丢行或伪造单 Captain 结果。v2 统一投影新旧记录并保留原格式版本，旧正文作为字面文本段、旧意图作为单接收人投影，不重扫或重建旧 frame。

客户端待确认记录保留原版本、ID、载荷及草稿版本。legacy pending 查询到 not-found 只允许保留草稿并显式确认 v2 内容，升级确认仍沿用原 Team、作者与 requestId，不能换新 ID；若旧 v1 随后先提交，v2 不得覆盖或追加另一条，须读回旧事实并保留升级后编辑的 v2 草稿。仅原操作对应的未继续编辑草稿可在成功后清空。公共草稿的 key 沿用 Host、规范 Main 与 Team，同群的合法查看者共享草稿，个人 Chat 仍由官方 Session composer 保存；切群、切查看者、迟到回包及目录变化不能重写冻结请求的接收身份。

共享目录由同一 runtime 只读投影供 UI 三个入口、`agent_swarm_directory` 读取工具及适用的 `system-prompt/assemble` 消费，不新增缓存权威或轮询 owner。每条包含精确 memberId、角色、名字与公开 label、职责、职业、性格、简介、阶段、当前任务，以及 Skills 名称/用途和 assigned、Session-visible 各自状态、工具可用/需批准/禁用/未知、当前 provider/model、官方 `inputModalities` 推导的 supported/unsupported/unknown 图像状态。资料、模型、Skills、工具等来源分别报告状态、真实版本或内容摘要、observedAt 与实际存在的 updatedAt；读取时间不能冒充修改时间，声明 deny-list 不能冒充完整有效权限。私有记忆、秘密参数和系统私密内容不进入目录。

目录返回 schemaVersion、经验证的 binding、directoryRevision、observedAt、entries 及 page 的 offset/limit/totalCount/returnedCount/hasMore/nextCursor/unreadRanges。revision 由同一代规范化内容和实际来源版本计算，排除 observedAt；模型、Skills 或权限变化即使 Team revision 不变也须使目录更新。发布前重验所依赖的域与来源，发生变化则重读或返回 stale，不发布混合快照。cursor 绑定 Team、revision、offset，后续页变化返回明确 stale 并重新读取，不拼两代目录。所有成员的身份行均可枚举，分页未读范围与字段未知分别表达；正常规模上下文提供完整核心目录，大队给出页范围与读取入口。append 重验本次接收人的合法身份，不信任客户端旧目录，也不以无关成员的目录变化阻断提交。

模型上下文投影递归省略目录各层 `observedAt`，保留真实 `updatedAt`、语义 revision、成员资料、能力状态与分页边界；RPC 和显式目录工具仍返回观察时间。仅时钟推进不追加相同目录，真实语义变化在下次处理前发布。官方压缩移除旧上下文快照后，下次处理重新注入当前目录，不以客户端缓存或永久已读标记阻止恢复。

### 8.3 公共图片与自主视觉协助

图片复用 `/swarm-public` 的认证和目标解析，增加 `v3/append`、`v3/history`、`v3/requestResult`、`v3/image`，目录继续使用 v2。v3 append 保留 target、requestId、replyTo 与有序 content；新增上传段仅为 `{type: 'image', mediaType, data, name?}`，data 是原始文件的 base64，禁止 URL、路径、附件引用、作者或客户端自报的尺寸。Host 通过实际 `ctx.attachments.imageLimits` 检查数量、原始字节与解码像素，再交官方整批 admission；无附件服务明确报告图片不可用。文字和提及规则沿用 v2，只有图片的消息也有效。v3 history/result 投影全部旧格式，原 v2 页面或请求命中 v3 时明确版本错误，不跳过记录；既有 v2 文本追加保留兼容。

公开图片段只含稳定的 message 内 imageId、校验后的 mediaType、bytes、width、height、可选 name 与 originalDimensions。相同文件多次出现仍有各自 imageId；真实 `ImageAttachmentRef` 仅保存在 Host 的 Team aggregate。`v3/image` 只接受 `{schemaVersion: 3, target, messageId, imageId}`；Host 在读取前后验证当前目标权限和精确消息映射，经官方 `readImage` 校验后返回 base64 与匹配元数据，不提供裸附件 ID 或 bearer URL。Client 使用可释放的 Blob URL 展示；读取失败可重试，不影响正文。官方默认图片限制为单张 20 MiB、单次 20 张/200 MiB、64 Mpx、单边 8192，支持 PNG/JPEG/WebP/GIF；运行时以真实服务配置为准，Connection 的 300 MiB 请求上限还约束 base64 和 JSON 总开销。

新提交复用现有 `withPublicAdmissionFence`：重读真实作者与目标，先查询原 requestId 并比较摘要，再执行整批官方 admission，之后重验取消、运行时、成员与 Team revision，最后由同一 Domain transaction 保存消息、原始引用、请求凭据及全部接收人意图；事务内再查唯一请求。摘要绑定有序规范化内容、每张原始解码字节的 SHA-256、声明 MIME/name 和 replyTo，不能用 normalization 后的字节替换原请求身份。原请求命中不再次上传或 admission。投递 kick 在 fence 外执行。附件失败不提交半条公共消息；跨 Attachment 与 Team storage 没有联合事务，崩溃或取消可能留下不可达官方对象，不能宣称跨存储回滚。

每名接收人的实际输入投影在首次确定能力后耐久冻结：已支持为完整有序原图 refs，明确不支持为官方 `textOnlyImageText` 与受控图片 ID，未知则保持 deferred。恢复不按最新能力切换既有投影；若当前模型已不能接收冻结图片则保持明确待处理。Human 输入保留 `kind: user` 与稳定 rpcId，协助输入使用真实 plugin 来源。Host 在当前 fence、有效 Captain lease 内重验身份和图片完整性，通过固定 alpha.2 的已发布 internal `steerHostSubagentPrompt` 使用官方生命周期，不伪造 Agent 作者、不修改 Core 或绕过能力检查。

Session 消费证据比较稳定 frame/rpcId 身份与完整冻结输入两层条件。相同身份但文字、来源、图片数量、顺序或原 refs 不一致为 unknown，优先于任何 claimed；只有完整匹配的持久 claimed 才结清，完整 pending 继续等待，证明身份 absent 才能投递。live、flush 后及冷恢复共用这一判断。文字标记存在不能证明图片已收到，也不能将不完整消息误判 absent 后重复发送。v3 的 queued 接收人可带有限 `deferredReason`：`image-capability-unknown`、`image-model-unsupported`、`image-unavailable`、`projection-mismatch` 或 `recipient-unavailable`，由现有投递 owner 耐久更新；相同原因不重复更新 revision，claimed/settled 清除原因。UI 显示明确的等待原因，不暴露原始存储或 Provider 错误，旧 v2 合同不变。

`agent_swarm_request_visual_assistance` 接受稳定 request_id、source_message_id、非空且去重的 image_ids、helper_member_id 与 question；作者和 Team 从实际 exec 推导。只有原消息的实际接收人能发起，只能选同队当前可用、声明支持图片的其他成员。Host 从原消息解析图片，不接受任意 ref；工具失败明确区分无可用成员、能力未知、图片不可读、撤权和过期。协助在同一 Team aggregate 保存不可变 assistance/result ID、原消息与图片集合、发起人与 helper、问题、期限、visited 和投递状态。同一逻辑请求重试返回原事实，改载荷冲突；同源、同发起人和图片集合的在途协助去重，helper 不能链式转交同一协助。

`agent_swarm_complete_visual_assistance` 接受稳定 request_id、assistance_id 与 outcome（公开摘要或受限失败原因）；仅指定 helper 能完成。结果、关联原消息的公开回报和定向返回原发起人的意图由同一 Domain transaction 提交，并共用现有 public delivery debt、串行投递、退出围栏和 ManagedActivationRecovery。读取、既有活动或恢复时检查期限；不增加另一套轮询，也不承诺无人活动时精确计时通知。迟到结果不覆盖终态。协助不自动招募、换模型、转移任务 owner、扩大权限或接受任务，原负责人继续执行并经过既有审核。

协助期限固定为创建后 15 分钟；接纳前预留一条结果消息及最大摘要的转义字节容量，后续公共消息不能占用该空间。公开协助的 imageIds 按实际源图块顺序排列，每个 helper 图片输入前明确原 source_message_id 与 image_id；内部用于去重的排序集合不决定图片含义。问题及结果按 Agent 原文传递，只有人类结构化文本解析提及转义。

公开 v3 消息可含 Host 派生的 `assistance`：`kind: request | result`、assistanceId、sourceMessageId、非空去重 imageIds、requesterSessionId、helperSessionId 和 expiresAt。结果另有 resultId 与 outcome；成功为 `{state: completed, summary}`（非空，最多 8192 字符），失败为 `{state: failed, reason}`，原因限定 helper-unavailable、image-capability-unknown、image-model-unsupported、image-unavailable、permission-revoked、expired。请求与结果各是一条可追溯的公开消息，复用其投递债务，resultId 可直接使用结果消息 ID；原图仍由 sourceMessageId/imageIds 定位。此字段只读，不接受人类 append 填写，内部 visited、请求摘要及真实附件引用不进入公开投影。

指定 helper 实际完成的回报保留其 Agent 作者。过期或撤权由 Host 检查产生的失败结果，使用仅 v3 支持的 `{kind: system}` 作者，界面显示“团队系统”；不归因给未执行此回报的成员或人类。此系统身份仅能由内部终态事务生成，普通 append/Agent 工具不开放作者参数，v1/v2 作者合同保持原样；定向通知的 Session 来源仍为真实 plugin。

协助已关闭时，既有 public delivery owner 先核对官方输入事实及待提交完成结果；仅对可证明尚未投递的 helper 债务结算 `not-delivered / assistance-closed`，已 claimed 的输入不可撤回或重投。此原因仅扩展 v3，不把协助关闭冒充成员移除或 Team 归档，v1/v2 保持原合同。

Client 用原生 IndexedDB 在一个事务中保存按 Host/Main/Team 隔离的草稿、Blob 与原请求描述，落盘成功后才能编码提交同一 v3 append。恢复完成前不发送；未知结果保留相同 requestId、内容与 Blob，不创建新操作。v1/v2 pending 保留原版本恢复。切群或继续编辑只结算原操作，清除草稿须匹配原 revision，移除当前附件不能删除 pending 仍引用的 Blob。浏览器存储失败明确阻止发送；浏览器记录只是恢复素材，公共消息成功以 Host 耐久提交为准。

验收覆盖纯图片与混合有序图片、官方 admission 拒绝、字节/MIME/名称冲突、丢 ACK 与刷新恢复、跨 Team 读取拒绝、同身份缺图不重发、真实视觉输入、非视觉自主选人、协助去重与失败、退出/取消围栏、关闭页面及冷恢复、原负责人继续提交和审核。fixture、真实模型、浏览器恢复及正式部署分别记录，不能互相替代。

### 8.4 工作请求与公开任务事实

沿用认证 `/swarm-public` channel，新增独立 `work/v1/submit`、`work/v1/requestResult`、`work/v1/activity` 端点，公共聊天 v1/v2/v3 保持原合同。人类只提交 target、稳定 requestId、非空 description（最多 8192 字符）和可选 acceptanceCriteria（最多 4096 字符）；Host 从已认证的本地操作者派生 `{kind: local-operator}`，通过现有 HostTargetRead 验证准确 Main、Team 和 active managed Captain 绑定。浏览器不能填写作者或借所查看成员的身份创建正式任务。Main 专用工具从实际 exec 推导 Main Session，重验 scope、managedOrigin 与 Main→Captain 官方关系后提交 `{kind: main, sessionId}`；成员不通过此入口伪装 Main，现有创建和自领权限保持原样。

工作请求是 Team 内的来源记录，不是第二套任务状态机。请求唯一键包含 Team、真实来源和 requestId，内容摘要冻结；同载荷重试返回原请求与关联，改载荷冲突。请求、提交事实和发给 Captain 的耐久通知在同一 aggregate 事务提交；邮箱满或写失败则整笔未提交。通知明确携带真实来源的 `work-request` 类型，复用现有 mailbox 和投递 owner，不伪造 Captain/self-send、Main 群聊作者或普通人类聊天输入。通知输入及工具结果仍沿官方 Session 持久化。`requestResult` 明确区分未找到与已提交，网络未知结果保留同一 requestId 查询/重试。若将来从既有群消息提出，请只保存实际存在且通过 Team 可见性校验的 sourceMessageId，引用消息的作者不替换实际提出人。

Captain 通过实际工具调用读取待处理请求，并按请求 revision 一次接受完整计划或以非空原因拒绝。接受计划有 1–32 个唯一 itemKey，复用 CreateTaskInput，允许 blockedBy 引用既有 Task、blockedByItems 引用本批条目；先分配稳定 itemKey→TaskID，再在同一事务验证全批权限、容量和 DAG，提交决策、全部 Task、映射及对应事实。不得逐个调用独立 createTask 导致半成功。拒绝不创建 Task。重试先验证当前真实 actor，再比较已保存决策摘要；相同决策返回原映射，不能被已经过期的旧 expected revision 或当前容量误拒绝，改决策明确冲突。待处理请求不占用 Task 编号、任务数、完成统计或执行槽位。

接受及其同决策重试在提交后等待现有调度 owner 的一次准入 pass，保留真实 continuable Captain 直至当轮 pass 完成，不等待成员工作完成或整个队列清空；busy/预算受限通知仍按原机制排队，仅同 Team 的实际 Scheduler Provider 回调重入只排后继以避免自等待，不把通知唤醒的新 Agent 执行算作调度重入。拒绝不产生新准入 pass。提交后的身份失效、取消、卸载或调度失败明确报告 `TEAM_WORK_REQUEST_ADMISSION_FAILED` / `TEAM_WORK_REQUEST_ADMISSION_INTERRUPTED` 和已提交事实，不能暗示回滚；调用方权威读回或重试原决策恢复原任务映射。

新创建 Task 保存真实 createdBySessionId；请求创建的 Task 另保存不可变 source，包括 workRequestId、itemKey 和真实 origin。submit/review 在现有事务保存实际发生时间和执行/审核 Session，并追加结构化事实；不由 updatedAt、当前查看 Session 或队长身份反推旧记录。生命周期事实只包括明确的来源、关联、动作、状态、实际 actor 与发生时间，不自动公开成员私有输出、证据正文或工具参数。群内显示真实请求提交、拒绝/采纳和任务创建、认领、提交结果、审核/退回及改派卡片；它们引用原 Task/attempt/请求，不能解释普通聊天文本建立权威，也不依赖模型额外 public_reply 才显示已提交事实。

新增请求及 activity 容器各带 schemaVersion 1，作为 Team optional 字段读回旧记录。请求最多保留 256 项，到上限明确拒绝新请求，不静默删除幂等身份；Task 上限仍服从既有配置。activity 使用自身单调 sequence 与唯一 ID，最多保留 1024 项，每页最多 100 项，响应给出真实保留起点、终点、是否还有页及请求/Team 绑定。其 sequence 不与公共聊天 sequence 混用；UI 用稳定 `(kind,id)` 键和服务端事实时间呈现，明确旧历史裁剪范围。旧 Task 缺少来源或提交/审核字段时显示未记录或接口未提供，不能补造事实。新字段写入后旧 Host 的严格 schema 未必可读；升级前备份原 Home，回滚须恢复与旧二进制匹配的备份，不承诺仅换包就能读取新版状态。

activity 同一读取快照返回本页引用的去重 referencedRequests，最多 100 条，仅含公开 WorkRequest 字段；请求卡可展开原说明、完成标准和真实采纳映射，不暴露内部摘要或通知状态。Team revision 与页内容来自同一读取快照。任务 snapshot、tasks page 和 taskDetail 的新增分配方式、来源及实际提交/审核事实使用显式 schemaVersion 2；schemaVersion 1 的返回字段与严格合同保持兼容。新 Client 明确请求 v2，旧 Host 不支持时回退 v1 并显示新增字段未提供，不把缺省接口猜成事实。

Client 的“提出任务”位于任务面板标题旁，仅描述必填，完成标准可选。草稿与聊天分开并按 Host/Main/Team 持久保存；提交前先落盘同一 requestId、冻结载荷和草稿版本。切 Team、未知响应或关闭后继续原请求，晚到结果只结算原操作，不能清除别的 Team 或较新草稿。已提交显示“已交给队长整理”，Task 真正创建后才展示正式关联。工作状态和 activity 订阅既有 dashboard 刷新与重连 owner，不另加轮询、第二任务状态或冒充成员的自领按钮。

验收覆盖认证和假 Main 拒绝、丢 ACK/冷恢复幂等、含批内依赖的原子拆分、拒绝及失败零 Task、实际来源与审核事实、开放认领竞争/通知裁剪恢复/依赖和 busy、改指派、旧数据读回、跨 Team 草稿隔离与真实 Profile 的请求到审核链路。记录测试、真实模型、浏览器和部署证据分别成立；目标修订、暂停与维护是后续独立合同，不由本节推断已经实现。

## 9. Review、execution root 与可选桥接

Review Provider 返回判定和 bounded evidence，Domain port 完成状态 mutation；候选不能审核自己。Executable review 运行于声明的 review root，并将命令、退出码和产物身份绑定当前 attempt。

选择 `reviewProvider: reviewer-agent` 时，Host 必须通过 `ctx.agentSwarmPermission.registerReviewerAgentProvider` 注册真实 evidence-only Provider；注册和注销同步控制运行时 Provider 可用性。Host 可以在 Swarm 挂载后、官方 Loader 装配结束前注册。Loader 的 `await` 依赖就绪点仍缺 Provider 时报告 `TEAM_INVALID_CONFIG` 和缺失注册入口；该诊断不代表整个 Host 进程退出。无 Loader 的直接 Context 组合由 Host 完成注册，新 Team/任务 admission 仍检查真实 Provider 集合，缺失时返回 `TEAM_REVIEW_PROVIDER_MISSING`，不得降级为 manual。已有 submitted attempt 的评审继续遵守原有失败不改域契约。

Execution root 是每 attempt 的工作目录租约，不是开发 writer lane。插件为持有租约的成员安装 scoped tool Consumer，复用官方 `read`/`read_image`/`write`/`edit`/`pwsh`/`bash` 的 schema、真实 Agent 身份、执行实现与取消生命周期；文件相对路径和 shell cwd 自动解析到租约目录，拒绝显式目录越界及已有链接越界。持久 shell 每次命令先切回本次租约目录。Team namespace 和 Session header.cwd 保持不变；租约结束后旧成员的这些工具拒绝执行，不能回落到共享目录。此路径约束不解析任意 shell 代码，也不替代部署 sandbox 的 OS 隔离。

撤租发生在官方 guard 与工具 body 之间时，body 仍必须拒绝执行。运行时卸载撤销 IO 绑定，但保留未提交目录；冷恢复成员首次文件或 shell 调用，在官方 pre-execute 阶段根据持久 Team 的当前 running attempt 重建绑定，并由 Provider 验证原目录 marker。首次操作直接提交时也须先恢复原目录、保存补丁，再提交状态；目录缺失则保留未完成 attempt 并报错。目录缺失、成员已退出或 attempt 已结束时拒绝 IO，不创建空目录假装恢复；正常提交后的终态回收仍走原有 sweep。残留扫描只报告，不能以扫描结果替代这条实际恢复边界。

git-worktree 提交先以创建时 HEAD 为基线，在临时 Git index 中采集 committed/staged/unstaged/untracked 的非忽略文件与 binary diff，不改成员 index；排除租约 marker。补丁写入、flush、原子发布到工作目录外后才允许 Domain submit 和回收。捕获失败（含旧 marker 缺少基线）拒绝提交并保留租约，供明确恢复；不丢弃错误继续回收。crash residue 必须扫描、标记和交给显式清理，不静默删除。

Workflow bridge、Jobs projection、human control 和 remote/distributed Provider 都是可选面：启用条件、能力缺失、owner 和 disposer必须可见。Jobs 是 Team task 的只读 projection，不注册或替换官方 `ctx.jobs` 写权威。

## 10. 错误与未知结果

协议错误使用稳定 code，至少区分：输入无效、身份/成员关系错误、revision/attempt 冲突、依赖未就绪、额度/预算拒绝、Provider/route 不可用、存储失败、权限拒绝、能力未配置和结果未知。

- 验证失败发生在写前时，状态零变化。
- durable commit 后通知失败时，返回未知结果并要求权威读回，不能重复写。
- 不可恢复启动失败保留诊断但释放可用容量或提供 fenced cleanup。
- UI/RPC 不把缺数据、stale、loading、offline 和 failed 混成同一个“不可用”。

## 11. 配置合同

配置唯一来源是 `src/plugin/config.ts`，在 DSH Settings → Plugins → dsh-agent-swarm 展示。主要组包括启用状态、Captain/Member provider+model、成员深度、scheduler/review、成员/任务/消息上限、workflow/jobs/execution-root 可选面、tool policy、Team Skills 和 prompt order。

设置修改按 restart 语义生效；Runtime 构造前读取已保存层并验证组合。空 Provider、非法 workflow 组合、非法 execution root、冲突 tool tiers 或错误 Skill 声明必须在任何 listener/store/member side effect 前拒绝。

## 12. 执行循环保护

`executionGuard` 默认开启，可在插件配置中显式关闭（restart 生效）。私有观察器只作用于 active Team 的当前 Captain 和 active/provisioning Member 的精确 Agent、Session、turn；失败、移除、归档及 `previousSessionIds` 历史身份不因此取得当前执行归属。它只折叠官方事件，不写 Team/task/attempt，不新增重试、重派或独立执行循环。

无进展证据分三类：官方结构化失败；`agent_swarm_list_memory` 和 `agent_swarm_list_private_memory` 的相同规范化请求及完整可观察结果再次出现；其他成功语义未知。每个读取请求身份独立比较：首次出现新参数或游标、同请求结果变化是进展；A/B 交替只有双方各自结果不变才累计无进展。未知成功及进展打断 terminal streak；不得解析任意业务数据里的 `success:false`，不得把并发安全当作只读，也不承诺理解任意第三方成功工具的副作用。

阈值为：相同请求和结果连续重复 10 次仅 WARNING；精确 UNKNOWN_TOOL 为 5/10 次 WARNING/CRITICAL；两请求交替无进展为 5/10 个完整周期 WARNING/CRITICAL；跨工具连续已证实无进展为 20/30 次 WARNING/CRITICAL。周期以两次调用为单位，ping-pong 的 10 周期中止先于 global 的 30 次兜底。Code Mode 使用真实子调用身份与持久 dispatch 事实；仅为缺失的结构化错误码短暂关联官方 tools/result，外层成功 run_code 不重复计数或掩盖内层失败。SDK 不存在的属性造成的 TypeError 不冒充 UNKNOWN_TOOL。

WARNING 在同 turn 下一次 `agent/pre-step` 通过正式 messages 投递，并由官方 Loop 写入 Session；排队不等于展示，不为通知额外开启 turn。拒绝、取消、卸载或 turn 结束后不投递旧提示。CRITICAL 在一个重新核对身份的 microtask 内调用官方 `Agent.cancel`，保留 inbox，Session 的 aborted/hook reason 为终止事实；不在 session/event 同步重入 append。提示仅包含检测类别、次数和建议，不回显工具参数、结果或私有内容。

单次生成另按 visible text 精确周期判定：单位 12–256 个字符，至少 16 次且 256 bytes 为 WARNING，至少 32 次且 512 bytes 为 CRITICAL。只看 text delta，不看 hidden reasoning；fenced code 排除，变化 prose 保持执行。这是明示启发式，不是语义理解。任意 chunk 边界逐字符折叠，包括巨大 chunk 的非重复前缀后重复后缀；达到 CRITICAL 即停止扫描。同一 stream 没有后续 step 时，不宣称 WARNING 已显示，使用终止 reason 证明中止。

每个 Agent 最多保留 128 个哈希观察，原始文本 ring 为 256 code points（低于 8 KiB），每字符计算有固定上界，总计算随输入长度线性增长。未完成 native/Code Mode 关联及 transport 标记各限 128，在结算、turn 结束或 disposal 清理；参数/结果哈希遍历限制 64 KiB、4096 节点和 32 层，超限视为不可比较，绝不比较截断前缀。注册统一归插件生命周期；跨 turn、Agent 替换、卸载均清状态。
