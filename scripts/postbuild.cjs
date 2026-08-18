const fs = require("node:fs")
const path = require("node:path")

const cli = path.join(__dirname, "..", "dist", "cli.js")
if (!fs.existsSync(cli)) throw new Error("dist/cli.js was not built")
fs.chmodSync(cli, 0o755)
