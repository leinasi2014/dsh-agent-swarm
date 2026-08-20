---
name: dsh-agent-swarm-operations
description: dsh-agent-swarm 项目的开发流程、项目管理操作（GitHub issue/PR/里程碑/CI）、开发规范门禁与运维手册。在本仓库做任何任务接手、流程执行、PR/issue/里程碑操作、验证收尾或定时复盘时必须使用本 Skill；开发 DSH 插件本身另见 dsh-plugin-development。
metadata:
  version: "1.1.0"
  date: "2026-08-20"
  update_cadence: "每日 09:00 自动复盘更新（见第七节）"
---

# dsh-agent-swarm 项目运维手册

本 Skill 是项目的单一操作入口：流程、管理、规范、教训。事实性治理宪法以 `AGENTS.md`、`docs/11`、`CONTRIBUTING.md` 为准；本手册负责"怎么执行"。

## 一、当前状态快照（定时更新区，改这里要同步 metadata.date）

- **里程碑**：M1A/M1B/M1C 完成（2026-08-20；F1-F7/F9/F11-F15 关闭或决策落地，tag `m1b`/`m1c`）；**当前 M1D**（真实 rc.8 Profile + 独立回归审查 + D1 dogfood 门；前置：rc.8 CLI 环境）→ M2 → … → M9（client 压轴）。
- **仓库**：`github.com/leinasi2014/dsh-agent-swarm`（私有，`main` 唯一集成分支、线性历史）；`codex/glm-review-fixes` 为 M0/M1A 历史快照分支，不再开发。
- **证据基线**：官方 DSH `141eb6f`（rc.8）；`dsh-agent-teams` `801954d`；`jiuwenswarm` `56da762`。开工前 `pnpm verify:gate-a`（热上游按累计 diff 审计，见教训 16）。
- **门禁**：`pnpm verify` = 结构(600 行上限，零例外) → lint → 重复 → 死导出 → 类型×2 → 测试 → **场景审计** → 构建 → 产物；lefthook pre-commit；CI 全矩阵；**合并一律 `node scripts/merge-guard.mjs <pr>`**。
- **场景审计**：16/30 machine-proven；测试 78；`src/tools.ts` 594/600（扩前先拆）。
- **开发模式**：PM 统筹 + 智能体并行 worktree（CONTRIBUTING §2a）+ 串行守卫合并；PM 迭代方法论见第八节。
- **已知 flake**：官方包 `.dsh-mkdir-*` ENOENT（Win32 mkdir/rename 竞态，重跑即绿；高频则升级上游立案，见 M1C exit 报告 §3）。
- **上次复盘**：2026-08-20（M1C exit 时更新）。

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
20. **官方包 `.dsh-mkdir-*` ENOENT flake**：dsh-session-persistence-jsonl 在慢 Windows runner 上的 mkdir/rename 临时目录竞态，当日命中 4 次（main 基线可复现，非我方 diff）。规则：命中该签名直接重跑失败 job；频率持续偏高则升级为上游 issue + CI 级重试策略。
21. **`gh pr merge` 非原子**：合并成功后的分支删除遇 TLS 超时会以非零退出（两次把 merge-guard 的收尾打成 stack trace）。规则：合并类命令失败后先查 PR 权威状态再定成败（守卫已内置该容错）。
22. **并行 PR 的同文件冲突取"语义并集"**：#33/#35 同改 stranded 断言块——解冲突时按"匹配当前 API 面的一侧 + 保留对方的时序修复"取并集，逐 hunk 判断，不整文件取一侧。
23. **结构化文本编辑用 Read+Edit，不玩 shell 花样**：heredoc 定界/pwsh 内联替换在含特殊字符时静默失败（本日两例）。规则：多行结构化内容一律 Write/Edit 工具。

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
