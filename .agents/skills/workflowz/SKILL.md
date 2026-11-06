---
name: workflowz
description: Run a large task as a multi-agent workflow on Kestrel's delegation tools (delegate_batch, delegate_task, delegation_wait). Use when the user says "workflowz", or asks for broad research, a multi-area review, a migration or another task that splits into independent parts worth running in parallel.
---

# workflowz

You are the coordinator. Split the task into independent pieces, run them as delegated Kestrel threads in parallel,
then integrate and verify the results yourself. The user gets one finished outcome, not a pile of child reports.

Delegated children are separate threads with their own workspace and their own conversation. They see nothing of
yours: no files, no messages, no checkout unless you ask for one. Everything a child needs goes into its message.

## 1. Scout before you split

- Read enough of the code, docs or thread to know the real shape of the work. Bad splits come from guessing.
- Call `delegation_capabilities` once for the current limits (batch size, depth, wait timeout, models).
- If the task is small, sequential, or every piece touches the same files, do it yourself. Say so and skip the
  workflow. Parallel agents cost money and merge conflicts cost time.

## 2. Plan the phases

Write a short plan for the user before dispatching: phases, the children in each, and what each one returns.

- **Independent within a phase.** Children in one batch must not edit the same files or depend on each other's
  output. Work that depends on a result goes in a later phase.
- **Typical shape:** research/scout → implement in parallel slices → review/test in parallel → integrate.
- **Pick the role** that fits each child: `research`, `implementation`, `review`, `design`, `test` or `general`.
- **Pick the model** only when there is a reason (cheap fan-out research, a hard design question); otherwise omit
  it and the child inherits yours.

## 3. Write self-contained assignments

Each message must stand alone. Include:

- the goal of the whole task in one or two sentences, and this child's slice of it;
- exact paths, symbols, branch names, links and constraints you already found (don't make it rediscover them);
- what it must not touch (files owned by other children, `main`, production);
- the deliverable and how to verify it (commands to run, what "done" looks like);
- for code changes: the repository (`repo`), the base branch (`baseBranch`), the branch name to work on, and that
  it must commit and `git_push` its branch but **not** open a pull request unless you say so;
- that it must follow the repository's `AGENTS.md`.

Put background every child shares in `delegate_batch`'s `context` instead of repeating it in each message. Use
`outputSchema` when you will combine results mechanically (for example a list of findings with file, line,
severity), so every child answers in the same shape.

## 4. Dispatch

- `delegate_batch` for a phase of up to 10 parallel children. Give it a stable, descriptive `requestId`
  (for example `workflowz-<topic>-phase1`). If a dispatch fails partway, retry with the **same** `requestId`: started
  children are kept and the rest launch.
- `delegate_task` for a single child; pass a stable `requestId` too.
- Tell the user what you started: one line per child with its title and thread id.

## 5. Collect

- Results arrive on their own as automatic notifications when each child's run ends. Do not `thread_send` to a
  child about its result, and do not answer its questions: a child's question belongs to the user in that thread.
- Use `delegation_wait` (at most 30 seconds per call) when your next step needs a child's result now; loop over the
  outstanding children. Use `delegation_status` to reread a result later.
- While children run, do the parts only you can do: integration scaffolding, the next phase's plan, verification
  setup.
- If a child is stuck, failed or went off course, `delegation_cancel` it and redo that slice with a sharper
  assignment, or do it yourself. Never report its work as done.

## 6. Integrate and verify

You own the result.

- Read every child result critically. Check claims against the code; children can be wrong or overconfident.
- For code: fetch each child's pushed branch into your checkout, review the diff, and combine the branches
  (merge or cherry-pick) into one branch. Resolve conflicts yourself.
- Run the real verification on the combined result (typecheck, tests, builds, exercising the change) as the
  repository requires. A child's "it passed" is not evidence for the combined branch.
- Add a review or test phase when the change is risky: delegate independent reviewers over the combined diff,
  then fix what they confirm.

## 7. Report

Give the user one answer: what was done, what was verified and how, what was not done or failed, and links to
the pull request or branches. Mention the child threads only where the user may want to read one.
