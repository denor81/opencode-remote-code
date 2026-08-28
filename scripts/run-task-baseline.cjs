const {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} = require("node:fs")
const { spawnSync } = require("node:child_process")
const os = require("node:os")
const path = require("node:path")

const expectedVersion = "1.18.18"
const suiteName = "real installed OpenCode Task through opencode-ssh"
const expectedScenarioFullNames = [
  "runs one real root-to-general-child Task with SSH-backed tools",
  "runs concurrent direct siblings and clamps configured depth seven",
  "preserves an inherited session deny for read",
  "preserves explicit subagent depth zero without creating a child",
  "propagates root session abort to two child SSH slaves without retry",
  "resumes one completed direct child only when startup qualification enables it",
].map((title) => `${suiteName} ${title}`)
const expectedScenarios = expectedScenarioFullNames.length
const selected = process.env.OPENCODE_TASK_TEST_BINARY

if (!selected) {
  process.stderr.write(
    "Exact OpenCode Task baseline requires OPENCODE_TASK_TEST_BINARY pointing to an executable\n"
  )
  process.exit(1)
}

let resolved = "[unresolved]"
try {
  resolved = realpathSync(path.resolve(selected))
} catch {
  // The non-skipping test gate reports the selected-path failure in detail.
}

process.stdout.write(
  `Exact OpenCode Task baseline selection: ${JSON.stringify({
    originalCommandPath: selected,
    resolvedExecutable: resolved,
    expectedVersion,
  })}\n`
)

const vitest = path.join(__dirname, "..", "node_modules", "vitest", "vitest.mjs")
const reportRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-task-baseline-"))
const reportPath = path.join(reportRoot, "result.json")
const result = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "test/integration/opencode-subagent.test.ts",
    "--reporter=verbose",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  ],
  {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      OPENCODE_TASK_TEST_BINARY: selected,
      OPENCODE_TASK_TEST_EXPECTED_VERSION: expectedVersion,
    },
    stdio: "inherit",
  }
)

try {
  if (result.error) {
    throw new Error(`Failed to start exact OpenCode Task baseline: ${result.error.message}`)
  }
  if (result.signal) {
    throw new Error(`Exact OpenCode Task baseline ended from signal ${result.signal}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `Exact OpenCode Task baseline scenarios failed with exit code ${result.status ?? "unknown"}`
    )
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"))
  const assertions = Array.isArray(report?.testResults)
    ? report.testResults.flatMap((testResult) =>
        Array.isArray(testResult?.assertionResults)
          ? testResult.assertionResults
          : []
      )
    : []
  const receivedScenarioFullNames = assertions.map((assertion) =>
    typeof assertion?.fullName === "string" ? assertion.fullName : "[invalid fullName]"
  )
  const exactManifest =
    JSON.stringify([...receivedScenarioFullNames].sort()) ===
    JSON.stringify([...expectedScenarioFullNames].sort())
  const accepted =
    report !== null &&
    typeof report === "object" &&
    report.success === true &&
    report.numTotalTests === expectedScenarios &&
    report.numPassedTests === expectedScenarios &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0 &&
    report.numTodoTests === 0 &&
    assertions.every((assertion) => assertion?.status === "passed") &&
    exactManifest
  if (!accepted) {
    throw new Error(
      `Exact OpenCode Task baseline requires the exact six-scenario manifest with zero failed, skipped, or todo scenarios; received ${JSON.stringify(
        {
          success: report?.success,
          total: report?.numTotalTests,
          passed: report?.numPassedTests,
          failed: report?.numFailedTests,
          skipped: report?.numPendingTests,
          todo: report?.numTodoTests,
          expectedScenarioFullNames,
          receivedScenarioFullNames,
          assertionStatuses: assertions.map((assertion) => assertion?.status),
        }
      )}`
    )
  }
  process.stdout.write(
    `Exact OpenCode Task baseline accepted: ${expectedScenarios} passed, 0 failed, 0 skipped\n`
  )
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  rmSync(reportRoot, { recursive: true, force: true })
}
