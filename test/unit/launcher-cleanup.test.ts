import { describe, expect, it } from "vitest"
import {
  LAUNCHER_CLEANUP_STEPS,
  runLauncherCleanup,
  type LauncherCleanupStep,
} from "../../src/cli.js"

describe("launcher cleanup", () => {
  it.each([
    "opencode",
    "ready-marker",
    "mirror",
    "master",
    "socket",
    "listeners",
  ] satisfies LauncherCleanupStep[])(
    "continues through every owned step when %s cleanup fails",
    async (failedStep) => {
      const calls: LauncherCleanupStep[] = []
      const injected = new Error(`${failedStep} cleanup failed`)
      const operations = Object.fromEntries(
        LAUNCHER_CLEANUP_STEPS.map((step) => [
          step,
          async () => {
            calls.push(step)
            if (step === failedStep) throw injected
          },
        ])
      ) as Record<LauncherCleanupStep, () => Promise<void>>

      const failures = await runLauncherCleanup(operations)

      expect(calls).toEqual(LAUNCHER_CLEANUP_STEPS)
      expect(failures).toEqual([{ step: failedStep, error: injected }])
    }
  )
})
