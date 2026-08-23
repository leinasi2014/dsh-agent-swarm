# 双项目治理与开发流程重构索引

状态：`REVISED / RE_REVIEW_REQUIRED`

本文件只保存文档分层、缺陷归属、实施顺序和审查基线，不重复项目管理规则或开发技术规范。

## 1. 规范分层

| 文档 | 负责回答 | 不负责回答 |
|---|---|---|
| [项目管理与多智能体治理规范](2026-08-23-project-management-governance.md) | 权责、风险、派工、WIP、状态、审查复用、监督、暂停恢复、两日经验 | Git/CI/合并命令和技术实现 |
| [项目开发规范](../development/2026-08-23-development-standard.md) | worktree、作者自证、候选、206 provider、CI、合并、主线复验、镜像、发布、合同、UI、cleanup | 谁裁决范围和多少并发 |
| [代码质量与架构规范](../development/2026-08-23-code-quality-architecture-standard.md) | 行数基线、复杂度、抽象条件、模块边界、依赖方向和语言配置 | 项目派工、Git 状态和重复架构审批 |
| Canvas 适配清单 | Canvas 旧治理迁移、surface CI、UI 放行和跨仓差异 | 重新定义通用规则 |

冲突处理：管理决策先服从治理规范；具体实现服从开发规范；项目适配只能增加项目事实和更严格的必要约束，不能另造状态机或重复审批。

## 2. 已确认架构

- 206 Git 服务是唯一开发权威；GitHub 是异步镜像/灾备。
- 普通开发以 206 change/status/review/merge receipt 为动态真源。
- LOW/MEDIUM 不建设独立治理数据库；HIGH runtime 制品复用 Swarm 现有 promotion 控制面。
- 普通任务只有 OPEN、CANDIDATE、ACCEPTED、INTEGRATED、CLOSED；ARCHIVED 是未集成候选终态。
- 审查按风险分级，同一最终候选只有一次必要审查，后续只做 delta review。
- Canvas 无关 UI 不被历史清账、镜像、发布或无关 Swarm 合同阻塞。

## 3. 缺陷—规范—解决阶段

| ID | 缺陷 | 规则归属 | 解决阶段 |
|---|---|---|---|
| R-01 | 两仓 remote URL 内嵌 PAT | 开发规范 §1；治理规范 §9 | Phase 0 立即止血 |
| R-02 | 本地治理提交尚未到206 | 开发规范 §13 bootstrap | Phase 0/1 |
| R-03 | 206/GitHub 双权威、Canvas 无 upstream | 开发规范 §1/§9 | Phase 0 |
| R-04 | Canvas merge guard 只支持 `gh` | 开发规范 §5/§6 | Phase 1 |
| R-05 | 206保护/审查/检查能力未验证 | 开发规范 §5 | Phase 0 capability spike |
| G-01 | 会话、任务、候选、集成和关闭混用 | 治理规范 §5/§7 | Phase 1 |
| G-02 | 并发超过集成能力、任务过大 | 治理规范 §4/§8/§10 | 立即生效 |
| G-03 | 监工、审查、PM 权限重叠 | 治理规范 §2/§8 | 立即生效 |
| G-04 | 同一候选反复审查 | 治理规范 §6 | 立即生效 |
| G-05 | 工作区误分组、仓库移动后路径漂移 | 治理规范 §7/§9 | Phase 0/2 |
| D-01 | worktree 创建/关闭不完整 | 开发规范 §2/§8 | Phase 1/2 |
| D-02 | cleanup intent/result 顺序含糊 | 开发规范 §2/§8 | Phase 1 |
| D-03 | merge/rebase exact SHA 语义冲突 | 开发规范 §6 | Phase 1 |
| D-04 | CI 只查文件存在或入口未接线 | 开发规范 §3/§7 | Phase 1/3 |
| D-05 | 归档候选仅本地、历史分支积压 | 开发规范 §2/§8 | Phase 2 分批处理 |
| D-06 | 新旧 Skill/registry/MDX 同时触发 | 治理规范 §10；Canvas 适配 C2 | Phase 1/2 |
| D-07 | 镜像 tag 会反向触发发布 | 开发规范 §9/§10 | Phase 0 冻结 |
| D-08 | Canvas CI surface 覆盖不足 | 开发规范 §7 | Phase 3 affected matrix |
| D-09 | 跨仓合同只有自然语言且实际双向 | 开发规范 §11 | Phase 0 inventory / 按需纵切 |
| D-10 | UI 自动测试和截图自检不一致 | 开发规范 §12 | LOW affected / nightly full |

## 4. 渐进实施

### Phase 0：止血和只读事实

- 撤销/轮换泄漏 PAT，remote URL 脱敏；
- 识别 206 provider 能力、main 保护、review enforcement 和 merge 语义；
- 明确 authority/mirror，冻结 tags 镜像和镜像侧发布；
- 当前合同边建立 ACCEPTED/STALE/UNKNOWN inventory；
- 历史候选、旧 registry 和 Canvas `ref/` quarantine，不做大爆炸清理。

### Phase 1：最小真实闭环

- 落地稳定 config/schema、provider 最小接口和唯一入口；
- 修正冲突 Skill/AGENTS/CONTRIBUTING；
- 实现 head-bound checks、acceptance、expected-head merge、main verify；
- 实现最小 close/reconcile、pre-cleanup intent、cleanup-result 和中断恢复；
- 用一个 Swarm LOW 文档候选走通完整流程，再在 Canvas 重复一个 LOW 文档候选。

Phase 1 后恢复 LOW；只有 reviewEnforcement 非 missing 时恢复 MEDIUM。

### Phase 2：便利性和遗留清账

- 增强 Windows worktree、批量 reconcile 和异常恢复；
- 旧治理按 export/compare/freeze/cutover/archive 迁移；
- 重要候选先远端 archive/bundle，再逐批退休分支；
- 不阻塞无关产品/UI开发。

### Phase 3：HIGH 和发布

- HIGH runtime 变更接入现有 promotion/LKG/rollback；
- 发布制品 build once、签发 provenance、独立 publisher；
- 迁移 GitHub tag-push 发布到权威链；
- 数据迁移定义 rollback/safe-stop/forward-fix。

### Phase 4：按需合同和完整矩阵

- 每次真实接口变更治理一条 contract edge；
- Canvas 候选只跑 affected UI，nightly/pre-release 跑全矩阵；
- 只有真实瓶颈出现时才抽公共 package、自动镜像恢复或独立远端 ledger。

## 5. 审查规则

设计审查基线必须固定三个文档的精确 SHA。复审只读取上一 verdict 的 finding-to-fix delta；以下不重新全篇审查：格式、链接、同义拆分、CI/镜像/cleanup 重试。

开工最小阻断项：

1. 凭据止血可以执行或有明确外部阻塞；
2. 206 能力矩阵和 bootstrap 有可执行路径；
3. 候选不能自行签发 checks/review；
4. source/result merge receipt 语义明确；
5. pre-cleanup intent 与 cleanup-result 分离；
6. LOW/MEDIUM/HIGH 与复审触发器明确；
7. 镜像不会反向发布。

其余改进按阶段实施，不得为了“更完整”无限延迟首个 LOW 闭环。

## 6. 当前审查历史

- 初稿：Swarm `bb54e445...`、Canvas `0afde101...`；安全、状态机、执行性和 GLM-5.3 均要求修改。
- 敏捷修订：Swarm `fbe38927...`、Canvas `7c0955cb...`；取消重型治理平台、LOW重复审查、同步镜像阻塞和全量UI前置。
- delta 修订：补 trusted check/review issuer、cleanup intent/result、receipt 耐久载体、MEDIUM放行条件和现有 promotion 复用边界。
- 当前版本：等待分层文档的最终 delta 复审；未宣称 APPROVED，未启动远端变更或全流程重构。

## 7. 最终退出标准

- 管理治理规范与开发规范职责无重复冲突；
- 新 clone 只依赖 206 完成 LOW 闭环；
- MEDIUM 只有在可信 review enforcement 可用时开放；
- 同一候选不会重复审查；
- merge/main/cleanup 可恢复；
- 普通开发不等待镜像、发布或无关合同；
- HIGH 复用现有 promotion；
- 两日真实经验已经转化为门禁、任务模板和恢复动作，而不只是复盘文字。
