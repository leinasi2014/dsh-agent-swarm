# 03. Team 总体架构与能力边界

本文件是 Team 总体架构与 capability ownership 的唯一说明。具体状态机、错误和并发合同以 [04-core-protocol.md](04-core-protocol.md) 为准；界面结构以 [10-team-ui-layout.md](10-team-ui-layout.md) 为准。下文区分已有实现、接入约束与后续设计；设计图不证明某个安装环境已完成验收。版本身份读取 [OFFICIAL_BASELINE.json](OFFICIAL_BASELINE.json)，部署与验收结果留在对应候选和真实运行证据中。

## 1. 组合图

```text
Official DSH execution plane
  Session + Agent + Subagent + Tools + System Prompt
  Workflow + Jobs + Storage Domain + Settings + Client slots
                              │ consumed by
                              ▼
AgentSwarmRuntime
  ├─ TeamDomainPort ── StorageDomainTeamStore
  │    Team / Captain binding / roster / tasks / attempts / mail / budget
  ├─ orchestration Providers
  │    Scheduler / Review / Workflow bridge / execution root / permission
  ├─ model Consumers
  │    role-scoped agent_swarm_* tools + ordered usage prompt
  ├─ read producer
  │    Host binding → /swarm/v1 read RPC
  └─ client Consumers
       Team Workbench V3 + Plugin Settings
```

`TeamDomainPort` 是 Team 协作的唯一 mutation 边界。Human-interaction overlay、workflow run overlay 和 member-private-memory domain 只拥有自己的关联数据，不复制 Team aggregate。

### 1.1 用户、会话与执行关系

```mermaid
flowchart TB
  User[用户] --> Main[Main Brain / 根 Session]
  Main --> CaptainA[Team A 的 Captain / 独立 continuable Session]
  Main --> CaptainB[Team B 的 Captain / 独立 continuable Session]
  CaptainA --> MemberA[成员 A / 个人执行 Session]
  CaptainA --> MemberB[成员 B / 个人执行 Session]
  CaptainB --> MemberC[成员 C / 个人执行 Session]
  CaptainA -. 协作状态 .-> TeamA[Team A aggregate]
  MemberA -. 当前 attempt 与提交 .-> TeamA
  MemberB -. 当前 attempt 与提交 .-> TeamA
  TeamA --> Read[Host 验证绑定并投影]
  Read --> UI[官方右侧栏 Team 页签]
```

Main Brain 负责跨 Team 的用户入口；Captain 在自己的 Session 中统筹单个 Team；成员的模型调用、工具执行和结果保留在各自 Session。Team 是协作域对象，不是另一份聊天历史。成员间邮箱消息可以进入收件人的官方模型上下文，但不能把多个个人 transcript 拼接成 Team 的权威群聊。

### 1.2 权威与投影

| 数据或动作 | 唯一权威 | 允许的投影与边界 |
|---|---|---|
| 模型请求、工具调用、会话模型选择 | 官方 Session log / Agent / model selection | UI 可展示已记录事实；Team 初始路由不能覆盖会话当前选择 |
| Team、成员绑定、任务、attempt、邮箱、预算 | `TeamDomainPort` 与官方 `agent_swarm` Storage Domain | Host/RPC/UI、prompt 与 Jobs 只消费对应 projection |
| 子会话地址、父子关系、导航和后代计数 | 官方 Subagent catalog / Sessions service | 插件核验归属并替换显示文字；不生成地址或自算官方计数 |
| Settings 默认值 | 官方 SettingsScope 与插件 config | provider/model 成对保存、回读，在重启后重新组合 runtime |
| 面板是否展开、选中页签及宿主布局 | 官方 SidebarRight；插件只保存必要的 UI 选择 | 页面刷新不重开用户已关闭的页签；选择状态不构成读写权限 |
| 成员工作文件 | execution-root Provider 的当前租约 | 绑定真实工具 cwd/FS capability；不是 Prompt 路径，也不是仓库开发 writer 分配 |

UI 的 controller 复用同一个只读目标和读取生命周期。姓名、状态、进度或页面是否可见都不能反向改变 Team 权威。

## 2. 当前实现

| 能力 | 当前 owner / seam | 已实现边界 |
|---|---|---|
| Main Brain → Captain | official Session/Subagent + dedicated captain provisioning | 默认 managed Team 创建独立 Captain；可选 staged 计划审批后激活；root 留在 Team 外；支持多个 Team |
| Team state | `TeamDomainPort` → `StorageDomainTeamStore` | versioned aggregate、durable commit、显式迁移；legacy file store 只读 |
| 成员与身份 | official continuable subagent + identity context | 招募前校验 route；队长分配职责/职业，各人自定四项资料并在保存读回后绘制头像；当前资料进入官方 prompt，durable descriptor 支持恢复 |
| 任务 | Team domain + `AgentSwarmRuntime` | DAG、priority、target member、revision CAS、attempt fencing、submit/review/reassign |
| 调度 | Scheduler Provider registry | 默认 priority-ready；adaptive 与 workflow run 保持单一 transition owner |
| 审核 | Review Provider registry | manual、executable commands/templates、review root 与 reviewer boundary |
| 邮箱与交流 | durable Team mailbox + wakeup surface | quota、receipt、quiet/wakeup、真实 reply_to、按成员限制主动同伴唤醒、队长持久覆盖、bounded wait 与 spin fuse |
| 预算 | Team budget + committed usage fold | token/request/retry 限制、reservation、carry、exhaustion/recovery |
| Skills | `TeamSkillSurface` + `allowedSkills` setting | 三层区分（issue #184）：Team allowed（不可变策略）/ member assigned（招募时子集，持久化+重启重建，进一步收窄 surface）/ Session-visible（官方 scoped catalog，仅可见不等于拥有）；不自动演化 Skill |
| Tools | official tool restriction + plugin permission surface | Captain-only 隐藏、成员 deny-only 收窄、plugin allow/ask/deny setting |
| Memory | Team memory + private-memory domain | 共享分类记忆；成员私有 append-only memory 和独立授权 |
| Workflow/Jobs | official Workflow bridge + caller-scoped jobs projection | 可选、显式启用；唯一 Consumer seam 是 `ctx.agentSwarmWorkflow.start(request)`，仅委托同一 bridge，不提供激活/销毁权限；disabled/unload 时服务缺席，默认官方 `workflowEngine` 不变。`runtime.workflowBridge` 是内部实现细节；jobs 是 read projection，不影子注册官方 producer |
| Execution root | execution-root Provider | 可选 per-attempt 物理 root、capability 声明、settlement 和 residue 告警 |
| Host/RPC | Host read service + `/swarm/v1` | target-bound、bounded、redacted、read-only、loopback/same-origin fail-closed |
| UI | official Client slots / Session navigation / Settings | Workbench、Tasks、Announcements、Management、栏内详情、Captain Chat、设置页 |

## 3. 模型工具面

`src/tools/index.ts` 汇总当前 `agent_swarm_*` 工具，按职责分组；各 caller 只看到其权限允许的面：

- Team lifecycle：create/create-managed、identity、goal、announcement、member、archive、interrupt。
- Task board：create、claim、submit、review、reassign。
- Plan-first：set-plan、approve-plan、discard-plan。
- Collaboration：send-message、set-communication、wait。
- Budget and memory：set-budget、shared memory、member private memory。
- Read surfaces：status、managed teams、members、tasks、jobs、memory。
- Policy helpers：逐次工具审批；运行时按 caller role、live Agent/Session、revision 和 attempt 过滤权限。

工具只暴露 Team 概念，不暴露 Storage key、内部 Session token 或 Provider 私有状态。授权来自 `exec.agent` 和权威绑定；参数中的 id 只是查找条件。

## 4. Host、RPC 与 UI

Host 每次从 live root Agent、Session、workspace scope 和 Team Captain binding 建立读上下文。`/swarm/v1` 只发布严格、版本化的 read envelope；客户端不能上传 principal、Captain Session 或 provenance 来扩大权限。

Workbench 消费同一 read contract：公开目标、成员身份、任务/attempt、budget 和 activity 来自权威 projection。布局、卡片层级、页签、详情、短名称、窄屏与错误展示统一定义在 [UI 布局设计](10-team-ui-layout.md)，不在本文件维护第二套视觉规则。

SidebarRight 拥有展开、浮动、分栏及可见性；插件通过 `openTabIn` 寻址选中的 Session，以实际页签挂载确认显示。成员导航复用官方 continuable child catalog，精确父子地址和每次读取的权限验证见 [核心协议](04-core-protocol.md)。管理页的交流强度请求进入正式 Captain human prompt，由队长调用工具保存，canonical read-back 决定应用状态；`/swarm/v1` 的 direct write capabilities 仍 unavailable。

Plugin Settings 是独立的官方 Settings Consumer。它配置默认模型、成员 provider/depth、Skills、Scheduler/Review、tool policy、默认交流强度、Workflow/Jobs/execution roots 和资源限制；设置在重启后重新组装 runtime。队长保存的本队交流覆盖立即持久生效，清除覆盖后跟随插件默认。

默认模型选择读取官方 remote Session catalog；provider/model 成对以 SettingsScope `mutate` 提交并回读。路由优先级为调用显式参数、插件默认、发起者当前 Session request header。`create_managed` 支持 `captain_llm_provider`、`captain_model`、`captain_reasoning_effort`；成员招募和计划审批支持 `llm_provider`、`model`、`reasoning_effort`。同路由省略推理等级时继承发起者当前等级，换路由时使用新模型默认；显式等级由目标模型验证。即时创建和 staged 审批均在 Team 提交中保存初始路由，启动失败后恢复不会改用后来的默认值。

身份详情展示 durable personality/biography，成员自行更新姓名、性格、简介与头像；Captain 的成员资料管理限于职责和职业。当前资料及有效交流策略共同构成 prompt 快照，不重写历史。

独立 managed Captain 可调用 `agent_swarm_set_captain_model` 修改自身后续请求的模型，不中断当前请求，不修改插件或全局默认。选择保存在该 Captain 自己的官方 `model/selection` 会话事件中，由官方 projection 与 `installModelSelection` 恢复；继承的父会话历史不能覆盖子会话的初始路由。此入口要求 Host 提供官方模型选择 projection；legacy 根 Captain 继续使用 Host 模型选择器。Team 内的 `captainRoute` 只保存初始创建意图，当前使用的模型以 Session 请求记录为准。

### 4.1 创建与执行链路

```mermaid
sequenceDiagram
  participant Main as Main Brain
  participant Tool as Swarm Tool / Runtime
  participant Domain as TeamDomainPort
  participant DSH as 官方 Session / Subagent
  participant Captain as Captain
  participant Member as Member
  Main->>Tool: create_managed(目标, 可选 Captain 路由)
  Tool->>Tool: 验证 caller、目录与有效路由
  Tool->>Domain: 保存 Team 与初始创建意图
  Tool->>DSH: 按持久意图创建独立 Captain
  DSH->>Captain: 启动独立请求
  Captain->>Tool: 招募成员、创建任务与依赖
  Tool->>Domain: 提交 roster 与任务
  Tool->>DSH: 组合 continuable Member
  DSH->>Member: 当前 attempt 的工作
  Member->>Tool: submit(证据, 当前 attempt)
  Tool->>Domain: 审核前 submitted
  Captain->>Tool: 发起配置的 Review
  Tool->>Domain: 按 Review 结果接受或 rework
```

此图表示行为顺序，不额外定义跨服务事务。启动、重试、回滚与部分失败服从现有 provisioning 和 Domain 合同；提交证据只进入 submitted，不能由 UI 或自然语言直接变为 completed。staged Team 的计划批准是独立入口，必须在激活前验证并保存相应路由。

### 4.2 模型路由的两个时点

| 时点 | 决策路径 | 检查结果的依据 |
|---|---|---|
| 新 Captain / Member 创建 | 显式调用参数 → 插件该角色默认 → 发起者当前 Session；校验 provider/model 与 effort 后持久保存创建意图 | 首个实际请求的 `request/header` |
| 独立 Captain 自行换模型 | caller 必须是当前绑定 Captain → 官方模型 resolver 验证 → 写入该子会话的官方选择事件 | 下一次实际请求的 header 与冷恢复后的请求 |

两条路径不互相替代。设置页保存成功、工具返回成功、初始路由字段和模型实际生效，是不同证据。更换路由时推理等级的继承与默认规则继续服从本节已有合同。

### 4.3 UI 接入与官方扩展边界

Swarm 使用官方 Session 导航、SidebarRight、Settings、locale 和 slots。会话顶部文字通过通用 `conversation.session.header.lineage.display` seam 接入；Core 提供实际 owner、原始文字、地址与计数，Swarm 只返回文字显示。该 seam 属于需要随目标 Core 交付和核验的扩展，不能据此声称某个官方已发布版本自带这项能力。

显示 Consumer 不替换 Core 的导航控件、可访问性语义或事件处理；插件缺失、关系未知或数据陈旧时沿用 Core 原始文字。安装包构建成功不能证明 Host 使用了对应 Core seam，须结合实际包导出、装配和浏览器结果验收。

## 5. 生命周期与失败语义

- `sessionPersistence` 和 `storageDomain` 是 required injection；缺失时插件保持 pending，不降级为易失状态。
- 未知 Provider、无驱动的 workflow mode、非法 Skill/tool policy、stale revision/attempt 和 identity mismatch 都 fail loud。
- 注册、route、listener、timer、waiter、subagent、workflow、storage domain 和 React mount 均由 Cordis effect 或显式 disposer 回收。
- unload 先关闭 admission，再收敛在途事务，最后释放资源。
- Workflow bridge 恢复在局部 store/domain 上完成后才发布；恢复失败按 store → domain 回收，保留原始和清理错误。同域可重试；正在打开资源时的 unload 等待该次 activation 回收，不留下部分激活的句柄。
- legacy Team import 只允许显式单向迁移、空目的地和 durable read-back；不自动迁移、双写或 fallback。

## 6. 尚缺能力

| 缺口 | 所需边界 |
|---|---|
| 公共稳定发布 | immutable package identity、兼容矩阵、upgrade/rollback、发布观察 |
| browser/RPC direct controls | verified human principal、operation-scoped idempotency/read-back、逐 capability 开放 |
| Canvas Consumer | 复用已接受的 RPC schema/fixtures，Canvas 只做宿主原生投影 |
| 远程成员与 distributed store | real remote executor、CAS/lease/fencing、partition/late-ACK/recovery tests |
| 自动 Skill Evolution | accepted evidence → proposal → deterministic validation → approval → write 分权 |
| 发布级 UX/E2E | fresh Profile、多 Team、重启、accessibility、error/reconnect、卸载/升级矩阵 |

缺口不能通过新增 UI 状态、第二 storage、transcript parser 或更宽模型权限绕过。

团队公共群聊属于独立的产品方向，其边界与待讨论布局见 [UI 布局设计第 8 节](10-team-ui-layout.md#8-待讨论团队公共群聊)。采用该方向前，需要在核心协议中定义消息权威、写入身份、幂等、投递与重启语义；现有邮箱和个人 Session 不自动等于可编辑的公共群聊。

### 6.1 公共群聊的候选架构

本节是功能设计的架构约束，尚未新增群聊 API、消息存储或调度器；不更改现有 `/swarm/v1` 只读合同。功能范围见 [产品设计](00-vision.md)，界面与交互见 [UI 第 8 节](10-team-ui-layout.md#8-待讨论团队公共群聊)。

```mermaid
flowchart TD
  Input[群聊输入：文本、稳定身份提及、图片] --> Gate[Host：用户身份、Team归属、附件与接收人验证]
  Gate --> Image[官方 Attachment admission / 不可变图片引用]
  Image --> Public[单一 Team 公共消息追加边界]
  Public --> View[群消息与投递状态投影]
  Public --> Outbox[关联原消息的 durable 定向投递]
  Directory[同队共享资料与实时能力目录] --> Project[官方请求投影与群消息协作引用]
  Outbox --> Project
  Project --> Personal[官方个人 Session / Agent]
  Personal --> Assist[成员自主发起视觉协助请求]
  Assist --> Validate[Host重验同队、可用性、图像能力与附件权限]
  Validate --> Vision[视觉成员的官方 Session]
  Vision --> Result[带原消息与图片来源的协助结果]
  Result --> Public
  Result --> Personal
  Personal --> Task[现有任务提交与 Review Gate]
  Task --> View
```

公共消息只有一个耐久记录入口。优先作为 `TeamDomainPort` 现有协作域的扩展，沿用官方 Storage Domain 和提交后发布原则；不建立可独立修改的平行聊天数据库。个人 Session 保存模型实际收到的输入及执行历史，公共消息是显式发布的协作记录，两者通过 ID 关联，不拼接多个 transcript。大规模消息需要分页时可调整内部存储形式，外部 mutation owner 仍保持唯一；具体 schema 必须在实现前纳入核心协议。

| 事实 | 唯一来源或候选 owner | 必需关联 |
|---|---|---|
| 公共消息 | Team 公共消息追加边界 | `teamId`、稳定 `messageId`、发送人身份、`replyTo`、顺序、时间、提及成员 ID、附件引用 |
| 接收与模型消费 | 现有 durable 邮箱及官方 Session 事件 | 原消息、接收人、投递 ID、实际消费事件；全员可见不表示全员已消费 |
| 图片 | 官方 Attachment 服务 | 不可变 `ImageAttachmentRef`、内容完整性与授权访问；不以本地路径或外部 bearer URL 作为转交权限 |
| 共享队员目录 | Team identity / roster 加官方成员组合、Skills 与 LLM 能力的只读投影 | 稳定成员 ID、目录 revision、各来源更新时间与完整性 |
| 视觉协助 | 原接收人的受控协作请求，经 Host 验证与耐久投递 | 原消息、图片 ID、发起人与视觉成员、协助 request ID、回报 ID、到期和已访问成员 |
| 任务、审核、模型选择 | 现有 Team 任务/attempt、Review Gate 与官方 Session model selection | 协助只是来源关联，不暗改任务 owner、审核权或模型 |

公开消息提交与投递意图必须可从耐久状态重建。图片先经过官方 admission；附件失败时整条消息不标记成功。提交时冻结 `teamId`、接收人 ID、附件引用与草稿版本；异步完成只更新原群与原草稿，不随用户当前选择改变目标。公共消息已提交而投递尚未完成时显示排队，恢复过程按 `(messageId, recipientId)` 幂等补投；重试上传、发送、协助和公开结果均保留同一逻辑请求身份。消息顺序来自耐久提交，不采用客户端时钟决定先后。

### 6.2 共享队员目录与能力判定

每个成员在首次加入、恢复及目录改变后的下一次处理前，获得同队完整共享目录。每个条目包含稳定 ID、名称、职责、职业、性格、简介、Skills 名称及用途、assigned 与 Session-visible 状态、工具可用/需批准/禁用信息、当前 provider/model、图像能力、成员阶段、当前任务及更新时间。UI 资料卡、`@` 候选和 Agent 可读目录消费同一个受验证投影，不各自猜测或维护姓名缓存。

正常规模的 Team 将上述核心字段纳入每次适用的上下文快照；较大团队采用完整目录的分页读取及明确的未读范围，不能静默截断后声称已知所有队员。Skill 正文通过已有授权读能力按需获取，目录提供用途和可见性，不将分配某 Skill 等同于已学会、已使用或有权调用全部相关工具。成员私有记忆、凭据、系统私密内容与原始工具秘密参数不进入目录；队员资料作为协作数据，不获得系统指令权限。

图像能力读取目标 Agent 当前解析模型的官方 `inputModalities`，并与实际组合/权限一起确认：包含 `image` 为已声明支持，明确省略为不支持，字段缺失为未知。不得依据模型名称、职业、性格或自我介绍猜测。派发协助时重新核验目录 revision 与成员当前状态；模型变更、成员退出或权限撤销会使旧能力判断失效。

### 6.3 非视觉成员的自主图片转交

1. 用户发给非视觉成员的群消息先保留完整文字和已提交图片引用。复用官方请求投影：固定 alpha.2 的 `projectImagesForTextModel` 会把明确仅支持文本的模型请求中的图片转为文字占位，耐久消息仍保留原图。群聊补充可申请协助的受控消息/附件引用，不重写官方投影，也不伪造图片内容描述；官方占位中的短摘要不能作为附件授权凭据。能力未知须确认或走明确待确认状态，不能按已支持图片发送。
2. 原接收人读取共享目录，选择同队可用且图像能力已确认的成员，调用拟新增的视觉协助 capability。Host 验证发起人、Team、接收人、原消息可见性与附件访问权，并从原消息解析图片；模型不能提交任意路径或伪造附件引用越权读取。
3. 视觉成员通过官方 Attachment/Session 通道实际收到图片及明确问题。协助结果引用原消息和图片，公开摘要进入群聊，结果定向回到原接收人；原接收人继续负责自己的任务。
4. 同一协助请求复用不可变图片，保留稳定请求与结果 ID；限制重复/并发重试，记录已访问成员，初始方案禁止协助对象继续链式转交同一请求。无可用视觉成员、能力未知、超时或内容不可读时公开明确状态，由原接收人/Captain 决定下一步，不反复互相唤醒。
5. 图片协助不会自动招募新成员、切换原成员模型、扩大工具权限或接受任务。是否以后允许 Captain 受预算约束补充视觉成员，另作扩展。

当前固定 alpha.2 已有官方图片附件类型、上传/Composer 扩展、模型 `inputModalities` 与文本模型图片占位投影；读取证据入口为 `packages/attachment/attachment/src/types.ts`、`packages/client/file-upload/src/types.ts`、`packages/client/ui-conversation/src/client/apply.ts`、`packages/llm/llm/src/types.ts`、`packages/llm/llm/src/index.ts`、`packages/llm/llm/src/content.ts`。其中 file upload receipt 具有接收 Agent scope，不能直接复用到另一个 Agent。群聊转交仍需实现 Host 授权与官方图片输入组合，并用真实模型、图片和冷恢复验收；不能因这些底层能力存在就声称转交已可用。本轮将视频排除于产品设计范围，不据此扩大为所有 DSH 版本的能力结论。

### 6.4 发言模式扩展与验收边界

队长协调、轮流发言、自由发言属于未来 admission/scheduling policy，必须复用同一个任务/消息投递 owner。它们不等于 UI 刷新频率或现有交流强度；公开范围、任务状态与模型消费事实保持独立。轮流模式需持久轮次与发言权，自由发言需公平性、预算、结束条件及回应风暴抑制；切换要验证权限、revision 和在途工作边界。此轮只记录扩展，不注册 mode runtime 或假造生效状态。

代表性设计验收覆盖：同名/改名/退出成员的 `@`、中文输入法与键盘、多提及去重、图片独立发送与上传失败、切 Team 草稿隔离、非视觉原接收人自主选择视觉成员、未知/撤销能力、零视觉成员、协助去重与责任保持、目录变更后成员读到新资料、关闭页面和冷恢复后原消息/图片/结果仍可追溯。原型交互、静态设计、真实模型、持久化及正式部署分别记证据。

## 7. 拆包原则

当前实现保持一个 dual-face package。只有出现第二 Provider/Consumer、独立 lifecycle、独立发布价值或 host/client 编译边界时才拆分；目录整齐本身不是理由。未来官方 Agent Team 成为受支持依赖时，也只能在 `TeamDomainPort` 后替换 Provider，不能并存两个可写 Team authority。

### Host 定向读取与枚举成本

`HostTargetReadService` 统一解析 live/cold Session、Captain 父子关系、scope 和可见 Team，服务 snapshot/page、Captain sections、Team selector 与 Skill catalog。RPC 只处理传输信任、严格解析及响应投影；不直接读取 Team store/snapshot 或成员/Skill Registry。每次 selector 读取从一次 canonical aggregate list 投影完整 Captain identity 和 public goal，不建立跨请求缓存或索引。

尚未创建 Captain 的 staged Team，以及显式 discarded 的草稿归档，以同 scope 内的持久 `managedOrigin` 精确证明所属 Main Brain。读取仍要求官方 live 或持久化 root Session，child 与其他 root 不继承草稿。Selector 保留真实的空 `captainSessionId`；binding、snapshot/page 和三个 Captain sections 使用所属 root 作为读取锚点，UI 明示队长尚未创建并禁止 Captain Chat 交接。该只读路径不批准计划、不创建 Session，也不放宽 active Team 的 Captain 绑定。

`tests/host-read-scale.spec.ts` 在真实 Storage Domain 上覆盖多个 Team、成员规模及任务历史，要求同一次 teams RPC 只执行一次 canonical aggregate list，成员及任务历史不进入 selector payload。操作计数不等于延迟或全部 UI 流量承诺；可选 `SWARM_READ_BASELINE` 仅用于对接受基线进行只读比较。

## 8. 实现与验收入口

| 架构入口 | 源码 |
|---|---|
| Team mutation 与持久化 | `src/domain/team-domain-port.ts`、`src/storage/storage-domain-team-store.ts` |
| 独立 Captain 与初始组合 | `src/runtime/dedicated-captain-provisioning.ts` |
| Captain 会话模型选择 | `src/tools/model-selection.ts`、`src/runtime/captain-model-selection.ts` |
| durable 邮箱 | `src/domain/team-domain-mailbox.ts` |
| UI 组合与生命周期 | `src/client/team-dashboard-plugin.ts`、`src/client/team-dashboard-controller.ts`、`src/client/team-dashboard-surface-coordinator.ts` |

工程门、真实 Profile、冷恢复与发布验证沿用 [08-testing-verification.md](08-testing-verification.md)；升级与回滚分权沿用 [13-self-hosting-dogfood.md](13-self-hosting-dogfood.md)。检查必须对应同一可识别候选和安装组合，工程、真实模型、浏览器、重启与正式环境证据分别陈述。
