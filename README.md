# dsh-agent-swarm

[![verify](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml/badge.svg)](https://github.com/leinasi2014/dsh-agent-swarm/actions/workflows/verify.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Multi-agent teams for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Keep your main conversation focused on the goal while an independent **Captain** recruits members, coordinates tasks, and reviews their work.

**[GitHub Releases](https://github.com/leinasi2014/dsh-agent-swarm/releases)** provides versioned installation packages and their accepted scope. This checkout prepares recovery patch **v0.1.5**, restoring the v0.1.3 feature baseline and the independently accepted task-cancellation dependency guard. Publication and fresh Profile acceptance are separate steps; check the release notes for the published version and verified scope. Install a published release tarball; this repository is `private: true` for npm publishing and has no public npm package.

## What you can do

- **Run multiple teams.** Each team has its own Captain Session and members. Your root Session, called the Main Brain, creates and routes work across teams without joining their rosters.
- **Coordinate delivery.** Captains recruit members, organize tasks with dependencies, assign work, and review submissions. An optional plan-first flow asks for approval before activating a team.
- **Follow team discussions.** Read group chat, inspect member profiles, and open the corresponding official Session records. Members can page through public history, read a message by ID in bounded sections, and reply to a real public message.
- **Configure how members work.** Use model routing, reasoning levels, Skill allow-lists, budgets, and role-based tool policies, including Captain approval for individual tool calls.
- **Keep team context.** Team state persists through the official Storage Domain. Shared team memory and private member notes have separate access boundaries.
- **Work inside DSH.** Team panels and plugin settings use the official web UI. Official Sessions retain conversation history, and official Subagents run members.

```text
Main Brain (your root conversation)
  +-- Team A: Captain Session -> Members -> Tasks and reviews
  +-- Team B: Captain Session -> Members -> Tasks and reviews
```

For service ownership and persistence details, see the [capability architecture](docs/03-capability-family.md) (Chinese).

## Install

| Requirement | Supported baseline |
|---|---|
| DeepSeek Harness | `0.1.5-rc.2` |
| Node.js | `^22.19.0 || >=24` |
| pnpm | `9.15.9`, available on `PATH` |
| UI | Official DSH `web` Profile |

The compatibility target is pinned in `package.json`, `pnpm-lock.yaml`, and [OFFICIAL_BASELINE.json](docs/OFFICIAL_BASELINE.json). Other DSH versions are not covered by this baseline; compatibility updates track release candidates and final releases.

Start with an official DSH installation and a Profile that can run your chosen model. The Profile must compose official Storage, Storage Domain, Session persistence, and the Subagent runtime. Use a separate `DSH_HOME` or dedicated Profile for an initial trial, and stop the target Profile before installing or updating its packages.

Download the versioned `.tgz` package and `SHA256SUMS.txt` from the **[latest published release](https://github.com/leinasi2014/dsh-agent-swarm/releases/latest)**. In PowerShell, from the download directory and the shell configured for your chosen Profile, set the filename to the package you downloaded:

```powershell
$swarmPackage = (Resolve-Path './dsh-agent-swarm-<version>.tgz').Path
Get-FileHash -Algorithm SHA256 $swarmPackage
Get-Content './SHA256SUMS.txt'
```

Confirm that the hashes match, then install and inspect the composed configuration:

```powershell
dsh plugin --profile web add --workspace-root $swarmPackage
dsh --profile web --dump-config
dsh --profile web --host 127.0.0.1 --port 3180 --no-open
```

Replace `web` with your configured Profile name and choose an unused port. Open the local URL printed by DSH. The bundle enables its plugin group by default; installing it creates no team or member and does not choose a model for you. If required services are missing, the plugin remains pending until the Profile supplies them.

### Update an existing Profile

Let active work finish, retain the installed package, configuration, and persistent data, and stop the Profile. Point `$swarmPackage` at the new, verified tarball and use the official replacement command:

```powershell
dsh plugin --profile web add --workspace-root --force $swarmPackage
```

Restart and check the actual installed version and existing team and Session records. Use a distinct artifact path for each source build. For rollback, retain the previous package and matching configuration, and verify that current data remains readable before resuming work. Automatic migration and lossless rollback are not yet covered; restoring an old backup can discard work recorded since that backup.

## First team

In a root Session, describe an outcome and its acceptance criteria. For example:

```text
Create a delivery team for this repository. Ask its Captain to recruit
implementation and review members, plan tasks with dependencies, and
require executable test results before accepting the work.
```

The Main Brain uses `agent_swarm_create_managed` to delegate, then lets the Captain and members continue in their own Sessions. For approval before work starts, request the plan-first flow: `create_managed(stage=true)`, `set_plan`, then `approve_plan(ask_user=true)`.

Open the Team panel to follow group discussion, tasks, and member profiles. From a profile, open that member's official Session to inspect its records and return to the team. Use the Captain's chat to adjust the team's goal or direction. See the private-chat limitation below before relying on continued member conversations.

Configure defaults under **Settings -> Plugins -> Agent Swarm**. Captains can override their team's communication intensity with `agent_swarm_set_communication`. Model and reasoning choices follow explicit configuration and the initiating Session; no particular model provider is bundled. A queued message confirms queuing, not that a member has read or acted on it.

## Release boundaries and known limitations

- **Recovery scope:** click a member card, open the profile, continue chatting in that member's official Session, and return to group chat. Public-message history and bounded message reads are restored, along with the optional Skills manager described below; it remains disabled in the default Bundle. The restored cancellation guard refuses to cancel a task while another non-cancelled task still depends on it.
- **Follow-up work:** appending members to an existing team remains a later slice. The broader C2/A1/M3/G1 delivery is still incomplete; recovering files or accepting an individual fix does not establish completion of those workstreams.
- **Member private chat:** v0.1.2 restored continued conversation in the same official member Session, including when its Captain is unavailable; see [issue #286](https://github.com/leinasi2014/dsh-agent-swarm/issues/286). The interface accepts text and image messages; real-model acceptance currently covers text. Ordinary file attachments are refused with the draft retained.
- **v0.1.3 adds the optional Skills manager described below.** It is not enabled by the default Bundle and is absent from the v0.1.2 tarball. New selective-collaboration quotas remain under development. Check the installed package's [release notes](https://github.com/leinasi2014/dsh-agent-swarm/releases) for its accepted scope.
- **Local execution is the delivered target.** Remote members, cross-process distributed coordination, a Canvas consumer, and automatic Skill evolution remain outside the delivered scope.
- **Acceptance is bounded.** Automatic upgrades, data migration, long-duration stability, and a release-wide recovery and accessibility matrix are not established by the current release. Engineering checks and real Profile acceptance are separate evidence.

The [implementation roadmap](docs/07-implementation-roadmap.md) defines the remaining capability boundaries and acceptance criteria (Chinese).

### Private-note recall

Since v0.1.2, member-note maintenance and optional recall are available for a member's current task. Recall defaults to `disabled`; the Profile owner can set `privateMemoryRecall: active-task` in the Agent Swarm Host configuration. Members and Captains cannot enable it through prompts or tool approvals. See the [private-memory contract](docs/04-core-protocol.md) (Chinese). These additions are not included in the v0.1.1 tarball.

### Optional Skills manager (v0.1.3)

The separate `dsh-agent-swarm/skills` Host plugin manages skill requests, immutable candidates, Captain review, and approved version assignments. The default Bundle does not enable it. The Profile must already supply the main Swarm runtime, official agent and storage services, the Skills registry, and the selected model provider.

Save an additional Profile patch as `swarm-skills.yml`, replacing the placeholders with your Host's exact workspace scope, Team ID, and configured model route:

```yaml
- insert:
    - id: agent-swarm-skills
      name: dsh-agent-swarm/skills
      config:
        manager:
          provider: REPLACE_WITH_PROVIDER_ID
          model: REPLACE_WITH_MODEL_ID
        management:
          - scope: REPLACE_WITH_EXACT_HOST_WORKSPACE_SCOPE
            teamId: REPLACE_WITH_TEAM_ID
```

The scope is the canonical Session workspace, not an attempt's execution directory. An empty `management` list authorizes no teams. Supply both manager route fields; one missing field is invalid, and omitting both returns `unavailable`. The manager does not inherit the Captain's model or general tool permissions.

Inspect the composed configuration, then launch with the same overlay:

```bash
dsh --profile web --patch ./swarm-skills.yml --dump-config
dsh --profile web --patch ./swarm-skills.yml --host 127.0.0.1 --port 3180 --no-open
```

For an authorized, active Team:

1. The Captain submits `agent_swarm_skills_request` and reads `agent_swarm_skills_status`; status reads do not call a model.
2. The manager uses its scoped `skills_management_investigate` tool for investigation and batch acknowledgement, and `agent_swarm_skills_propose` to capture a candidate. Proposing does not publish it.
3. The Captain reads the captured body with `agent_swarm_skills_candidates`, then calls `agent_swarm_skills_review` with `decision: approve` or `reject`. The author cannot approve its own candidate.
4. The Captain uses `agent_swarm_skills_assign` with the exact `skill_name`, `version`, member Session ID in `member`, and `expected_revision`. Use `0` for a new assignment or the current revision to select another approved version, including rollback.

An already loaded skill stays fixed for the current task attempt, including after the member's Agent is released and resumed. A changed assignment takes effect at the next valid task attempt. Assignment preserves the Team allow-list, and a stored assignment alone does not prove that the member loaded or benefited from it.

This slice supports captured skill text with an empty resource tree. Complete resource bundles, outcome-based rejection of proposals that provide no benefit, demonstrated improvement on real work, and complete observation and reuse across teams remain unfinished. See the [Skills contract](docs/04-core-protocol.md) and [roadmap](docs/07-implementation-roadmap.md) (Chinese).

<details>
<summary>Earlier Team panel screenshot</summary>

This real screenshot was captured on 2026-09-09 with DSH `0.1.2-rc.1`. It shows the earlier team and task layout, before the current group-chat interface; it is not a screenshot of the current compatibility baseline.

![Earlier DSH Team panel with multiple teams and member trees](docs/assets/readme/team-workbench.jpg)

</details>

## Documentation

Most detailed product and architecture documents are currently in Chinese.

| Read this | For |
|---|---|
| [Documentation index](docs/README.md) | Reading order and registered authorities |
| [Product charter](docs/GOALS.md) | Goals, scope, and completion criteria |
| [Capability architecture](docs/03-capability-family.md) | Sessions, services, providers, and state ownership |
| [Core protocol](docs/04-core-protocol.md) | Tasks, messages, permissions, persistence, and recovery |
| [Team UI](docs/10-team-ui-layout.md) | Team panels, navigation, and interaction contracts |
| [Testing and verification](docs/08-testing-verification.md) | Engineering checks and real Profile acceptance |
| [Compatibility policy](docs/11-official-first-development.md) | Official DSH interfaces and evidence requirements |

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before editing. From a repository checkout, using the Node.js and pnpm versions above:

```bash
pnpm install --frozen-lockfile
pnpm verify:isolation:status
pnpm verify:candidate
pnpm pack --pack-destination ./artifacts
```

`verify:candidate` includes the engineering checks, tests, build, and package validation. Its managed-Team product-evidence result can be `NOT_CONFIGURED` when the external acceptance evidence is absent; a passing engineering run does not establish full product acceptance. The required evidence is described in [Testing and verification](docs/08-testing-verification.md).

Use the project-managed `pnpm isolation open|status|close|reconcile` lifecycle for writer allocations. Run `pnpm verify:policy` when governance, instructions, or document authority changes, and `pnpm verify:compatibility` when official or reference compatibility affects a decision. Source packages are development artifacts; validate them in an isolated Profile before updating a working installation.

## License

[MIT](LICENSE)
