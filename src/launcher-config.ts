import path from "node:path"
import { URL } from "node:url"
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser"

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const LAUNCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export type CliOptions =
  | { action: "launch"; alias: string; workdir: string }
  | { action: "help" }
  | { action: "version" }

export class LauncherConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LauncherConfigError"
  }
}

/** Parse arguments after the opencode-ssh executable name. */
export function parseCli(argv: readonly string[]): CliOptions {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { action: "help" }
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    return { action: "version" }
  }
  if (argv.length !== 2) {
    throw new LauncherConfigError(
      "Usage: opencode-ssh <ssh-alias> <absolute-posix-workdir>"
    )
  }

  const [alias, workdir] = argv
  if (
    !SSH_ALIAS.test(alias) ||
    CONTROL_CHARACTERS.test(alias)
  ) {
    throw new LauncherConfigError(
      "SSH alias must contain only letters, digits, '.', '_', and '-' and must begin with a letter or digit"
    )
  }
  if (
    workdir.length === 0 ||
    !path.posix.isAbsolute(workdir) ||
    CONTROL_CHARACTERS.test(workdir)
  ) {
    throw new LauncherConfigError(
      "Remote workdir must be an absolute POSIX path without control characters"
    )
  }

  return { action: "launch", alias, workdir }
}

function describeParseError(error: ParseError): string {
  return `${printParseErrorCode(error.error)} at offset ${error.offset}`
}

function validateLaunchID(launchID: string): void {
  if (launchID.length > 128 || !LAUNCH_ID.test(launchID)) {
    throw new LauncherConfigError(
      "Launch ID must contain only letters, digits, '.', '_', and '-'"
    )
  }
}

/**
 * Add this launch's plugin tuple to OPENCODE_CONFIG_CONTENT without replacing
 * any existing configuration or plugins.
 */
export function mergeOpenCodeConfigContent(
  content: string | undefined,
  pluginFileURL: string | URL,
  launchID: string
): string {
  validateLaunchID(launchID)

  const fileURL = pluginFileURL instanceof URL ? pluginFileURL.href : pluginFileURL
  let parsedURL: URL
  try {
    parsedURL = new URL(fileURL)
  } catch {
    throw new LauncherConfigError("Plugin entry must be a valid file URL")
  }
  if (parsedURL.protocol !== "file:") {
    throw new LauncherConfigError("Plugin entry must be a file URL")
  }

  let parsed: unknown = {}
  if (content !== undefined && content.trim() !== "") {
    const errors: ParseError[] = []
    parsed = parseJsonc(content, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    })
    if (errors.length > 0) {
      throw new LauncherConfigError(
        `OPENCODE_CONFIG_CONTENT is malformed: ${describeParseError(errors[0])}`
      )
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LauncherConfigError("OPENCODE_CONFIG_CONTENT must contain a JSON object")
  }

  const config = parsed as Record<string, unknown>
  const existingPlugins = config.plugin
  if (existingPlugins !== undefined && !Array.isArray(existingPlugins)) {
    throw new LauncherConfigError("OPENCODE_CONFIG_CONTENT.plugin must be an array")
  }

  const merged = {
    ...config,
    plugin: [
      ...(existingPlugins ?? []),
      [fileURL, { launchID }],
    ],
  }
  return `${JSON.stringify(merged, null, 2)}\n`
}
