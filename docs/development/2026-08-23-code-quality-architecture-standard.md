# 代码质量与架构规范

状态：`APPROVED / IMPLEMENTATION_PENDING`

本文件属于《项目开发规范》的技术子规范，回答代码应如何组织、何时拆分、怎样控制复杂度和依赖。它不负责项目派工、角色审批、Git 状态机或发布流程。

## 1. 原则

1. 行数是维护风险信号，不是质量结论。文件短但依赖混乱、状态多源或副作用失控，仍然不合格。
2. 优先控制职责、复杂度、嵌套、依赖方向、状态所有权和副作用边界；达到行数告警后再结合这些事实决定是否拆分。
3. 新代码立即受控，存量代码采用基线递进收敛；不能为了启用规则而先做一次全仓大重构。
4. 抽象必须降低真实变化成本。不得只为满足行数、追求“通用”或猜测未来需求而增加接口、工厂或公共包。
5. 自动化只阻止新增的明确风险；模糊的设计判断由一次正常代码审查裁决，不再增加独立审批层。

规范用词：`MUST` 是候选必须满足的规则；`SHOULD` 是告警/审查触发器；`MAY` 是可选实践。

## 2. 渐进门禁

### 2.1 三类结果

| 结果 | 含义 | 对开发的影响 |
|---|---|---|
| PASS | 没有新增违规 | 正常进入候选 |
| WARN | 超过目标值或触碰存量债务 | 不自动阻塞；作者在证据包说明保留、拆分或延期理由 |
| BLOCK | 新增极端结构、非法依赖或不可豁免安全违规 | 结构类规则可修复或登记有期限例外；不可豁免规则只能修复 |

正式门禁的文件指标使用 scanner 固定定义的有效物理行（物理行减空行/纯注释），函数复杂度和行数使用固定 AST scanner。只统计人工维护的代码；生成代码、vendor、snapshot、锁文件、翻译表、声明文件、静态 schema/fixture 和迁移数据不计入行数门禁，但仍必须有生成/验证来源。

### 2.2 存量基线与触碰规则

2026-08-23 规划性物理行盘点（Swarm base `f091665`、Canvas base `1df3cb9`）：

| 仓库 | 生产代码文件 | `>350` 行 | `>600` 行 | `>1000` 行 | 最大文件 |
|---|---:|---:|---:|---:|---:|
| dsh-agent-swarm | 81 | 11 | 1 | 0 | 912 |
| dsh-canvas | 336 | 40 | 13 | 2 | 3127 |

- 现有超限文件不使无关候选失败。
- 在超限文件内修复缺陷、补类型或做等价重构可以继续；不得借机加入新的业务职责。
- 超限文件相对当前 ratchet 基线累计净增超过 30 个有效物理行时，MUST 同候选抽取职责，或登记例外和拆分任务；不能在每次提交后把计数归零。是否新增第二种变化原因不能由行数工具判断，它是 MEDIUM 审查触发器。
- 新文件、新函数和本次新增依赖立即适用 BLOCK 阈值。
- CI 只比较候选与固定 ratchet 基线的新增违规；正常合并不得自动抬高基线，指标下降时自动下调，指标上升必须满足触碰规则或登记例外。nightly 输出全仓债务趋势，不阻塞日常 LOW/MEDIUM 开发。
- BLOCK 启用前 MUST 生成机器可读 `governance/code-quality-baseline.json`，记录 repository/baseline commit、scanner/version/config digest、tracked-file include/exclude/generated 规则，以及稳定的 `debt_id + path/symbol + metric + approved exception`。rename/move 保留 debt ID，不能通过改名规避。
- 比较 base 是候选与权威 target main 的 merge-base；base/head 必须用同一 scanner。删除只减债；rename 继承原指标。新文件/新符号或本次首次跨越 BLOCK 才直接阻断；已超限符号不恶化则 PASS/WARN，累计净有效行增加 `>30` 或复杂度/嵌套继续恶化才要求拆分或例外。
- 上表只是发现问题的物理行盘点，不是门禁 baseline：扫描了所列 base 的 `*.ts/tsx/mjs/mts/js/ps1/sh/sql/css/py`，排除 `node_modules/dist/coverage/.worktree/ref` 和 test/spec/fixture/snapshot，但仍包含空行、注释、翻译表和静态表；命令是 ripgrep `--count-matches '^'`。正式启用前按固定有效行/AST 口径重生成表和 config digest。

## 3. 通用结构阈值

| 指标 | SHOULD 目标/告警 | BLOCK（仅新增代码） | 说明 |
|---|---:|---:|---|
| 生产源文件逻辑行 | `<=350` | `>600` | composition root、静态注册表可例外 |
| 测试文件逻辑行 | `<=600` | `>1200` | 优先按场景/fixture 拆分，不按每个测试机械拆分 |
| 函数/方法逻辑行 | `<=50` | `>100` | 声明式映射或表驱动代码可例外 |
| 圈复杂度 | `<=12` | `>20` | ESLint 默认复杂度阈值 20 只作为极端上界，不作为理想值 |
| 控制流嵌套深度 | `<=3` | `>4` | 优先 guard clause、策略表或提取纯函数 |
| 参数数量 | `<=3` | `>4` | 超过时优先命名 options object；不要制造无意义参数对象 |
| 可执行语句数/函数 | `<=30` | `>50` | 与函数行数和复杂度一起判断 |
| 单模块直接依赖 | `<=12` | 无统一硬值 | 超过即检查职责和层级，不按 import 数机械拆分 |

格式化后的单行长度由各包 formatter 决定，不另设跨语言重复门禁。URL、错误消息、正则、快照和不可分割标识符不得为了行宽破坏可读性。

## 4. 架构与模块化

### 4.1 依赖方向

默认层级：

```text
domain
  ^
application / use-cases + application-owned ports/contracts
  ^
adapters / infrastructure
  ^
host / RPC / UI composition root
```

- 内层 MUST 不导入外层；domain 不依赖 UI、进程、网络、文件系统、序列化格式或具体 provider。
- 外层 adapter 实现 application-owned port；application 只能依赖 port，不能导入 adapter。传输 schema 可以属于边界 contract，但不得把网络/provider 类型泄漏进 domain。
- 跨进程、跨仓、持久化、provider 和宿主生命周期必须经过稳定 port/contract；不得直接导入对方内部实现。
- UI 可以组合 application/view-model，但 domain/application 不得反向依赖 React、CSS 或浏览器对象。
- 通过 ESLint `no-restricted-imports` 或等价规则执行明确的非法依赖；不要建立一个需要维护完整架构数据库的重型系统。
- monorepo 包确有独立构建/发布/所有权边界时可用 TypeScript project references；只为缩短目录而拆包不成立。

### 4.2 模块合格条件

一个模块 SHOULD：

- 只有一个可描述的变化原因；
- 公共 API 小于内部实现面，默认不导出内部类型和工具函数；
- 依赖显式传入或从单一 composition root 组装；
- 对共享可变状态有唯一权威写者：其他模块通过 command 写、通过 query/snapshot 读，cache 不得成为第二真源；
- 提供明确且幂等的 start/stop/dispose 生命周期：部分启动失败逆序释放已创建资源；stop 先停止接收新工作，再 cancel 或 drain 在途工作；dispose 逆序释放子资源，owner 退出后不再接收命令或发布业务事件；
- 持久状态变化与待发布事件 MUST 在同一事务写入 state + outbox，或写入可重建的耐久日志，再异步发布。事件包含稳定 `event_id + entity_id + state_version`；消费者按 event ID 幂等、单实体按 version 有序。纯进程内通知可以在状态更新后发送，但不得承担持久业务事实；
- 错误、取消、超时、重试和幂等语义在边界定义，而不是散落到调用方猜测。

出现以下任一情况，应拆模块而不是继续加条件：

- 同一文件同时做协议解析、业务决策、I/O 和 UI 展示；
- 一个修改理由经常迫使不相关测试一起变化；
- 需要用大量布尔开关控制互斥模式；
- 为测试一个业务分支必须启动不相关的外部系统；
- 循环依赖、跨层深导入或多个模块同时写同一状态。

### 4.3 抽象化规则

满足下列任一事实才 SHOULD 抽象：

- 已有两个真实消费者，并且共享的是稳定语义而非偶然相似代码；
- 外部边界易变，需要 adapter 隔离 provider/transport/runtime；
- 需要明确测试缝、安全边界、生命周期或状态所有权；
- 同一业务规则已经在两个位置产生不一致。

以下理由单独存在时不得抽象：

- “以后可能复用”；
- 只为减少文件/函数行数；
- 只为套用设计模式；
- 两段代码表面相似但变化原因不同。

删除抽象的成本也要可控：优先小接口、纯函数和局部 adapter，谨慎引入继承层级、全局 service locator、万能 manager 或跨仓公共包。

## 5. 语言与工件配置

### 5.1 TypeScript / JavaScript / MJS

- MUST 使用模块边界；文件没有 `import`/`export` 时不应被误当作共享全局脚本。
- 新增公共函数、RPC、事件和持久化结构 MUST 有明确输入/输出类型；边界不得用未校验的 `any` 穿透。
- `unknown` 在边界校验后再收窄；禁止用类型断言掩盖不一致合同。
- 圈复杂度、嵌套、参数和函数行数采用 §3 阈值。
- 禁止跨包内部深导入、反向层依赖和 browser/server 混用；用 `no-restricted-imports`/package exports 执行。
- 多包构建只有在真实逻辑边界存在时启用 project references，不把每个目录都变成 package。

### 5.2 React / TSX

- render MUST 保持纯：同样 props/state/context 产生同样 JSX，不在 render 中改外部变量、发请求或写存储。
- 副作用优先由用户事件触发；确需 `useEffect` 时声明完整依赖并提供必要 cleanup。
- 一个组件只承担一个用户可见职责。数据获取/协议转换、业务状态机和大块视觉渲染不应全部留在页面组件。
- 状态更新分支变复杂时抽到 pure reducer；可复用行为抽 hook，跨进程行为留在 service/adapter。
- `>600` 行的新 TSX 文件或 `>100` 行的新组件函数 BLOCK；现有 3127/1635 行文件按 §2.2 逐触碰拆分。
- Canvas 官方壳层和插件主题层通过 tokens/view-model/slot 边界组合；禁止互相深导入组件内部或覆盖对方全局 CSS。

### 5.3 PowerShell

- MUST 运行 PSScriptAnalyzer；导出/公共函数使用 approved verbs，提交的自动化脚本不使用影响可移植性和可读性的 alias 或全局变量。位置参数限制适用于 PowerShell cmdlet 调用；原生 CLI 按其稳定参数合同执行。不得使用 `Invoke-Expression` 或明文秘密。
- 用户可直接调用且具有破坏性或显著外部副作用的入口函数使用 `SupportsShouldProcess`/`ShouldProcess`，并支持可验证的 dry-run/plan 或明确确认；内部 helper 接收已验证 plan/expected-state，不层层重复确认。
- 目标：脚本 `<=300` 行、函数 `<=50` 行；新脚本 `>600` 或新函数 `>100` BLOCK。
- 路径和外部输入使用 `-LiteralPath`/显式校验；错误应保留原异常和退出语义，不以成功文本掩盖失败。
- 外部输入不得拼接进 `Invoke-Expression`、`*-Command`、`cmd /c`、`sh -c`、`bash -c` 或其他二次解释字符串；优先直接调用可执行文件并使用结构化参数数组。必须使用解释器时，脚本文本固定，数据只通过独立参数传入。
- 递归删除、移动或覆盖前，MUST 将目标解析为绝对规范路径并验证位于明确允许根内；拒绝空值、未解析变量、通配符、文件系统根、用户目录和 workspace 根。不得在 PowerShell 枚举目标后交给另一 shell 执行破坏性操作。

### 5.4 Bash / Shell

- Shell 只用于小型封装和编排；超过 100 行或出现非直线控制流即 WARN 并评估迁移到结构化语言，新脚本 `>200` 行需例外。
- MUST 通过 ShellCheck；变量引用、路径和数组正确 quote，不解析 `ls` 输出，不用 `eval` 或 `sh/bash -c "$input"` 二次解释外部输入。外部值用数组、`--` 和独立参数传递；秘密不放入进程参数或日志。
- 在兼容的 Bash 脚本使用明确 shebang 和严格错误处理；严格模式是否启用由脚本调用语义验证，不能盲加后改变兼容性。
- 错误写 stderr；状态变更、清理和重试必须幂等或有 expected-state 防护。
- 临时目录用安全 API 创建；递归删除、移动和覆盖沿用 PowerShell 小节的绝对路径、允许根和危险目标拒绝规则。

### 5.5 SQL 与迁移

- 行数只作 WARN：单迁移 `>300` 行必须说明为何仍是一个原子意图，不设机械硬上限。
- 一个迁移只负责一个可回顾的 schema/data 变化；事务性、锁表/索引风险、向前兼容和失败恢复必须明确。
- 可逆迁移提供真实 down/rollback；不可逆迁移明确 safe-stop、备份和 forward-fix，不伪称可回滚。
- 数据值 MUST 参数化；动态表/列名、排序方向和 DDL 标识符只来自固定映射/严格 allowlist，并使用驱动的标识符引用能力，禁止直接插值外部值。
- migration 使用独立的最小必要权限身份，应用运行身份不持有 DDL 权限；设置适用的 statement/lock timeout。数据库不支持事务的 DDL 必须有分阶段恢复或 safe-stop。
- 迁移编号、执行顺序和已应用 digest 由工具维护。

### 5.6 CSS

- 目标文件 `<=400` 行；新文件 `>800` 行 BLOCK，但生成 tokens/vendor CSS 例外。
- 默认使用组件/主题作用域和 design tokens；限制全局 selector、`!important` 和跨宿主覆盖。
- 官方 DSH 壳层与插件自定义界面各自拥有主题边界，共享 token 合同，不共享任意 selector。
- 视觉变更仍按项目开发规范执行浏览器截图、交互和必要 a11y，不能用 lint 替代真实 UI 证据。

### 5.7 JSON / YAML / Markdown / Schema

- 不设行数门禁；重点控制 schema、唯一事实来源、稳定 key、secret 泄漏和消费者验证。
- 动态项目状态不得复制到多份 Markdown/JSON；一个权威源，其余为生成视图或链接。
- JSON/YAML 输入必须经过 schema validator 和正反 fixture；只提交 schema 文件但没有真实消费者不算完成。

### 5.8 Python（当前仅孤立工具）

- 遵循 PEP 8 和仓库 formatter/linter；formatter 的统一输出优先于人工争论行宽。
- 结构阈值沿用 §3；脚本从孤立工具成长为长期服务前，必须补 package、类型、测试和生命周期边界。

### 5.9 工具接入矩阵

| 语言/工件 | 当前路径与事实 | 固定工具目标 | 启用规则 |
|---|---|---|---|
| Swarm TS | `src/**/*.ts`、`tests/**/*.ts`；已有 Oxlint/TypeScript/Vitest | 锁文件固定 Oxlint + AST metric scanner | 配置校准后两个候选周期 WARN，再对新增违规 BLOCK |
| Swarm MJS/脚本 | `scripts/**/*.mjs`；当前 Oxlint 明确忽略 `*.mjs` | 将 maintained MJS 纳入 Oxlint 或等价 ESLint；生成/第三方继续排除 | 工具接入前仅 WARN |
| Canvas TS/TSX/JS | `web/server/canvas-agent/packages/plugins`；当前只有分散 build/typecheck/format，未统一 lint | 每个 affected package 固定 formatter、TypeScript、lint/AST 版本并登记矩阵 | 对应 package 接入前仅 WARN，不得宣称 BLOCK |
| PowerShell | maintained `*.ps1` | 锁定 PSScriptAnalyzer 模块版本 | 接入 affected gate 前 WARN |
| Bash/Shell | maintained `*.sh` | 锁定 ShellCheck 版本 | 接入 affected gate 前 WARN |
| Python | maintained `*.py` | 项目选择并固定 Ruff/等价工具版本 | 接入 affected gate 前 WARN |
| SQL/migration | `*.sql` 和迁移 runner | formatter/validator + 真实 migration dry-run/fixture | 仅受影响迁移启用；高风险语义仍按 HIGH |
| JSON/YAML/schema | 运行时、跨进程/跨仓或不可信输入 | 项目 schema validator + 正反 fixture | 工具原生配置只需其官方 parser/validator，不强制另造 schema |

所有工具只检查 changed maintained files，并排除 `ref/vendor/generated`。工具名、精确版本、配置 digest 和 package 路径进入 verification matrix；没有实际接入的 `MUST/BLOCK` 只能作为设计目标和 WARN，不能写成“门禁已生效”。

## 6. 代码评审检查面

正常 MEDIUM/HIGH 的一次代码审查同时覆盖以下项目，不另设“架构审批会”：

1. 正确性：成功、失败、取消、重试和并发路径是否成立；
2. 边界：依赖方向、合同、状态 owner 和生命周期是否清楚；
3. 复杂度：新增函数/文件是否越过阈值，是否混入第二职责；
4. 抽象：是消除真实变化风险，还是只增加间接层；
5. 可验证性：测试是否走真实入口，声明是否与证据等级一致；
6. 安全性：输入校验、凭据、权限、命令/SQL 注入和破坏性动作；
7. 可运维性：错误、日志、幂等、恢复和兼容语义。

LOW 仍只需作者自证和 affected checks；若 lint 发现 BLOCK 或修改架构边界，自动升级 MEDIUM。

## 7. 例外

普通例外只适用于 `waivableRules`：行数、复杂度、模块拆分和数值型结构规则。明文秘密、命令/SQL 注入、未校验破坏性路径、身份/权限绕过、保护/发布门禁属于 `nonWaivableRules`，不得通过普通例外放行。

例外以机器可读 `governance/code-quality-exceptions.json`（或 provider 中等价的受保护 exact-head 记录）随候选保存，不建立永久白名单。它至少包含：

```text
rule + path/symbol
base SHA + exact candidate head SHA
allowed metric/delta（只能豁免指定指标和增量）
reason
why split/repair is riskier now
owner
expiry date or removal milestone
verification that contains the risk
non-author reviewer + verdict
```

新增或修改例外自动至少升级 MEDIUM，由非作者批准；候选作者不能批准自己的例外。涉及真实安全边界但不属于上述禁豁免行为的必要偏离升级 HIGH，并记录补偿控制和负例测试。

结构例外到期只阻止继续扩大该违规，不要求为了关一个无关缺陷先清完整历史债务。重复续期两次必须由主脑决定拆分、接受为数值/结构项目约定或调整不合理阈值；`nonWaivableRules` 永远不能转成项目约定。安全偏离到期后阻断受影响路径继续发布。

## 8. 实施顺序

1. 只读生成当前 baseline，不改业务代码。
2. 在 changed-files lint 中启用格式、非法 import、复杂度、嵌套和参数规则；先 WARN 两个候选周期。
3. 修正误报后，仅将新增极端违规切为 BLOCK。
4. 为 Canvas 最大两个页面建立按职责拆分的债务条目，但不阻塞无关 UI。
5. nightly 报告债务趋势；连续无价值告警的规则应删除或调阈值。

## 9. 参考依据

- TypeScript 官方模块与 project references：模块作用域、逻辑拆分和大项目构建边界。
- ESLint 官方 `complexity`、`max-lines`、`max-lines-per-function`、`max-depth`、`max-params`、`max-statements`、`no-restricted-imports`：数字是可配置启发式，不是客观质量定律。
- React 官方 purity 与 reducer 指南：render 纯度、副作用位置和复杂状态逻辑提取。
- Microsoft PSScriptAnalyzer 规则建议：PowerShell API、状态变更和危险语法约束。
- Google Shell Style Guide 与 ShellCheck：Shell 只做小型工具、复杂脚本迁移和静态分析。
- Python PEP 8 与 JSON Schema 官方参考：语言一致性和结构化输入验证。

具体链接：

- <https://www.typescriptlang.org/docs/handbook/modules>
- <https://www.typescriptlang.org/docs/handbook/project-references>
- <https://eslint.org/docs/latest/rules/complexity>
- <https://eslint.org/docs/latest/rules/max-lines>
- <https://eslint.org/docs/latest/rules/max-lines-per-function>
- <https://eslint.org/docs/latest/rules/max-depth>
- <https://eslint.org/docs/latest/rules/max-params>
- <https://eslint.org/docs/latest/rules/max-statements>
- <https://eslint.org/docs/latest/rules/no-restricted-imports>
- <https://react.dev/learn/keeping-components-pure>
- <https://react.dev/learn/extracting-state-logic-into-a-reducer>
- <https://learn.microsoft.com/en-us/powershell/utility-modules/psscriptanalyzer/rules-recommendations>
- <https://google.github.io/styleguide/shellguide.html>
- <https://www.shellcheck.net/>
- <https://peps.python.org/pep-0008/>
- <https://json-schema.org/understanding-json-schema/reference>

## 10. 退出标准

- 新增极端超大函数/文件、非法跨层 import 和未校验边界可被 changed-files gate 发现；
- 存量超限不会阻塞无关开发，但新增职责不能继续堆入；
- 两仓使用同一通用规则、各包只维护必要 formatter/linter 差异；
- 抽象、模块和架构有可审查条件，不靠个人偏好；
- 规则告警量可控，没有重复审查或为数字而重构；
- 任何例外都有 owner、期限和风险收敛证据。
