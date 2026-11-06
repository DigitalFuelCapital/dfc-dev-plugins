# Dev Autotask

Complete one large development task as one PR, with an approved plan, automatic review,
and an explicit decision to merge. Internal milestones help organize the work while
remaining on the same task branch and PR.

`dev-autotask` is a separate plugin from `dev-autofix`. It does not consume the small-fix
queue, the last-run manifest, a subscription-budget snapshot, or the small-fix diff
limit. Dependency, schema, build and CI changes can be part of an approved task when
repository rules allow them.

## Install

Add or update the private DFC marketplace, then install:

```text
/plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
/plugin install dev-autotask@dfc-dev-plugins
```

If the marketplace is already installed, refresh it with
`/plugin marketplace update dfc-dev-plugins` before installing. `dev-autofix` does
not need to be installed.

## Workflow

| Command | Result |
| --- | --- |
| `/dev-autotask:plan` | Investigate one requested task and save its proposed plan, acceptance criteria and validation strategy. Present the plan for approval before source changes. |
| `/dev-autotask:run` | Record approval of the current plan, implement its milestones on the task branch, verify the result, open or update its single PR, and invoke review automatically. |
| `/dev-autotask:review` | Review the current PR against the approved plan and acceptance criteria, retaining unresolved findings from earlier rounds. |
| `/dev-autotask:finish` | Address findings and verify the changes on the same branch. Merge only when the invocation includes `merge` or the current user request explicitly asks to merge. |

Start with `/dev-autotask:plan` and describe the task. After reviewing the saved plan,
explicitly approve it and invoke `/dev-autotask:run`. Existing approval in the conversation
is sufficient; the workflow records that approval before implementation. A material
plan change needs approval of the revised plan.

Run implements and reviews automatically. Review findings can then be handled with
`/dev-autotask:finish`; invoke review again when needed. A clean automated review does not
grant permission to merge. A merge request still requires an applicable review of the
current head, passing verification and required checks, and confirmation that the
current base integrates safely. Publishing a new task head requires another review.

Use the task ID reported by plan when resuming any phase. The task branch is
`dev/autotask-<task-id>`. Each phase reads the same durable task record, so an
interrupted invocation continues the existing task instead of opening another PR.
See [the shared workflow contract](references/workflow.md) for the phase and recovery
procedures.

## Configuration

Use `dev-autotask.config.json` for this workflow. There is no separate init command:
`/dev-autotask:plan` resolves the config and helps create it when missing. Adapt
[the example](examples/task.config.json) and use the repository's actual verification
commands; the example commands are placeholders, not inferred project requirements.
The complete contract is in [the config schema](schema/task.config.schema.json).

The config selects one repository through `repo.path`, `repo.remote` and
`repo.baseBranch`. `repo.verify` must contain at least one non-interactive command.
Optional `install`, `lockfile`, `prepare`, `commandTimeoutSeconds` and `forbidden`
fields describe its setup, execution deadlines and hard rules. JSON Schema defaults
are documentation until explicitly applied by the runtime.

The default runtime root is `~/.claude/dev-autotask`. `worktreeRoot` may be an absolute
path or start with `~/`, and must resolve outside the main checkout. The workflow
retains a task's state and worktree separately:

```text
<worktreeRoot>/tasks/<owner>/<repository>/<task-id>/task.json
<worktreeRoot>/tasks/<owner>/<repository>/<task-id>/plan.md
<worktreeRoot>/worktrees/<owner>/<repository>/<task-id>/
```

`<owner>/<repository>` is the configured `repo.remote`. Task IDs, repository identity,
branch/PR identity and the approved plan are checked when resuming. Keep these records
between sessions; they carry review and validation evidence as well as progress.

## Worktrees and validation

Implementation runs in the task's managed worktree. The workflow checks ownership and
repository identity before local work and preserves unfinished changes on interruption.
It does not clear an unrelated dirty checkout to make progress. Resolve a reported
ownership or recovery blocker before resuming that task.

Verification uses configured setup and checks plus the plan's acceptance tests. Each
command has a deadline, defaulting to 600 seconds, and timeout cleanup stops its process
group. The local helpers require Node.js 20+, Git with `merge-tree --write-tree`, and a
POSIX shell/process groups (macOS or Linux). GitHub operations use the connected tools
or an authenticated `gh` CLI. Missing setup, failed checks and unresolved findings remain visible blockers.
Review the current PR head, then verify integration with the current base before a
requested merge. Repository rules, signing requirements and configured `forbidden`
rules apply throughout.

## Scope

This version supports one repository, one task branch and one PR per task. Tasks can
span many files and include multiple implementation milestones. Cross-repository
delivery, milestone PR stacks, production deployment and production migrations need
their own explicit scope; completing or merging a task does not authorize those actions.
