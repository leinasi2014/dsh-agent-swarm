# dsh-agent-swarm operation guide

Use the tool schemas exposed by the active runtime as the final argument authority. This guide defines the safe operating sequence and recovery semantics; it contains no current Team state.

## Configure and start

Before creating durable state, inspect the active plugin Settings and assembled Profile. Confirm the member Provider and optional LLM route, scheduler Provider, review Provider/root, and whether the jobs projection or execution roots are enabled. These are live configuration facts; do not infer them from the generated graph. Unknown Providers and incomplete model routes fail loudly. Changing these plugin configuration contracts or their implementation belongs to `$dsh-plugin-development`.

1. Call `agent_swarm_create` with a concrete Team `name` and completion-bounded `description`. The caller becomes captain.
2. Optionally call `agent_swarm_set_budget` before dispatch. Configure only limits the work actually needs; a task reservation is inert when no Team token limit exists.
3. Add each continuable member with `agent_swarm_add_member`:
   - `name` is immutable; `role` states one bounded responsibility.
   - `provider` selects the continuable subagent Provider.
   - `llm_provider` and `model` select the official model route and must be treated as a pair when overriding it.
   - `skills` assigns validated Skill names; assignment does not prove they are loaded.
   - `deny_tools` only narrows the mandatory Team-safe policy. It is not an allow list, and unknown names fail provisioning.
4. Create dependency-aware work with `agent_swarm_create_task`. Include a complete `description`, evidence-based `acceptance_criteria`, existing task ids in `blocked_by`, advisory workspace-relative `write_scopes`, and frozen `verification` declarations. Use `reservation_tokens` only as a justified minimum floor; it is not usage accounting or permission.

Ready unowned tasks may be scheduled automatically. A manual participant claims a ready task with `agent_swarm_claim_task(task_id, expected_revision)` using the exact revision returned by the current task row. Preserve the returned `attempt_id`, generation, and optional execution root. Submit only that generation with `agent_swarm_submit_task(task_id, expected_revision, attempt_id, output, evidence)`. Submission is never completion: the captain inspects evidence and calls `agent_swarm_review_task` with the exact revision and attempt, accepting or rejecting it.

Start with the smallest Team that covers independent work: ordinarily one captain plus two or three members. Add a member only when it unlocks a real parallel path or missing capability. Do not create observer, coordinator, verifier, or documentation roles whose work can be handled by the captain or the existing candidate gate.

## Observe and communicate

- `agent_swarm_status` is the fixed-size live summary and current Team revision.
- `agent_swarm_list_tasks` is the authoritative bounded task read face for owner, revision, attempt, readiness, dependency, hold, and stranded hints. Follow `next_cursor` when present.
- `agent_swarm_list_jobs` reads only the optional jobs projection. It never creates or cancels work and fails loudly when that projection is disabled.
- `agent_swarm_send_message(..., delivery: "quiet")` persists information without waking the recipient. An inactive recipient keeps it queued until a wakeup or its own return.
- `delivery: "wakeup"` is the ordinary way to resume an inactive member. A queued result is durable; do not resend it automatically. Read the Team to determine whether delivery or follow-up is still owed.
- Store shared durable decisions and lessons with `agent_swarm_add_memory`. Store member-owned notes with `agent_swarm_add_personal_memory`; a captain writing for a member must name the active owner. Read authorized Team, personal, or combined records with `agent_swarm_list_memory(scope: "team"|"personal"|"all")`. Semantic ranking is advisory and may degrade to deterministic ranking.

## Supervise long-running work

Repeat this bounded loop until every required task reaches an accepted terminal result or a real blocker needs user authority:

1. Read `agent_swarm_status`, then page/filter `agent_swarm_list_tasks`; use `agent_swarm_list_jobs` only when the projection is enabled and execution detail is relevant.
2. Act on ready work, dependency changes, submitted review candidates, explicit holds, or authoritative stranded evidence.
3. Send `quiet` context that can wait. Send one `wakeup` when an inactive member must resume; do not duplicate already queued content.
4. Call `agent_swarm_wait(after_revision: <current Team revision>)` instead of polling. A returned revision change may be unrelated activity, not elapsed time or proof of a stall.
5. If wait returns `no_progress`, re-read `agent_swarm_status` and `agent_swarm_list_tasks`, wake each required inactive member once, then wait from the new revision. Do not infer failure from silence, planning time, missing file changes, or the number of waits.
6. Review submitted attempts against their frozen acceptance criteria and verification evidence. Rejected work proceeds through a fresh fenced attempt; accepted captain review is the canonical completion gate.

## Recovery and lifecycle boundaries

- On `TEAM_ATTEMPT_STALE`, stop work and submission immediately. Never continue under or reuse the old `attempt_id`.
- Revision failures are CAS failures: re-read the task, decide against its current revision/owner/attempt, then issue a fresh exact-state operation. Do not blindly retry a stale mutation.
- If a mutating call has an unknown result, query `status`/`list_tasks`/the relevant read face before retrying. A timeout is not proof the commit failed.
- `agent_swarm_reassign_task` is captain-only: it fences the current attempt, returns the task to pending, and permits a fresh scheduled attempt. Use the exact task revision and a concrete reason.
- `agent_swarm_interrupt_member` is emergency control for a host-confirmed long-running unmatched tool call. It preserves inbox, task ownership, and membership. It is not progress management and must not be used for silence or slow model output; ordinary recovery is wakeup plus wait.
- `agent_swarm_remove_member` fences that member's open attempts, requeues their tasks, cancels queued mail to them, and drains the child. Use it only when membership itself must end.
- `agent_swarm_archive` irreversibly archives the active Team, cancels unfinished tasks and queued messages, fences attempts, and drains all members. Archive only after reading current state and confirming the Team should end.

Configuration or operating mistakes may be diagnosed with these read faces and the generated graph. Changes to plugin code, configuration schemas, runtime behavior, tools, storage, or tests belong to `$dsh-plugin-development`.
