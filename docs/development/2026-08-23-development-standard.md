# 项目开发规范

状态：`APPROVED / IMPLEMENTATION_PENDING`

本文件只回答：代码如何隔离、验证、冻结、审查、合并、复验、镜像、发布和回收。角色、派工、风险、WIP 与复审策略见《项目管理与多智能体治理规范》；代码规模、复杂度、抽象、模块和依赖边界见《代码质量与架构规范》。

配套技术规范：[代码质量与架构规范](2026-08-23-code-quality-architecture-standard.md)。其数值采用 changed-files 基线递进，不得把存量超限变成无关开发的全仓阻断。

## 1. 开发权威与预检

- 206 Git 服务是唯一开发权威，`main` 是唯一集成分支。
- GitHub 默认只异步镜像权威 main，不镜像候选和 tags。
- remote URL 不得包含凭据；认证使用 OS credential manager/CI secret store。
- 每次开工读取 Git root/common-dir、main/upstream、远端漂移、工作树和 provider capability binding。
- 当前仓库没有已接受的 worktree/merge 门禁时，只允许根树单写者 bootstrap。

## 2. worktree

唯一布局：`<repo>/.worktree/<task-slug>`。

统一入口：

```text
node scripts/governance.mjs open <task-id>
node scripts/governance.mjs status [<task-id>]
node scripts/governance.mjs close <task-id> --outcome integrated|archived
node scripts/governance.mjs reconcile
```

`open` 校验 main/upstream/clean/base/branch/target/common-dir/slug/path budget，不允许 sibling、自选目录、detached、foreign common-dir 或 symlink/junction 逃逸。

`close` 顺序：

```text
persist pre-cleanup intent
-> idempotent worktree unregister/remove
-> local branch retire/retain decision
-> persist cleanup-result receipt
-> CLOSED
```

pre-cleanup intent 不能当成功结果。脏树、未知 untracked 资产或不可恢复候选拒绝强删。Windows 必测锁定文件、长路径、reparse point、大小写路径和部分删除。

首版幂等键：`operation_id + expected_generation + expected_phase`。重复 operation 返回原结果；不匹配则无副作用失败。

## 3. 作者实现与自证

作者只修改 owned paths，先运行 affected checks。作者必须以工件原生形态自检：

- 代码：lint/type/unit/build/真实调用链；
- schema：真实 validator + 正反 fixtures；
- 包：真实 pack、packed manifest、clean install；
- UI：实际浏览器交互、截图和必要 a11y；
- 合同：producer endpoint、fixture、handshake、consumer conformance；
- 运行时：真实 Profile/host，不用 HTTP 200 冒充功能完成。

证据等级：L0 静态、L1 单元/合同、L2真实产物、L3官方Profile、L4浏览器视觉/交互。声明不得越级。

## 4. 候选冻结与证据包

候选冻结一次生成：

```text
repository identity
task/risk/owner
base/head/tree/effective-change digest
changed paths and contract impact
policy/config version
commands/results/CI run identity
reviewer/verdict/finding mapping（MEDIUM/HIGH）
threat/rollback/artifact fields（HIGH only）
```

任何内容变化生成新 candidate identity；原 verdict 自动失效。无内容变化的 CI、镜像、cleanup 和发布重试只引用原证据。

## 5. 206 provider 能力与最小 adapter

实施前只读探测：

```text
change requests
commit statuses / required contexts
review enforcement: native | signed-status | missing
discussion resolution
branch protection / admin bypass
expected-head merge / fast-forward / rebase result
native runner / external status reporter
mirror push
```

每项记录 `supported | alternative | missing`。

最小接口：

```text
getChangeHead(changeId)
getChecks(changeId, headSha)
getAcceptance(changeId, headSha)
mergeExpectedHead(changeId, headSha, expectedMainSha)
getMainSha()
```

- ProviderAuditAdapter 只读；
- IntegrationAdapter 对 required checks 只读，只能最小 merge；
- required checks 校验 context、head、issuer 和明确 success；
- MEDIUM/HIGH 使用原生 non-author review 或 reviewer 受信 exact-head status；missing 时只开放 LOW；
- AdminReconciler 是独立 break-glass 身份，不进入日常 merge 路径。

## 6. 合并语义

合并必须绑定 current head 和 expected main，防止 TOCTOU。

优先使用 expected-main fast-forward 或保留候选 head 为父节点的 merge。若 provider 只能 rebase/squash，记录：

```text
MERGED_FROM_EXACT_HEAD
source head/base
result main/tree
effective change digest
provider change ID
strategy
```

不能声称 result main 等于原候选 SHA。merge 调用响应丢失时先按 change ID、source head 和权威 main 查询结果，禁止盲目重试。

## 7. CI

候选层运行 affected checks；权威 main 只补组合/集成层；nightly/pre-release 执行全量矩阵。

Canvas 使用 `verification-matrix.json` 逐 surface 登记 path、package manager/version、lockfile、install、checks、OS、service、artifact。未登记 package manifest 失败；无 test 与遗漏 test 必须区分。

同 SHA 的 CI 平台故障重跑不生成新候选、不触发复审。总验证必须真正调用唯一 Gate 入口，不能只检查脚本存在。

## 8. 权威 main 复验与关闭

合并后必须读取权威 main result SHA 并运行该风险级的必要 main 验证。普通任务 `CLOSED` 要求：

1. acceptance 有效；
2. merge receipt 完整；
3. main result 验证成功；
4. 候选由 main 或验证过的 archive 到达；
5. pre-cleanup intent 与 cleanup-result 均存在；
6. worktree/branch 已回收或明确保留；
7. release_required=false，或 HIGH release 已完成。

远端 receipt 优先存入 206 change 的受保护 comment/status/audit；不支持时使用只有 IntegrationAdapter 可写的受保护 receipt ref。本地只保存可重建缓存。

## 9. 镜像

- 默认只同步权威 main，不同步候选和 tags；
- 短暂失败为 MIRROR_DEFERRED，含 owner/SLO/告警，不触发代码复审；
- 分叉进入 DIVERGED/RECOVERY_REQUIRED，不 force 覆盖；
- 灾备切换冻结写入、验证 refs/制品并递增 authority epoch。

普通代码在 authoritative main verified 后已经交付，不等待镜像关闭。

## 10. HIGH promotion 与发布

只有会替换可部署 runtime 制品的 HIGH 变更接入 Swarm 现有：

```text
freeze -> immutable artifact -> acceptance Profile
-> external promote -> health -> LKG -> rollback/repair
```

复用 `scripts/promotion` 已有 hash-chain ledger、generation fencing、status、repair、rollback 和测试。LOW/MEDIUM 不打 tarball、不运行 acceptance Profile 或完整 drill。

发布使用干净环境 build once；固定工具/镜像/依赖 identity；artifact digest、SBOM/provenance 由受信 workload identity 签发；publisher 验证 issuer、source SHA、digest 和 policy，只晋升同一制品。

数据/schema/config HIGH 区分代码回滚、配置回滚、数据恢复、safe-stop 和 forward-fix；不可逆迁移不得声称可回滚。

GitHub tag-push 发布在镜像启用前冻结或迁到权威链，避免镜像 tag 反向发布。

## 11. 双仓合同

按真实边治理：

- 官方 DSH Session/RPC -> Canvas；
- Swarm runtime/tool/service -> Canvas；
- Canvas Review Provider -> Swarm；
- Canvas Subagent Provider/tool callback -> Swarm/DSH；
- Canvas HTTP/SSE -> browser。

每条发生真实变化的边记录 producer/consumer SHA、DSH release/SHA、pi-ai resolved version/integrity、schema/fixture digest、capability、transport、lifecycle/error/cancel/recovery 和双侧 conformance。

Phase 0 先做 `ACCEPTED | STALE | UNKNOWN` inventory。STALE/UNKNOWN 只关闭对应 feature flag；不阻塞无关开发。迁移采用 provider兼容层 -> consumer切换 -> 后续删除旧层。

## 12. Canvas UI

纯视觉/孤立组件只跑 affected typecheck/build、关键 Playwright、必要 a11y 和真实截图，不等待 Swarm 合同、历史清账、镜像、SBOM 或 rollback。

只有展示/控制新 Swarm 状态、修改共享 schema/RPC、默认启用跨仓路径或发布宣称能力可用时，才要求对应合同 ACCEPTED。完整主题/视口/状态矩阵放 nightly/pre-release。

作者先读真实截图；多模态 reviewer 只补充语义审查，不替代 DOM、交互、视觉差异和 a11y。

## 13. 一次性 bootstrap

最小保护尚不存在时，只允许一次治理 bootstrap：

```text
freeze exact SHA -> independent review -> two-operator target/backup check
-> single-writer promote -> server read-back main SHA
-> bootstrap receipt -> install minimum protection -> expire exception
```

不能把 bootstrap 变成普通直推 main 通道。

## 14. 技术退出标准

- 新 clone 只依赖 206 即可完成 LOW 闭环；
- MEDIUM 仅在 reviewEnforcement 非 missing 时开放；
- main 受保护，合并绑定 head/main；
- CI/review 与同一候选绑定；
- main 复验、pre-cleanup、cleanup-result 和恢复均可执行；
- 普通开发不等待镜像/发布/无关合同；
- HIGH 复用现有 promotion/LKG/rollback；
- 不存在凭据 URL、镜像反向发布或不可恢复的被删除候选。
