import type { ToolContext } from "@opencode-ai/plugin"
import { Effect } from "effect"

export async function publishToolMetadata(
  context: Pick<ToolContext, "metadata">,
  update: Parameters<ToolContext["metadata"]>[0]
): Promise<void> {
  // OpenCode 1.18.18 returns an unexecuted Effect despite its void type:
  // https://github.com/anomalyco/opencode/issues/37877
  const result = context.metadata(update) as unknown
  if (Effect.isEffect(result)) {
    await Effect.runPromise(result as Effect.Effect<unknown, unknown>)
  }
}
