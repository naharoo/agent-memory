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
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const TARGET = process.env.AGENT_MEMORY_HOST_DIR ?? "/host"
const SOURCE = "/app/adapters/opencode"
const PLUGIN_DIR = join(TARGET, "plugins", "agent-memory")
const AGENTS = join(TARGET, "AGENTS.md")
const BEGIN = "<!-- agent-memory:begin -->"
const END = "<!-- agent-memory:end -->"

const command = process.argv[2] ?? "install-opencode"

async function install() {
  await mkdir(PLUGIN_DIR, { recursive: true })
  for (const file of ["index.ts", "package.json"]) {
    await copyFile(join(SOURCE, file), join(PLUGIN_DIR, file))
  }

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
  console.log(`agents  -> ${AGENTS} (managed block updated)`)
  console.log("")
  console.log("Next:")
  console.log("  1. install the plugin's single dependency:")
  console.log(`     cd ${PLUGIN_DIR} && npm install --omit=dev`)
  console.log("  2. restart or /reload OpenCode")
  console.log("  3. optional MCP: add mcp/rushdb-mcp to your agent's MCP config")
}

async function uninstall() {
  await rm(PLUGIN_DIR, { recursive: true, force: true })
  try {
    const existing = await readFile(AGENTS, "utf8")
    const stripped = existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g"), "").trimEnd()
    await writeFile(AGENTS, stripped ? `${stripped}\n` : "", "utf8")
  } catch {}
  console.log(`removed ${PLUGIN_DIR} and the AGENTS.md block`)
}

if (command === "install-opencode") await install()
else if (command === "uninstall-opencode") await uninstall()
else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
