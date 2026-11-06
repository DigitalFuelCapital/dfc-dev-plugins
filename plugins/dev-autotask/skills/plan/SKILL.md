---
name: plan
description: Plan one large development task as one PR. Investigate the code, define acceptance criteria and implementation milestones, save a durable plan, and wait for the user's approval before implementation.
disable-model-invocation: true
argument-hint: "[task-id] <task description or issue>"
---

# Plan one large task

Read the [shared workflow](../../references/workflow.md). This phase authorizes
investigation and local config/task/plan records. Present a concrete plan before asking
for approval. Do not implement source changes, create the implementation branch/PR,
publish comments, or merge in this phase.

1. Resolve config and the requested repository. If config is missing, inspect the
   current repository and its documented setup, then create a local
   `dev-autotask.config.json` from the [example](../../examples/task.config.json), using
   actual remote, absolute path, base branch and verification commands. Ask only for
   missing facts that inspection cannot establish. Do not alter global client settings.
   Validate against the [schema](../../schema/task.config.schema.json) and runtime helper.
2. Resolve a stable task ID and acquire its lock. Inspect any existing record before
   creating anything. For a new task, fetch/record the base SHA, then `create` with the
   original request, title and exact base. On resume, retain original request, PR and
   completed progress. An explicitly requested replan revises this same task.
3. Read applicable repository instructions and trace the current behavior at the exact
   base. Inspect callers, data contracts, tests, related open PRs and existing designs.
   Verify issue/audit claims in code. Ask early about material product decisions; keep
   researching independent parts while waiting. Do not invent requirements.
4. Save `<taskDir>/plan.md` using the format below. Milestones organize implementation
   inside one branch and PR; they do not become a small-fix queue. Large changes to
   dependencies, schemas, configuration and CI are allowed when needed by this task
   and repository rules. Describe their compatibility, test and rollout implications.
   Production deployment or migration execution needs separate explicit authorization.
5. Run `save-plan` with the investigated base SHA. Present the plan, important choices,
   acceptance criteria, validation strategy and saved path. Explain that approval of
   this plan authorizes `/dev-autotask:run` to implement, publish its single draft PR
   and review it. Merging requires a later explicit request. Release the lock and stop
   for plan approval; do not mark the plan approved yourself.

## Plan format

```markdown
# <Task title>

## Request and baseline
Original request, task ID, repository/base branch and investigated base SHA.

## Outcome and acceptance criteria
Numbered, observable criteria, including failure/edge cases and compatibility.

## Scope and decisions
In-scope behavior/files/contracts; explicit exclusions; resolved choices and rationale.
Unresolved decisions are blockers, with the exact question needed to resolve each.

## Implementation milestones
Ordered steps, dependencies, likely files, and expected evidence of completion.

## Validation
Configured prepare/verify commands, acceptance tests to add/run, manual checks,
fixtures and environment needs. State any coverage limits.

## Delivery and recovery
One PR, rollout/deployment instructions if applicable, migration/compatibility risks,
and how to resume or recover without discarding unfinished work.
```

A material change to scope, acceptance criteria or approach requires presenting and
approving the revised plan. Routine implementation details within the approved scope
do not require repeated confirmation. Keep progress in checkpoints instead of editing
the approved plan on each milestone.
