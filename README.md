# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

A persistent multi-agent team orchestration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

It keeps the root session as the **Main Brain** while giving every managed team an independent **Captain Session**. Captains can recruit specialists, build task DAGs, dispatch work, review deliveries, and expose goals, announcements, people, tasks, and runtime state through a DSH-native side workbench.

> **Status:** actively developed pre-release source. The repository provides build, test, and packaging entry points, but no public npm release is available yet. `package.json` remains `private: true` to prevent accidental publication.

## Implemented capabilities

- **Main Brain and independent Captains** — `agent_swarm_create_managed` creates a dedicated Captain Session without replacing the root chat with team execution logs.
- **Team and member identities** — Captains and members can store a name, profession, personality, and safe pixel-style SVG avatar. Members run through the official continuable subagent seam.
- **Task collaboration** — DAG dependencies, priorities, revision CAS, `attemptId` fencing, targeted assignment, submission, reassignment, and Captain review.
- **Durable runtime state** — the Team aggregate is stored through the official Storage Domain; member descriptors, tasks, mailboxes, budgets, and memories can survive restarts.
- **Messaging and supervision** — persistent mailboxes, quiet/wakeup delivery, member interruption, budget limits, waiting, status reads, and pagination.
- **Memory and experience** — team-shared memory and member-private memory have distinct persistence and authorization boundaries.
- **DSH Team Workbench V3** — team rail, shared goal, latest announcement, and four mutually exclusive views: Workbench, Tasks, Announcements, and Management. Member and task details open as overlays instead of shrinking the root chat.
- **25 `agent_swarm_*` tools** — see [docs/04-core-protocol.md](docs/04-core-protocol.md) for parameters, permissions, and state contracts.

## Architecture boundaries

```text
Official DSH Session / Agent Loop / Subagent
                    │
          agent_swarm_* tools
                    │
        OrchestratorRuntime + Providers
                    │
             TeamDomainPort
                    │
        Official Storage Domain (truth)
                    │
      Host read projection → DSH client UI
```

- The plugin does not patch or duplicate the official Agent Loop.
- The Team aggregate is the single business authority; UI, prompt context, and read-only RPCs are projections.
- State is published only after its durable commit succeeds.
- The browser workbench currently focuses on reading and navigation. Team mutations go through Captain Chat and fenced model tools.
- Missing official services, unconfigured providers, and stale revisions or attempts fail loudly instead of silently creating a second state machine.

## Quick start

### Requirements

- Node.js `^22.19.0 || >=24` (CI uses Node.js 24)
- pnpm `9.15.9`
- A DSH checkout/Profile compatible with the peer dependencies in `package.json` and the pinned baseline in `docs/OFFICIAL_BASELINE.json`

### Clone and verify

```bash
git clone https://github.com/leinasi2014/dsh-agent-swarm.git
cd dsh-agent-swarm
corepack enable
pnpm install --frozen-lockfile
pnpm verify:candidate
```

`pnpm verify:candidate` runs structure and boundary checks, linting, duplicate and dead-export checks, both type-check lanes, tests, scenario checks, builds, and package-artifact verification.

### Build a pre-release tarball

```powershell
$artifact = Join-Path $env:TEMP 'dsh-agent-swarm-artifact'
New-Item -ItemType Directory -Force $artifact | Out-Null
pnpm build
pnpm pack --pack-destination $artifact
$tgz = (Get-ChildItem $artifact\dsh-agent-swarm-*.tgz | Select-Object -First 1).FullName
```

Install development candidates only into a fresh, isolated `DSH_HOME` and Profile. Do not test them in your default user Profile:

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ('dsh-swarm-home-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $env:DSH_HOME | Out-Null
dsh plugin --profile web add --workspace-root $tgz
```

The Profile must still compose an official Storage hub, KV backend, Storage Domain, Session persistence, Subagent runtime, and a real LLM Provider. Installing this plugin does not automatically create a Team or spawn members.

## Basic usage

Describe the desired outcome in a DSH root session, for example:

```text
Create an independent delivery team. Ask the Captain to recruit specialists for
requirements, implementation, and review, then build and execute a dependency-aware
task plan for adding integration tests to this project.
```

A typical flow is:

1. The Main Brain calls `agent_swarm_create_managed` to create an independent Captain.
2. The Captain sets the team goal and identity, then recruits members with `agent_swarm_add_member`.
3. The Captain builds a DAG with `agent_swarm_create_task`; the scheduler dispatches ready tasks.
4. Members submit fenced attempts; the Captain accepts or rejects them with `agent_swarm_review_task`.
5. The user follows progress in the Team Workbench or opens Captain Chat to adjust goals and assignments directly.

## Repository layout

```text
src/        Plugin host/client, domain, runtime, providers, and tools
tests/      Unit, composition, restart, fault, and UI tests
packages/   Reusable packages owned by this repository
docs/       Product, protocol, architecture, verification, and historical records
scripts/    Engineering gates, isolation lifecycle, packaging, and acceptance scripts
ref/        Pinned reference pointers; materialized source is read-only
.github/    CI workflows and pull request template
```

## Development and contributing

```bash
pnpm verify:isolation:status   # Before writing, freezing a candidate, or integrating
pnpm test -- <affected-test>   # Smallest affected check during iteration
pnpm verify:candidate          # Candidate engineering gate
pnpm verify:policy             # Only when governance/instructions/registered docs change
pnpm verify:compatibility      # When official/reference compatibility is decision-bearing
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for managed worktrees, review, and serial integration. Start with [AGENTS.md](AGENTS.md) for the repository's authoritative development rules.

## Documentation

- [Documentation index](docs/README.md)
- [Product goals](docs/GOALS.md)
- [Core protocol](docs/04-core-protocol.md)
- [Implementation roadmap and exit criteria](docs/07-implementation-roadmap.md)
- [Testing and verification](docs/08-testing-verification.md)
- [Official-first development strategy](docs/11-official-first-development.md)

## Current limitations

- There is no public npm package, plugin-marketplace listing, or stable release identity yet.
- Privileged Browser/Canvas write and control capabilities are not exposed as a public protocol.
- Distributed cross-process CAS, remote members, and automatic Skill Evolution are future capabilities and must not be inferred from the current local runtime evidence.

## License

[MIT](LICENSE)
