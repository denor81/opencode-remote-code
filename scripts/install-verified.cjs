const path = require("node:path")
const { spawnSync } = require("node:child_process")

const root = path.join(__dirname, "..")
const npmExecPath = process.env.npm_execpath
const testedOpenCodeVersion = require("../package.json").dependencies["@opencode-ai/plugin"]

if (process.platform === "win32") {
  fail("Native Windows is not supported. Run the installation inside WSL.")
}

const [major, minor, patch] = process.versions.node.split(".").map(Number)
if (
  major < 22 ||
  (major === 22 && minor < 22) ||
  (major === 22 && minor === 22 && patch < 2)
) {
  fail(`Node.js 22.22.2 or newer is required; found ${process.versions.node}.`)
}

const opencode = process.env.OPENCODE_SSH_OPENCODE_BIN || "opencode"
const ssh = process.env.OPENCODE_SSH_SSH_BIN || "ssh"
const sftp = process.env.OPENCODE_SSH_SFTP_BIN || "sftp"

const version = spawn(opencode, ["--version"], { capture: true })
if (version.status !== 0) {
  fail(
    "OpenCode is required. Install the tested version with:\n" +
      `npm install --global opencode-ai@${testedOpenCodeVersion}`
  )
}
assertCommand(
  ssh,
  ["-V"],
  "OpenSSH ssh",
  (result) =>
    result.status === 0 &&
    result.signal === null &&
    /^OpenSSH_/u.test(`${result.stdout}${result.stderr}`.trim())
)
assertCommand(
  sftp,
  ["-h"],
  "OpenSSH sftp",
  (result) =>
    (result.status === 0 || result.status === 1) &&
    result.signal === null &&
    /usage:\s*sftp\b/i.test(`${result.stdout}${result.stderr}`)
)

step(1, "installing the locked dependency set")
npm(["ci"])

step(2, "running the local test suite")
npm(["test"])

step(3, "installing opencode-ssh globally")
npm(["install", "--global", root])

step(4, "running the installed compatibility self-test")
const globalRoot = npm(["root", "--global"], true).stdout.trim()
run(process.execPath, [path.join(globalRoot, "opencode-ssh", "dist", "cli.js"), "self-test"])

process.stderr.write("opencode-ssh: verified installation passed\n")

function step(number, message) {
  process.stderr.write(`opencode-ssh: install ${number}/4: ${message}...\n`)
}

function npm(args, capture = false) {
  return npmExecPath
    ? run(process.execPath, [npmExecPath, ...args], { capture })
    : run("npm", args, { capture })
}

function assertCommand(command, args, name, accepts) {
  const result = spawn(command, args, { capture: true })
  if (result.error) fail(`${name} is required but could not be started.`)
  if (!accepts(result)) {
    fail(`${name} is required but its version check failed.`)
  }
}

function run(command, args, options = {}) {
  const result = spawn(command, args, options)
  if (result.error) fail(`Could not start ${JSON.stringify(command)}: ${result.error.message}`)
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr)
    fail(`${JSON.stringify([command, ...args])} exited with code ${result.status}.`)
  }
  return result
}

function spawn(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    shell: false,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })
}

function fail(message) {
  process.stderr.write(`opencode-ssh: install failed: ${message}\n`)
  process.exit(1)
}
