# DBG-024 — Eager member start races the first authoritative assignment

Status: `VERIFIED_PROFILE_MITIGATION / PRODUCT_DEFAULT_IMPLEMENTED / OMITTED_DEFAULT_PROFILE_PROVEN`

Observed: 2026-08-26 in three fresh official DSH `web` Profile runs.

Scope: `dsh-agent-swarm`; official DSH source remained unchanged. The Captain used the
configured `zai-coding-cn / glm-5.3` route and the member used an explicit OpenAI-compatible
`dsv4f-207 / DeepSeek-V4-Flash-0731` route.

## Representative failure

With legacy `lazyMemberStart: false`, adding a member immediately opened a model turn whose
first user frame was the join notice. While that turn was active, the Captain created the
member's task. The member listed and claimed the new task before the official assignment frame
was delivered to its model turn. Two early `agent_swarm_submit_task` calls were therefore
correctly rejected with `task assignment has not reached the member model`. After the next
official member turn received the assignment frame, the same member submitted successfully.

This was not a Provider capability failure. The submission fence prevented an unevidenced model
from completing work, but eager startup created an avoidable race and extra model turns.

## Clean mitigation proof

The Profile was restarted with `lazyMemberStart: true` and the scenario was repeated in a new
workspace, new Captain Session, new Team, new member Session, new task and new Attempt.

- the member's first user message was the exact Captain assignment frame;
- the member Session requested `dsv4f-207 / DeepSeek-V4-Flash-0731`;
- the member used the shell tool, called `agent_swarm_submit_task` exactly once, and the call
  succeeded on the first submission;
- Team authority finished with assignment `delivered`, Attempt `accepted`, task `completed`,
  one request and zero retries;
- the GLM-5.3 Captain reviewed and accepted the result;
- no eager join-only model turn and no assignment-not-delivered rejection occurred.

Authoritative run identities: Captain Session
`session-f852e80d-9f2d-4d97-9455-c967c83f5256`, Team
`team-3692ae0e-dd7d-43e0-9a71-02e2be3b2b3b`, member Session
`e2c947d8-d207-4627-b674-f61b8f7f1159`, Attempt
`attempt-fea11e19-4c80-4c53-965c-267982a962d5`.

## Product decision

Legacy-v1 now defaults to lazy first-assignment startup. `lazyMemberStart: false` remains an
explicit compatibility opt-out; fresh-v2 accepts omitted/`true` and rejects `false` because it
has no eager mode. The submission fence remains unchanged and no timing delay was added. The
existing mixed-Provider Profile run above used explicit `true`, so it proves the behavioral
mitigation but not the omitted-key product default.

## Omitted-key product-default proof

The exact candidate at repository commit `8c6373350f2b0ba8162af423ed59e4c396571ab0`
was packed as `dsh-agent-swarm-0.1.0.tgz` with SHA-256
`ED59A73C63758AD2E142C97DFE86D001AE96F017B3B4353355447BE0AC3D1A27`, installed into the
official `web` Profile, and the `lazyMemberStart` key was absent from Profile configuration.
Official DSH source stayed clean at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

The clean run used a new Captain Session, Team, member Session, task and Attempt in an empty
workspace. The GLM-5.3 Captain created the Team and assigned the only task to an explicitly
routed `dsv4f-207 / DeepSeek-V4-Flash-0731` member. Physical member Session evidence proves:

- the first user message was the exact assignment frame, not a join notice;
- the request header and model-authored records used the requested Provider and model;
- the member invoked `pwsh`, then called `agent_swarm_submit_task` once successfully;
- Team authority ended with assignment `delivered`, Attempt `accepted`, task `completed`, one
  request and zero retries;
- the Captain reviewed and accepted the submission, and no infrastructure error occurred.

Authoritative run identities: Captain Session
`session-758d134b-bab9-43e4-b00e-0846538d8b3e`, Team
`team-6a951b95-37df-42a5-aaca-c6207e4f93cf`, member Session
`425f380f-9a9e-4b3d-afdb-b4310312e708`, task `task-1`, Attempt
`attempt-8d77ab5a-6402-47b3-b83f-cabb408a425d`.

This upgrades the omitted-key legacy product-default claim from pending to proven for a
quiescent Profile install. Until a per-member start policy is durable, setting changes remain
supported only after quiescing Teams so no member remains `provisioning`; arbitrary in-flight
upgrade compatibility is still not claimed.
