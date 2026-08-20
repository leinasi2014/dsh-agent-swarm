# 12. Independent review management

Status: mandatory. Effective: 2026-08-20.

## 1. Reviewer autonomy

An independent security or architecture reviewer owns the depth, order and natural completion point of its review. Unless the user explicitly sets a bound, the project manager must not impose a time, step, token, turn, model-usage or cost ceiling and must not optimize the review for response latency.

Long reasoning, repeated source inspection and many tool calls are positive evidence of work, not a reason to demand convergence. The review ends when the reviewer reports that its evidence matrix is complete, when the user stops it, or when a genuine blocker prevents further progress.

## 2. Project-manager boundary

The project manager:

- commissions a clear scope and required deliverables;
- provides official/reference locations and current build/test evidence;
- configures the authorized model, reasoning level and Session permissions;
- removes genuine environment, permission or source-access blockers;
- observes coarse progress without interrupting the model's working context;
- receives the report, independently verifies cited evidence and converts accepted findings into remediation work;
- requests re-review after fixes.

The project manager does not:

- tell a healthy reviewer to finish soon, shorten the report or use fewer steps;
- cancel or steer because the review is taking longer than expected;
- treat model subscription/cost assumptions as a limit the user did not set;
- pre-decide severity counts or verdict;
- edit the reviewer's conclusions while the review is running;
- replace an independent review with the manager's own earlier analysis;
- approve destructive or scope-expanding actions merely because runtime access is broad.

## 3. Permission commissioning

When the user explicitly authorizes full access:

1. use a dedicated review Session;
2. select the requested model and reasoning effort;
3. pin `permission/preset=danger-full-access`, `sandbox/mode=danger-full-access` and `approval/policy=never` before the review prompt;
4. read the Session history and verify all three durable facts;
5. if a future-session default was temporarily changed to create the Session, restore the prior default immediately and verify the result;
6. record only non-secret Session/model/permission evidence in the management report.

Runtime permission and task mutation authority remain separate. A full-access reviewer may run diagnostics, tests, network checks and dependency analysis. It may only change files explicitly allowed by the commission—normally one review report. It may not silently repair implementation while acting as the independent reviewer.

## 4. Review commission

A complete commission specifies:

```text
Review objective and threat model:
Project/official/reference roots:
Official-first baseline:
Model and reasoning effort:
Permission facts:
No user-imposed time/token/step limit (or the explicit limit):
Allowed writes:
Required source/test/runtime evidence:
Severity rubric:
Report path and format:
Completion signal:
```

For this project, a full review covers security, Agent execution flow, concurrency/crash recovery, official seam ownership, reference fusion, architecture/milestones, performance/coordination, packaging/supply chain, Windows/Profile/RPC behavior and test gaps.

## 5. Monitoring

Monitoring is deliberately sparse. Prefer durable Session state or the requested report artifact over repeatedly reading the complete transcript. Status updates may state that work is active, blocked or complete; they must not inject urgency or new conclusions into the reviewer context.

Do not send follow-up/steer messages during healthy execution. A message is justified only when:

- the user changes scope;
- the reviewer explicitly asks a question;
- a permission/source/environment blocker requires information;
- a destructive or out-of-scope action must be stopped;
- the runtime is lost or demonstrably stuck without new evidence.

Apparent duration, high step count, token volume or subscription usage is not a blocker.

## 6. Report acceptance

The manager accepts no finding solely because a model said it. For each P0/P1 item:

1. resolve the cited revision and file/line;
2. reproduce or trace the trigger and authority path;
3. confirm current versus future-risk classification;
4. compare existing defenses and tests;
5. accept, downgrade, reject or request clarification with reasons;
6. create remediation tasks only for accepted findings.

The report remains intact as reviewer evidence. Manager annotations or triage go into a separate remediation/verification record.

## 7. Remediation and regression review

The lifecycle is:

```text
independent full review
  → manager evidence triage
  → accepted-finding remediation plan
  → scoped implementation and tests
  → complete local verification
  → independent regression/security re-review
  → milestone status update
```

The same reviewer may perform regression review, but it receives the original report, triage decisions, exact changes and test evidence and retains independent verdict authority.

## 8. Intervention and termination

The manager may interrupt only for explicit user direction, destructive/out-of-scope behavior, credential exposure, compromised/lost runtime, or a repeated external blocker the reviewer cannot resolve. The reason and resulting evidence loss are reported. A healthy long review is allowed to continue without a management deadline.

## 9. Self-hosting development Team management

ADR-0008 applies the same non-micromanagement principle to a development Team while keeping implementation and independent review roles separate. The Lead/Workers own investigation and implementation within the commissioned milestone. The manager observes committed Team/Job/lease/verification state and receives stage or blocker reports; it does not poll private reasoning or push a healthy Team toward early convergence.

The manager still owns scope, stable-control safety and external promotion. It may commission a fresh corrective task from observed evidence, but it may not edit canonical Team state, rewrite a review verdict or let a candidate declare itself promoted. Independent regression review remains a separate Session/role from the implementing Team even when both use GLM-5.3.
