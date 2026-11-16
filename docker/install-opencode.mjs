#!/usr/bin/env node
/**
 * Host-side installer, run as a one-shot container:
 *
 *   docker run --rm -v ~/.config/opencode:/host agent-memory install-opencode
 *   docker run --rm -v ~/.config/opencode:/host agent-memory uninstall-opencode
 *
 * A container cannot modify the host without a mount, so the target directory is
 * explicit. Everything written comes from inside this image; nothing is fetched.
 */
import { copyFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const TARGET = process.env.AGENT_MEMORY_HOST_DIR ?? "/host"
const SOURCE = "/app/adapters/opencode"
const PLUGIN_DIR = join(TARGET, "plugins", "agent-memory")
const AGENTS = join(TARGET, "AGENTS.md")
const MCP_SOURCE = "/app/mcp/rushdb-mcp"
const MCP_TARGET = join(TARGET, "bin", "rushdb-mcp")
const CONFIG = join(TARGET, "opencode.jsonc")
const BEGIN = "<!-- agent-memory:begin -->"
const END = "<!-- agent-memory:end -->"

const command = process.argv[2] ?? "install-opencode"

/** Reports whether the agent's MCP config already points at the installed wrapper. */
async function mcpStatus() {
  let text
  try {
    text = await readFile(CONFIG, "utf8")
  } catch {
    return { state: "no-config" }
  }
  const block = /"rushdb"\s*:\s*\{[\s\S]*?\}/.exec(text)
  if (!block) return { state: "no-entry" }
  const path = /"command"\s*:\s*\[\s*"([^"]+)"/.exec(block[0])
  if (!path) return { state: "no-command" }
  // The config holds the host path, which this container cannot know; the installed
  // file is always <config dir>/bin/rushdb-mcp, so match on that suffix.
  return { state: path[1].endsWith("/bin/rushdb-mcp") ? "ok" : "other", path: path[1] }
}

const SNIPPET = `  "mcp": {
    "servers": {
      "rushdb": { "type": "local", "command": ["${MCP_TARGET}"] }
    }
  }`

async function install() {
  await mkdir(PLUGIN_DIR, { recursive: true })
  for (const file of ["index.ts", "package.json"]) {
    await copyFile(join(SOURCE, file), join(PLUGIN_DIR, file))
  }

  // The MCP wrapper is installed from the image too, so the host never holds a copy
  // that can drift from the one the image was built and tested with.
  await mkdir(join(TARGET, "bin"), { recursive: true })
  await copyFile(MCP_SOURCE, MCP_TARGET)
  await chmod(MCP_TARGET, 0o755)

  const block = await readFile(join(SOURCE, "AGENTS.md"), "utf8")
  let existing = ""
  try {
    existing = await readFile(AGENTS, "utf8")
  } catch {}

  const managed = `${BEGIN}\n${block.trim()}\n${END}\n`
  const stripped = existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g"), "").trimEnd()
  const next = stripped ? `${stripped}\n\n${managed}` : managed
  await writeFile(AGENTS, next, "utf8")

  console.log(`plugin  -> ${PLUGIN_DIR}`)
  console.log(`mcp     -> ${MCP_TARGET}`)
  console.log(`agents  -> ${AGENTS} (managed block updated)`)

  const status = await mcpStatus()
  console.log("")
  if (status.state === "ok") {
    console.log("MCP: configured, pointing at the installed wrapper.")
  } else if (status.state === "other") {
    console.log(`MCP: configured, but points at ${status.path}`)
    console.log("     change it to <config dir>/bin/rushdb-mcp so the image stays the only copy.")
  } else if (status.state === "no-entry") {
    console.log("MCP: not configured. Add this to opencode.jsonc if you want graph tools:")
    console.log(SNIPPET)
  } else if (status.state === "no-config") {
    console.log("MCP: no opencode.jsonc found; skipping the config check.")
  }

  console.log("")
  console.log("Next: restart or /reload OpenCode.")
  console.log("No dependencies to install: the agent provides @opencode/plugin at runtime.")
}

async function uninstall() {
  await rm(PLUGIN_DIR, { recursive: true, force: true })
  await rm(MCP_TARGET, { force: true })
  try {
    const existing = await readFile(AGENTS, "utf8")
    const stripped = existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g"), "").trimEnd()
    await writeFile(AGENTS, stripped ? `${stripped}\n` : "", "utf8")
  } catch {}
  console.log(`removed ${PLUGIN_DIR}, ${MCP_TARGET}, and the AGENTS.md block`)
}

if (command === "install-opencode") await install()
else if (command === "uninstall-opencode") await uninstall()
else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
