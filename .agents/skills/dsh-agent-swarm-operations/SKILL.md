---
name: dsh-agent-swarm-operations
description: dsh-agent-swarm 项目的开发流程、项目管理操作（GitHub issue/PR/里程碑/CI）、开发规范门禁与运维手册。在本仓库做任何任务接手、流程执行、PR/issue/里程碑操作、验证收尾或定时复盘时必须使用本 Skill；开发 DSH 插件本身另见 dsh-plugin-development。
metadata:
  version: "1.2.0"
  date: "2026-08-21"
  update_cadence: "每日 09:00 自动复盘更新（见第七节）"
---

# dsh-agent-swarm 项目运维手册

本 Skill 是项目的单一操作入口：流程、管理、规范、教训。事实性治理宪法以 `AGENTS.md`、`docs/11`、`CONTRIBUTING.md` 为准；本手册负责"怎么执行"。

## 一、当前状态快照（定时更新区，改这里要同步 metadata.date）

- **里程碑**：M1 全量收束（M1A-M1D，2026-08-21 放行：独立回归审查 PASS、tag `m1d`、D1 单写入者 dogfood 开放）；**当前 M2**（官方 WorkflowEngine/JobRegistry 桥）——#75 桥/#76 jobs 投影/#77 模式+双 owner 已关闭，#78 节点映射/#79 预算跨 run 在途 → M3 → … → M9（client 压轴）。
- **仓库**：`github.com/leinasi2014/dsh-agent-swarm`（私有，`main` 唯一集成分支、线性历史）；`codex/glm-review-fixes` 为 M0/M1A 历史快照分支，不再开发。姊妹仓 dsh-canvas 双线并行（C-M1 已完成 tag `cm1`，C-M2 进行中）。
- **证据基线**：官方 DSH `141eb6f`（rc.8，未漂移）；`dsh-agent-teams` `801954d`；`jiuwenswarm` `36c7959`（Gate C 第四次 re-pin，AgentGroup 纯加法）。开工前 `pnpm verify:gate-a`（热上游按累计 diff 审计，见教训 16）。
- **门禁**：`pnpm verify` = 结构(600 行上限，零例外) → lint → 重复 → 死导出 → 类型×2 → 测试 → **场景审计** → 构建 → 产物；lefthook pre-commit；CI 全矩阵（gate 与 coverage 步均带 `.dsh-mkdir` 签名重试）；**合并一律 `node scripts/merge-guard.mjs <pr>`**。
- **场景审计**：18/32 machine-proven（新增 31 双 owner 对抗/32 模式）；测试 110；`src/tools.ts` 已拆分（46 行薄壳 + 6 域模块）。
- **开发模式**：PM 统筹 + 智能体并行 worktree（CONTRIBUTING §2a）+ 串行守卫合并；PM 迭代方法论见第八节。
- **已知 flake**：官方包 `.dsh-mkdir-*` ENOENT（Win32 mkdir/rename 竞态，重跑即绿；高频则升级上游立案，见 M1C exit 报告 §3）。
- **上次复盘**：2026-08-21（M1 放行 + M2 过半时更新；并发会话检查：一次已结束的写入突发，非持续活跃）。

## 二、标准开发闭环（每个任务）

```text
1. 接 issue（milestone=M1x, labels=type/area/finding）
2. Gate A 前置（里程碑首任务或官方可能漂移时）：pnpm verify:gate-a
3. git switch -c <type>/<slug> main
4. 实现 + 测试（新测试带 scenario N: 标签，若对应 docs/08 §3 场景）
5. 本地 pnpm verify 全绿（管道会吞退出码，见教训 #1）
6. gh pr create --body-file <file>（模板自动加载；body 含 ${{ }} 必须走文件，见教训 #4）
7. CI verify 绿（gh run watch <id> --interval 30）
8. gh pr merge <n> --rebase --delete-branch
9. PR 描述 Closes #N → issue 自动关闭；触碰 F 系列发现的在 PR 引用编号
10. 文档同步在同 PR（README/docs/09/docs/10/roadmap/Skill，仅官方事实或所有权变化时）
```

红线：不直接推 `main`；不 force push `main`；不用 merge commit（保持线性）；不绕过任何门禁（verify-project 会拒绝摘除泳道）；不动 `ref/`、官方证据 checkout、`docs/reviews/`（不可变审查证据）。

## 三、项目管理操作速查（gh CLI）

```sh
gh issue create -R leinasi2014/dsh-agent-swarm -t "标题" -b <body文件> -l "type:fix,area:runtime" -m M1B   # milestone 用名称不是编号
gh pr create --base main --head <branch> --body-file <file>       # body 永远走文件
gh pr checks <n> && gh run watch <runId> --interval 30
gh pr merge <n> --rebase --delete-branch
gh issue close <n> -c "理由"        # 通常由 Closes #N 自动完成
gh api repos/leinasi2014/dsh-agent-swarm/milestones -f title=M1X -f description=... -f state=open
gh label create "finding:FX" --color e11d21 --description "..."
gh run list --limit 5 && gh run view <id> --log-failed | tail -30
```

体系约定：milestone = 路线图里程碑（M1B/M1C/M1D/M2/M3/Backlog）；`type:*` / `area:*` / `finding:F2–F16` 标签；里程碑完成以 docs/07 exit criteria 为准，不以 issue 清空为准。

## 四、开发规范要点（机器强制，摘要）

| 门禁 | 命令 | 红线值 |
|---|---|---|
| 结构/规模 | `pnpm verify:structure` | src `.ts` ≤600 行（例外登记于 verify-project.mjs，当前仅 team-domain.ts due M1B） |
| Lint | `pnpm lint` | oxlint correctness=error/suspicious=warn，0/0 |
| 重复 | `pnpm verify:duplication` | jscpd 0 克隆（60 token/6 行） |
| 死导出 | `pnpm verify:exports` | knip 0 发现 |
| 场景审计 | `pnpm verify:scenarios` | docs/08 §7 audit 行与测试证据双向等值 |
| 测试 | `pnpm test` | 全绿；异步边界断言必须 vi.waitFor |

宪法摘录（完整见 AGENTS.md / docs/11）：official-first；不改 Agent Loop；不影子注册官方服务；单一权威状态（`TeamDomainPort`）；每注册有 disposer；模型可见可从 Session 日志重建；自托管按 ADR-0008 分级（M1D 后才 D1 单写入者）；审查员自主不设限（docs/12）。

## 五、任务与里程碑收尾协议

**单任务收尾**：verify 全绿 → PR → CI 绿 → rebase 合并 → issue 关闭 → 文档同步确认 → 触碰 finding 的留编号供 M1D 汇总 diff。

**里程碑 exit**（对照 docs/07）：exit criteria 逐项核验 → 同 PR 更新 docs/07 状态 + docs/10 审计基线 → `git tag m<x>` 推送 → Gate A 记录刷新 →（M1D 专属）委派独立 GLM-5.3 回归审查 + 宣布 D1 dogfood 开放。

## 六、经验教训库（持续累积；每条 = 症状/根因/规则）

1. **管道吞退出码**：`pnpm test | tail` 的 `$?` 是 tail 的。规则：提交前用 `${PIPESTATUS[0]}` 或独立跑命令确认退出码。
2. **pnpm add 重写 package.json 使 Edit 过期**：报 "modified since read"。规则：改 package.json 前重读；**每次 commit 后立即 `git show --stat` 核对与提交信息一致**（本会话两次靠 amend 补正）。
3. **workflow scope**：gh OAuth 无 `workflow` scope 时推 `.github/workflows/**` 被拒。规则：`gh auth refresh -s workflow` 设备码流程，把代码给用户浏览器授权。
4. **PR body 的 `${{ }}`**：bash 内联会 bad substitution。规则：body 一律 `--body-file`。
5. **milestone 传名称**：`-m 1` 报 not found；用 `-m M1B`。
6. **嵌套 oxlint 配置**：官方证据 checkout 若在仓库树内，`oxlint .` 会读到官方自己的 `.oxlintrc.json` 并拒绝其 root-only 选项。规则：证据放 `runner.temp`（CI）/仓库外（本地），并保留 `official-evidence/**` ignore 双保险。
7. **慢 runner 暴露异步竞态**：status 断言通过 ≠ 投递完成（claim 先于 followup）。规则：跨异步边界断言一律 `vi.waitFor`（先例：M1A token 结算、组合测试 transcript）。
8. **巨型测试整体打标 = 过度声明**：场景标签打在精确对应的 `it()` 或证明断言行内 marker（`// scenario-evidence: N`）。
9. **分支切换使文件读取态过期**：switch 后先 Read 再 Edit。
10. **旧分支 PR 的 CI 用 merge ref**：基于旧 main 的分支失败后，`git rebase main && push --force-with-lease` 重跑即用新 workflow。
11. **私有仓库分支保护需 GitHub Pro**（403）：保护暂靠纪律 + CI；升级或转公开后再配置 ruleset。
12. **lefthook staged lint 全被 ignore 时报错**：加 `--no-error-on-unmatched-pattern`。
13. **并发会话冲突**：动手前查 `~/.dsh/sessions/--D-Source--/` mtime 判断 DSH RPC 会话是否活跃；用户的 web UI host（3080 端口）不经确认绝不终止。
14. **PR/issue 编号共用一个序列**：issue 3-8 之后 PR 从 9 开始，引用时先查再写。
15. **双绿险情（两起）**：PR #11 在一条 run 失败时被合入（main 带病、暴露真实竞态）；PR #30 在 pending 时合入（结果绿）。根因：私有仓库免费版无 required checks + 人工核对靠记忆。规则：**合并一律走 `node scripts/merge-guard.mjs <pr>`**（机制化双绿守卫），不再裸 `gh pr merge`；根治待 GitHub Pro/转公开后配置 required checks。
16. **热上游不追提交**：jiuwenswarm 当日移动 4+ 次，逐提交 chase 一败再败。规则：Gate C 对热上游按**累计 diff 一次性审**（旧 pin → 最新 HEAD），审毕 pin 最新已审头（docs/09 有先例叙事）。
17. **绿灯 ≠ 正确（race/timeout 类）**：#13 的 boundedSettle 超时构造 bug（resolve/reject 命名颠倒）是绿灯通过的。规则：PM 审查 race/timeout 类 diff 必须**专看败者路径**——losing promise 的 rejection 是否被观察、超时分支是否真的 reject。
18. **gh TLS 超时的幂等处置**：合并类命令失败后**先查实际状态再重试**（PR #29 合并已成功但删分支失败，盲目重试会双合并）。
19. **worktree 并行开发模式（2026-08-20 启用）**：主树 = PM 专属（停 main，做审查/治理/合并），每个实现任务一个 `git worktree`（独立目录/分支/依赖/refs）。速度 2-3 倍且零树竞争。规范全文见 CONTRIBUTING §2a；上限 2-3 路，合并保持串行。
20. **官方包 `.dsh-mkdir-*` ENOENT flake**：dsh-session-persistence-jsonl 在慢 Windows runner 上的 mkdir/rename 临时目录竞态，非我方 diff。规则：命中该签名直接重跑失败 job。CI 级签名重试已上线（PR#44 建、PR#57 修捕获缺陷——见教训 25）；持续高频仍需上游 issue。
21. **`gh pr merge` 非原子**：合并成功后的分支删除遇 TLS 超时会以非零退出（两次把 merge-guard 的收尾打成 stack trace）。规则：合并类命令失败后先查 PR 权威状态再定成败（守卫已内置该容错）。
22. **并行 PR 的同文件冲突取"语义并集"**：#33/#35 同改 stranded 断言块——解冲突时按"匹配当前 API 面的一侧 + 保留对方的时序修复"取并集，逐 hunk 判断，不整文件取一侧。
23. **结构化文本编辑用 Read+Edit，不玩 shell 花样**：heredoc 定界/pwsh 内联替换在含特殊字符时静默失败（本日两例）。规则：多行结构化内容一律 Write/Edit 工具。
24. **句柄丢失 ≠ 智能体死亡（2026-08-21）**：会话上下文压缩后 `TaskOutput`/`SendMessage` 均报 "No task found"，但两个后台智能体实际仍在工作（其一还在与我并发修同一 worktree 的 ref）。规则：接管前先轮询远端/工作树实际状态（`gh pr list`、worktree `git status`/reflog mtime）；接管动作与在途智能体可能撞车（曾引发 stale `shallow.lock` 与神秘并发提交）。
25. **守卫自身也会哑火——守卫必须验证其触发**（2026-08-21，PR#57 修复）：Tee-Object 变量捕获拿不到 vitest worker 子进程 stderr，`.dsh-mkdir` 签名重试守卫三连哑火。规则：守卫类机制上线后必须在真实失败上验证其触发过至少一次；输出捕获用文件重定向（`*>`）+ Select-String，不依赖管道对象捕获。
26. **智能体推送静默失败（2026-08-21）**：D1 作者的追补 commit 8e0023d（grace 2s→5s）推送失败但智能体以为已推、误报"双绿"，PM 差点信报告放弃追补（幸核 `gh pr view --json headRefOid,commits` 发现 PR 只有 1 commit）。规则：交付合同的完成汇报必须附 `gh pr view --json headRefOid,commits` 实证 head 即最终 commit；PM 合并前必查。
27. **Windows 长路径 worktree 残留**：`git worktree remove` 报 "Filename too long"、PowerShell `\\?\` Remove-Item 也不彻底。规则：MSYS `rm -rf` 可清（Git Bash 自带长路径处理），再 `git worktree prune`；陈旧 `.git/shallow.lock` 先用 CIM 查存活进程（`Get-CimInstance Win32_Process`），busy=活 fetch 在跑就等，进程已死才是真陈旧锁。
28. **测试窗口迁移要全量清点（2026-08-21，PR#58）**：D1 契约迁移改了 5 处断言，作者只加宽了自己新写的 wakeup 套件窗口，漏了同族 message-delivery 的 9 处 5s 窗口（且三串行窗口最坏可超 20s 测试预算）。规则：语义迁移类 diff 审查时枚举**所有依赖旧时序的既有测试**，一并核窗口与预算。
29. **结算通知竞态族（2026-08-21，PR#66/#72/#73 三例同根）**：凡测试"drain 成员 → 期待 captain 侧调度 pass/投递产物"的形态，drain 必然以结算通知唤醒 captain——慢 runner 上通知 turn 先行把 captain 挂在模型闸门，后续 recoverAgent 全部 no-op（正确产品语义：mid-work 不自调度），期待物永远 undefined/0。规则：这类断言一律在 waitFor 轮内 `adapter.open()` + 重驱动 `recoverAgent`（driveRecoveryPasses 哲学；成员已冷、captain 为根会话时开闸无结算风险）。症状签名：`expected 0 to be greater than or equal to N` / `expected undefined to be 'owner-not-live'` / F8 的 delivered 停滞。
30. **分支删除必须在 `gh pr view --json state` == MERGED 之后**（2026-08-21 两次险情）：merge-guard 收尾报错（合并冲突/TLS）≠ 未合并，本地 `git branch -D` 若先于 MERGED 核验执行，就要从远端重建分支。规则：守卫输出后先查 state 再删分支；守卫遇 GitHub 合并冲突时流程 = 本地 rebase → 语义并集解冲突 → force-push → 重跑守卫。
31. **并行泳道扩容的条件（2026-08-21，用户指示，PR#69/#20 双侧）**：上限 2-3 → 3-6。>3 路的前提：① 咨询性预审席位分摊一审（终审+合并权仍 PM 独占）；② 合同显式声明泳道避让面（冲突面同文件不并行）；③ 合并仍串行。实测 6 路期间 PM 带宽占用主要在 rebase 解冲突（同仓多泳道必碰 README/verify.yml/GOALS 等公共文件）——公共登记面尽量集中在 PM 侧收尾批量改，实现合同里禁碰。
32. **rebase 并集后必须本地过结构门禁再推**（2026-08-21，PR#87 两次返工）：三路并集把 orchestrator-runtime 顶过 600 行上限，CI 两腿全红才发现；另一次并集残留 import 失配。规则：解完冲突先 `npx tsc -p tsconfig.json --noEmit` + `node scripts/verify-project.mjs` 全过再 push（新依赖还需 `pnpm install --frozen-lockfile`）。
33. **会话活跃判定看"持续"而非"单次"**（2026-08-21 复盘实测）：`~/.dsh/sessions/` 的 mtime 单次写入突发（turn 结束）后静默 ≠ 持续活跃的 RPC 会话；二次轮询 2 分钟无刷新即可按已结束处理继续复盘。真正的持续刷新才会触发协议的停止条款。

## 七、定时更新协议（本 Skill 的自我维护）

- 触发：每日 09:00 自动复盘（宿主调度）；任何会话也可手动按本节执行。
- 输入：自快照"上次复盘"以来的 `git log`、issue/PR/里程碑状态、`gh run list` 近况、`pnpm verify:scenarios` 输出、docs/07 状态。
- 更新：仅改第一节快照与第六节教训库（新教训 = 可复用的操作教训，没有就不加），同步 frontmatter `date`；不改其他节的既定规则（规则变更须走 PR 评审说明理由）。
- 无实质变化（无新提交/状态不变/无新教训）→ 不产生任何提交。
- 有变化 → 按 CONTRIBUTING 标准流程：分支 `chore/skill-refresh-<date>` → `pnpm verify:structure` → PR → CI 绿 → rebase 合并。
- 本 Skill 已登记在 `scripts/verify-project.mjs` 必需清单与章节断言中，不可被无声删除。

## 八、PM 迭代方法论（2026-08-20，经 M1B/M1C 十轮迭代实证）

```text
定义（委派合同）→ 委派（智能体）→ 独立审查（PM）→ 守卫合并（机制）→ 收尾登记（GOALS/证据链）
```

实测：交付即审过 9/9、合并后返工 0、串行 45-60 分钟/issue → 2 路并行 ~25-30。

1. **委派合同五要素**（质量的上游）：官方模板源码出处（精确到文件行号）＋红态证据要求（防假绿）＋红线清单与"不做 XXX（独立 issue）"＋停止点（PR 双绿即停，PM 持合并权）＋完成报告格式。并行加第六要素：冲突面预告。
2. **判断项预授权**：允许智能体在红线边缘做工程判断，但必须显式申报留给 PM 裁决（范本：#14 帧模板运行时派生——申报后一审即过）。
3. **审查三层**：外围（CI + 声明无触碰面的 diff 为空）→ 核心（关键逻辑逐行）→ 交叉（声明 vs 代码）；race/timeout 类必查败者路径。
4. **机制 > 纪律**：任何靠人记住的规则终会失效（双绿两起险情→守卫三次真实拦截）。安全规则一律脚本化。
5. **证据链前置**：为下游审查者从第一天积累 remediation 清单（每个 exit 报告都含 发现→issue→PR→提交 映射表）。
6. **召回优于重建**：测试/代码竞态优先召回原作者智能体（上下文在作者手里，#33 从立案到根因修复一轮完成）。
7. **状态彻底外化**：GOALS/教训库/exit 报告/memory——长会话经多次上下文压缩无损续跑的根基。
8. **诚实局限**：#12 的三个测试竞态都逃过 PM 审查与首轮 CI——独立回归审查（M1D）是不可替代的第二道防线；单 PM 带宽是并行度上限。
