import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"

/**
 * Enforces rule 1 of docs/state-machines.md (one writer per machine) for the lifecycle fields the transition
 * functions own. A phase field may be changed only by its writer; every other module prepares an event instead.
 *
 * The scan is syntactic: it flags a member assignment (any assignment operator, `++`/`--` included), a `delete`, an
 * `Object.assign` object-literal entry naming a lifecycle field, and a non-literal `Object.assign` source copied onto
 * a stored target. Object literals that construct a record, comparisons, and assignments to local variables are not
 * mutations of an existing phase and stay legal.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")

/** The files allowed to mutate lifecycle fields, and the writer each is expected to hold. */
const ALLOWED_WRITERS: Readonly<Record<string, string>> = {
  "packages/server/src/core/state.ts": "applyTaskEvent",
  "packages/server/src/core/run-state.ts": "applyRunEvent",
  "packages/server/src/core/delegation-state.ts": "applyDelegationEvent",
  "packages/control/src/nest-transition.ts": "applyNestBoxEvent",
  "packages/server/src/desktop/desktop-state.ts": "applyDesktopEvent",
  "packages/control/src/delivery-state.ts": "applyDeliveryEvent",
}

/** The lifecycle fields, each with the writer that owns it. Names come from the six writer modules. */
const LIFECYCLE_FIELDS: Readonly<Record<string, string>> = {
  // task: packages/server/src/core/state.ts (applyTaskEvent)
  status:
    "applyTaskEvent (packages/server/src/core/state.ts) for a task, " +
    "applyRunEvent (packages/server/src/core/run-state.ts) for a run",
  archivedAt: "applyTaskEvent (packages/server/src/core/state.ts)",
  // run: packages/server/src/core/run-state.ts (applyRunEvent)
  endedAt: "applyRunEvent (packages/server/src/core/run-state.ts)",
  exitCode: "applyRunEvent (packages/server/src/core/run-state.ts)",
  interruptedByRestart: "applyRunEvent (packages/server/src/core/run-state.ts)",
  // delegation: packages/server/src/core/delegation-state.ts (applyDelegationEvent)
  delegation: "applyDelegationEvent (packages/server/src/core/delegation-state.ts)",
  runId: "applyDelegationEvent (packages/server/src/core/delegation-state.ts)",
  parentRunId: "applyDelegationEvent (packages/server/src/core/delegation-state.ts)",
  cancelledAt: "applyDelegationEvent (packages/server/src/core/delegation-state.ts)",
  resultAcknowledged: "applyDelegationEvent (packages/server/src/core/delegation-state.ts)",
  // Nest box: packages/control/src/nest-transition.ts (applyNestBoxEvent)
  state:
    "applyNestBoxEvent (packages/control/src/nest-transition.ts) for a Nest box, " +
    "applyDesktopEvent (packages/server/src/desktop/desktop-state.ts) for a desktop",
  createFailed: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  hostId: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  ownerEpoch: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  vmId: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  vmSince: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  wakeWanted: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  pendingId: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  pendingKind: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  pendingCommand: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  pendingDeadline: "applyNestBoxEvent (packages/control/src/nest-transition.ts)",
  // desktop: packages/server/src/desktop/desktop-state.ts (applyDesktopEvent)
  error: "applyDesktopEvent (packages/server/src/desktop/desktop-state.ts)",
  // delivery fire phase: packages/control/src/delivery-state.ts (applyDeliveryEvent)
  outcome: "applyDeliveryEvent (packages/control/src/delivery-state.ts)",
  startedAt: "applyDeliveryEvent (packages/control/src/delivery-state.ts)",
  attempts: "applyDeliveryEvent (packages/control/src/delivery-state.ts)",
}

const ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
])

const INCREMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
])

const FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(LIFECYCLE_FIELDS))

/**
 * A lexer prefilter for the constructs `scanTransitionWrites` collects. Parsing every source is slow, and a file with
 * no candidate write cannot violate the rule. The scanner skips comments, so whitespace and comments cannot hide a
 * write from it. It errs toward parsing: a stray `delete`, `Object.assign` or increment only costs time.
 */
const hasWriteCandidate = (source: string): boolean => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source)
  const kinds: ts.SyntaxKind[] = []
  const values: string[] = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    kinds.push(kind)
    values.push(scanner.getTokenValue())
  }
  const isField = (index: number): boolean =>
    kinds[index] === ts.SyntaxKind.Identifier && FIELD_NAMES.has(values[index] ?? "")
  const isFieldString = (index: number): boolean =>
    kinds[index] === ts.SyntaxKind.StringLiteral && FIELD_NAMES.has(values[index] ?? "")
  const isAssignment = (index: number): boolean => {
    const kind = kinds[index]
    return kind !== undefined && ASSIGNMENT_OPERATORS.has(kind)
  }
  const isIncrement = (index: number): boolean => {
    const kind = kinds[index]
    return kind !== undefined && INCREMENT_OPERATORS.has(kind)
  }
  // A prefix `++obj.field` puts the operator before the receiver, at no fixed distance, so any increment in a file
  // that touches a lifecycle field makes the file a candidate. Postfix stays precise.
  const hasIncrement = kinds.some((_kind, index) => isIncrement(index))
  return kinds.some((kind, index) => {
    if (kind === ts.SyntaxKind.DotToken) {
      if (isField(index + 1)) {
        if (isAssignment(index + 2) || isIncrement(index + 2) || hasIncrement) return true
      }
      return values[index - 1] === "Object" && values[index + 1] === "assign"
    }
    if (kind === ts.SyntaxKind.OpenBracketToken) {
      if (!isFieldString(index + 1) || kinds[index + 2] !== ts.SyntaxKind.CloseBracketToken) return false
      return isAssignment(index + 3) || isIncrement(index + 3) || hasIncrement
    }
    if (kind === ts.SyntaxKind.DeleteKeyword) {
      for (let cursor = index + 1; cursor < Math.min(index + 12, kinds.length); cursor++) {
        if (kinds[cursor] === ts.SyntaxKind.DotToken && isField(cursor + 1)) return true
        if (
          kinds[cursor] === ts.SyntaxKind.OpenBracketToken &&
          isFieldString(cursor + 1) &&
          kinds[cursor + 2] === ts.SyntaxKind.CloseBracketToken
        ) {
          return true
        }
      }
    }
    return false
  })
}

export interface TransitionWriteViolation {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly field: string
  readonly message: string
}

/** The property name a mutation expression targets, for both `.status` and `["status"]` spellings. */
const targetedField = (expression: ts.Expression): string | undefined => {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text
  }
  return undefined
}

/**
 * The object a property name belongs to, ignoring `process`: `process.exitCode` is a CLI exit status, not a run
 * field.
 */
const receiverRoot = (expression: ts.Expression): string | undefined => {
  let current: ts.Expression = expression
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : undefined
}

/**
 * The sources `Object.assign` copies onto a stored target, or undefined for any other call and for a fresh object
 * target. `Object.assign({}, ...)` only constructs a new record, so it mutates no stored phase.
 */
const assignSources = (node: ts.CallExpression): readonly ts.Expression[] | undefined => {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined
  const callee = node.expression
  if (callee.name.text !== "assign" || !ts.isIdentifier(callee.expression) || callee.expression.text !== "Object") {
    return undefined
  }
  const [target, ...sources] = node.arguments
  if (target === undefined || ts.isObjectLiteralExpression(target)) return undefined
  return sources
}

/**
 * Scans one source text for direct mutations of lifecycle fields. `file` is reported verbatim and matched against the
 * allowlist, so pass a repo-relative path; a non-allowlisted file reports every write it finds.
 */
export const scanTransitionWrites = (source: string, file: string): TransitionWriteViolation[] => {
  if (ALLOWED_WRITERS[file] !== undefined) return []
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const violations: TransitionWriteViolation[] = []

  const report = (node: ts.Node, field: string): void => {
    const writer = LIFECYCLE_FIELDS[field]
    if (writer === undefined) return
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      field,
      message: `${file}:${line + 1}:${character + 1}: direct write to lifecycle field "${field}"; use ${writer}`,
    })
  }

  const reportCopy = (node: ts.CallExpression, source: ts.Expression): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    const text = source.getText(sourceFile).replace(/\s+/g, " ").slice(0, 80)
    violations.push({
      file,
      line: line + 1,
      column: character + 1,
      field: "Object.assign",
      message:
        `${file}:${line + 1}:${character + 1}: Object.assign copies lifecycle fields from non-literal source ` +
        `"${text}"; assign them through the machine's writer instead`,
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      const field = targetedField(node.left)
      if (field !== undefined && receiverRoot(node.left) !== "process") report(node, field)
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      INCREMENT_OPERATORS.has(node.operator)
    ) {
      const field = targetedField(node.operand)
      if (field !== undefined && receiverRoot(node.operand) !== "process") report(node, field)
    } else if (ts.isDeleteExpression(node)) {
      const field = targetedField(node.expression)
      if (field !== undefined) report(node, field)
    } else if (ts.isCallExpression(node)) {
      for (const source of assignSources(node) ?? []) {
        if (!ts.isObjectLiteralExpression(source)) {
          reportCopy(node, source)
          continue
        }
        for (const entry of source.properties) {
          if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) continue
          const name = entry.name
          const field =
            ts.isIdentifier(name) || ts.isStringLiteralLike(name)
              ? name.text
              : ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
                ? name.expression.text
                : undefined
          if (field !== undefined) report(entry, field)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

/** Every TypeScript source under the server and control packages that the guard scans. */
const lifecycleSources = (): string[] => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const file = relative(REPO_ROOT, path).split(sep).join("/")
        if (
          (file.startsWith("packages/server/src/") || file.startsWith("packages/control/src/")) &&
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !file.endsWith(".d.ts")
        ) {
          files.push(file)
        }
      }
    }
  }
  walk(join(REPO_ROOT, "packages", "server", "src"))
  walk(join(REPO_ROOT, "packages", "control", "src"))
  return files.sort()
}

describe("transition-writer monopoly", () => {
  test(
    "no module outside the six writers mutates a lifecycle field",
    () => {
      const violations = lifecycleSources().flatMap((file) => {
        const source = readFileSync(join(REPO_ROOT, file), "utf8")
        return hasWriteCandidate(source) ? scanTransitionWrites(source, file) : []
      })
      expect(violations.map((violation) => violation.message)).toEqual([])
    },
    20_000,
  )

  test("every allowlisted file still exports its writer", () => {
    for (const [file, writer] of Object.entries(ALLOWED_WRITERS)) {
      expect(readFileSync(join(REPO_ROOT, file), "utf8")).toContain(`export const ${writer} `)
    }
  })

  test("a direct task status write is reported with the field and its writer", () => {
    const violations = scanTransitionWrites(
      'const task = getTask()\ntask.status = "done"\n',
      "packages/server/src/core/example.ts",
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      file: "packages/server/src/core/example.ts",
      line: 2,
      column: 1,
      field: "status",
    })
    expect(violations[0]?.message).toContain("packages/server/src/core/example.ts:2:1")
    expect(violations[0]?.message).toContain("applyTaskEvent")
  })

  test("compound assignments and deletes are writes too", () => {
    expect(scanTransitionWrites('task.archivedAt ??= "now"', "packages/server/src/core/example.ts")).toHaveLength(1)
    expect(scanTransitionWrites('task.archivedAt ||= "now"', "packages/server/src/core/example.ts")).toHaveLength(1)
    expect(scanTransitionWrites('task.archivedAt &&= "now"', "packages/server/src/core/example.ts")).toHaveLength(1)
    expect(scanTransitionWrites("delete task.archivedAt", "packages/server/src/core/example.ts")).toHaveLength(1)
  })

  test("arithmetic assignments and increments are writes too", () => {
    for (const source of [
      "fire.attempts += 1",
      "row.ownerEpoch -= 1",
      "fire.attempts *= 2",
      "fire.attempts /= 2",
      "fire.attempts %= 2",
      "fire.attempts **= 2",
      "fire.attempts <<= 1",
      "fire.attempts >>= 1",
      "fire.attempts >>>= 1",
      "fire.attempts &= 1",
      "fire.attempts |= 1",
      "fire.attempts ^= 1",
      "row.pendingDeadline++",
      "row.pendingDeadline--",
      "--row.vmSince",
      "++row.vmSince",
    ]) {
      expect(scanTransitionWrites(source, "packages/control/src/example.ts")).toHaveLength(1)
    }
  })

  test("Object.assign entries are writes, and delegation subfields name the delegation writer", () => {
    const assigned = scanTransitionWrites(
      'Object.assign(task, { status: "done" })',
      "packages/server/src/core/example.ts",
    )
    expect(assigned).toHaveLength(1)
    expect(assigned[0]?.message).toContain("applyTaskEvent")

    const computed = scanTransitionWrites(
      'Object.assign(task, { ["status"]: "done" })',
      "packages/server/src/core/example.ts",
    )
    expect(computed).toHaveLength(1)

    const copied = scanTransitionWrites("Object.assign(row, previous)", "packages/control/src/example.ts")
    expect(copied).toHaveLength(1)
    expect(copied[0]?.message).toContain("non-literal source")

    // A fresh target only builds a record; it mutates no stored phase.
    expect(
      scanTransitionWrites('Object.assign({}, { status: "idle" })', "packages/server/src/core/example.ts"),
    ).toEqual([])
    expect(scanTransitionWrites("Object.assign({}, previous)", "packages/server/src/core/example.ts")).toEqual([])

    const delegation = scanTransitionWrites(
      'task.delegation.cancelledAt = "now"',
      "packages/server/src/core/example.ts",
    )
    expect(delegation).toHaveLength(1)
    expect(delegation[0]?.message).toContain("applyDelegationEvent")

    const runId = scanTransitionWrites('task.delegation.runId = "run-1"', "packages/server/src/core/example.ts")
    expect(runId).toHaveLength(1)
    expect(runId[0]?.message).toContain("applyDelegationEvent")
  })

  test("the allowlisted writers and non-mutations stay legal", () => {
    expect(
      scanTransitionWrites('task.status = "done"\n', "packages/server/src/core/state.ts"),
    ).toEqual([])
    // A local variable, a comparison and a fresh object literal are not mutations of a stored phase.
    expect(
      scanTransitionWrites('let status = "idle"\nstatus = "running"', "packages/server/src/core/example.ts"),
    ).toEqual([])
    expect(
      scanTransitionWrites(
        'if (task.status === "done") {}\nconst t = { status: "done" }',
        "packages/server/src/core/example.ts",
      ),
    ).toEqual([])
    // The CLI exit status is not a run field.
    expect(scanTransitionWrites("process.exitCode = 1", "packages/server/src/cli/example.ts")).toEqual([])
    // The prefilter must not be fooled by comments between the field and its operator, and must not parse reads.
    expect(hasWriteCandidate('task.status /* settled */ = "done"')).toBe(true)
    expect(hasWriteCandidate('if (task.status === "done") {}')).toBe(false)
    expect(hasWriteCandidate("--row.vmSince")).toBe(true)
    expect(hasWriteCandidate("row.pendingDeadline++")).toBe(true)
  })
})
