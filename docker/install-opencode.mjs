#!/usr/bin/env node
/**
 * Host-side installer, run as a one-shot container:
 *
 *   docker run --rm -v ~/.config/opencode:/host agent-memory install-opencode
 *   docker run --rm -v ~/.config/opencode:/host agent-memory uninstall-opencode
 *
 * A container cannot modify the host without a mount, so the target directory is
 * explicit. Everything written comes from inside this image; nothing is fetched.
 *
 * Optional, for wiring the MCP server into opencode.jsonc:
 *   -e AGENT_MEMORY_CONFIGURE_MCP=1
 *   -e AGENT_MEMORY_HOST_PATH=/Users/you/.config/opencode   (the host path of /host)
 *
 * The config is edited textually and validated before it is written: JSONC round-tripping
 * through a parser would drop the user's comments, so the edit is surgical and the result
 * is re-parsed as a check. If that check fails, nothing is written.
 */
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const TARGET = process.env.AGENT_MEMORY_HOST_DIR ?? "/host"
const SOURCE = process.env.AGENT_MEMORY_ADAPTER_DIR ?? "/app/adapters/opencode"
const PLUGIN_DIR = join(TARGET, "plugins", "agent-memory")
const AGENTS = join(TARGET, "AGENTS.md")
const MCP_SOURCE = process.env.AGENT_MEMORY_MCP_SOURCE ?? "/app/mcp/rushdb-mcp"
const MCP_TARGET = join(TARGET, "bin", "rushdb-mcp")
const CONFIG = join(TARGET, "opencode.jsonc")
const BEGIN = "<!-- agent-memory:begin -->"
const END = "<!-- agent-memory:end -->"

const command = process.argv[2] ?? "install-opencode"
const configureMcp = ["1", "on", "true", "yes"].includes(String(process.env.AGENT_MEMORY_CONFIGURE_MCP ?? "").toLowerCase())
const hostPath = process.env.AGENT_MEMORY_HOST_PATH?.replace(/\/$/, "")

// Docker Desktop's file-sharing layer intermittently fails a create inside a host bind
// mount on macOS — ENOENT on a path whose parent demonstrably exists — so a single
// writeFile is not reliable. Every attempt re-creates the parent (it can disappear with
// the mount) and reads the file back, so a silent partial write is retried too.
const WRITE_ATTEMPTS = 5
const WRITE_BACKOFF_MS = 120
const TRANSIENT_CODES = new Set(["ENOENT", "EBUSY", "EAGAIN", "EIO", "EINTR", "ETIMEDOUT"])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function writeFileRetry(path, data) {
  let lastError
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data, "utf8")
      if ((await readFile(path, "utf8")) === data) return
      lastError = new Error(`read-back mismatch writing ${path}`)
    } catch (error) {
      lastError = error
      if (error?.code && !TRANSIENT_CODES.has(error.code)) throw error
    }
    if (attempt < WRITE_ATTEMPTS) await sleep(WRITE_BACKOFF_MS * attempt)
  }
  throw lastError
}

// ------------------------------------------------------------------ JSONC helpers

/** Removes // and block comments and trailing commas, respecting string literals. */
function stripJsonc(text) {
  let out = ""
  let i = 0
  let inString = false
  let escape = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Index of the brace matching the one at openIndex, or -1. */
function matchBrace(text, openIndex) {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i)
      if (i < 0) return -1
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function lineIndent(text, index) {
  const start = text.lastIndexOf("\n", index) + 1
  return /^[ \t]*/.exec(text.slice(start))[0]
}

/** Index of the first { outside strings and comments, or -1. */
function firstBrace(text) {
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i)
      if (i < 0) return -1
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end < 0) return -1
      i = end + 1
      continue
    }
    if (c === "{") return i
  }
  return -1
}

/** Appends `member` as the last property of the object spanning [open, close]. */
function insertMember(text, open, close, member) {
  const head = text.slice(0, close).replace(/\s+$/, "")
  const needsComma = !head.endsWith("{")
  const indent = lineIndent(text, open) + "  "
  const closeIndent = lineIndent(text, close)
  return `${head}${needsComma ? "," : ""}\n${indent}${member}\n${closeIndent}${text.slice(close)}`
}

/** The rushdb server value, whose closing brace sits at `indent`. */
function rushdbEntry(mcpCommand, indent) {
  const inner = `${indent}  `
  return `{\n${inner}"type": "local",\n${inner}"command": [${JSON.stringify(mcpCommand)}]\n${indent}}`
}

function serversObject(mcpCommand, indent) {
  const inner = `${indent}  `
  return `{\n${inner}"rushdb": ${rushdbEntry(mcpCommand, inner)}\n${indent}}`
}

function mcpObject(mcpCommand, indent) {
  const inner = `${indent}  `
  return `{\n${inner}"servers": ${serversObject(mcpCommand, inner)}\n${indent}}`
}

/**
 * Inserts (or replaces) the rushdb server entry. Returns the new text, or a reason it
 * could not be done. Caller validates before writing.
 *
 * Three shapes are handled, because a config that lacks "mcp" or "servers" is a normal
 * config, not an error: the whole mcp object is added to the root, the servers object to
 * an existing mcp, or just the rushdb entry to an existing servers.
 */
function configureMcpIn(text, mcpCommand) {
  const mcpMatch = /"mcp"\s*:\s*\{/.exec(text)
  if (!mcpMatch) {
    const root = firstBrace(text)
    if (root < 0) return { error: "no root object" }
    const rootEnd = matchBrace(text, root)
    if (rootEnd < 0) return { error: "unbalanced root object" }
    const member = `"mcp": ${mcpObject(mcpCommand, lineIndent(text, root) + "  ")}`
    return { text: insertMember(text, root, rootEnd, member), added: "mcp" }
  }

  const mcpOpen = mcpMatch.index + mcpMatch[0].length - 1
  const mcpEnd = matchBrace(text, mcpOpen)
  if (mcpEnd < 0) return { error: "unbalanced mcp object" }

  const serversMatch = /"servers"\s*:\s*\{/.exec(text.slice(mcpOpen, mcpEnd))
  if (!serversMatch) {
    const member = `"servers": ${serversObject(mcpCommand, lineIndent(text, mcpOpen) + "  ")}`
    return { text: insertMember(text, mcpOpen, mcpEnd, member), added: "servers" }
  }

  const serversOpen = mcpOpen + serversMatch.index + serversMatch[0].length - 1
  const serversEnd = matchBrace(text, serversOpen)
  if (serversEnd < 0) return { error: "unbalanced servers object" }

  const existing = /"rushdb"\s*:\s*\{/.exec(text.slice(serversOpen, serversEnd))
  if (existing) {
    const open = serversOpen + existing.index + existing[0].length - 1
    const end = matchBrace(text, open)
    if (end < 0) return { error: "unbalanced rushdb object" }
    return { text: text.slice(0, open) + rushdbEntry(mcpCommand, lineIndent(text, open)) + text.slice(end + 1), replaced: true }
  }

  const member = `"rushdb": ${rushdbEntry(mcpCommand, lineIndent(text, serversOpen) + "  ")}`
  return { text: insertMember(text, serversOpen, serversEnd, member), added: "rushdb" }
}

/**
 * Removes the member whose key starts at keyStart and whose object closes at end,
 * taking the comma or leading whitespace that separated it so the parent stays valid.
 */
function removeMember(text, keyStart, end) {
  const before = text.slice(0, keyStart).replace(/\s+$/, "")
  let from = keyStart
  let to = end + 1
  if (before.endsWith(",")) {
    from = before.length - 1
  } else {
    const comma = /^\s*,\s*/.exec(text.slice(to))
    if (comma) {
      to += comma[0].length
    } else {
      // Last member: drop the whitespace before the key too, so the parent's closing
      // brace lands on its own line instead of inheriting the removed member's indent.
      from = before.length
      to += (/^\s*/.exec(text.slice(to))?.[0].length ?? 0)
    }
  }
  return text.slice(0, from) + text.slice(to)
}

/** Removes "servers": {} and "mcp": {} left behind when their only member was removed. */
function pruneEmptyContainers(text) {
  for (const key of ["servers", "mcp"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*\\{\\s*\\}`).exec(text)
    if (!match) continue
    const open = text.indexOf("{", match.index)
    const end = matchBrace(text, open)
    if (end < 0) continue
    text = removeMember(text, match.index, end)
  }
  return text
}

/** Removes the rushdb entry, but only if it points at the installed wrapper. */
function unconfigureMcpIn(text) {
  const serversMatch = /"servers"\s*:\s*\{/.exec(text)
  if (!serversMatch) return { error: "no servers key" }
  const serversOpen = serversMatch.index + serversMatch[0].length - 1
  const serversEnd = matchBrace(text, serversOpen)
  if (serversEnd < 0) return { error: "unbalanced servers object" }

  const existing = /"rushdb"\s*:\s*\{/.exec(text.slice(serversOpen, serversEnd))
  if (!existing) return { error: "no rushdb entry" }
  const keyStart = serversOpen + existing.index
  const open = serversOpen + existing.index + existing[0].length - 1
  const end = matchBrace(text, open)
  if (end < 0) return { error: "unbalanced rushdb object" }

  const command = /"command"\s*:\s*\[\s*"([^"]+)"/.exec(text.slice(keyStart, end + 1))?.[1]
  if (!command || command.split("/").pop() !== "rushdb-mcp") {
    return { error: "rushdb entry does not point at a rushdb-mcp wrapper" }
  }
  return { text: pruneEmptyContainers(removeMember(text, keyStart, end)) }
}

/** Parses an edited config; throws if the edit produced invalid JSONC. */
function parseConfig(text) {
  return JSON.parse(stripJsonc(text))
}

function mcpCommandOf(text) {
  return parseConfig(text)?.mcp?.servers?.rushdb?.command?.[0]
}

/** True when the config still parses and no rushdb server remains. */
function isRemoved(text) {
  return parseConfig(text)?.mcp?.servers?.rushdb === undefined
}

/** Resolves the host path of /host, needed because the config stores host paths. */
async function resolveHostPath(existingText) {
  if (hostPath) return hostPath
  if (existingText) {
    const m = /"command"\s*:\s*\[\s*"([^"]*\/bin\/rushdb-mcp)"/.exec(existingText)
    if (m) return m[1].replace(/\/bin\/rushdb-mcp$/, "")
  }
  return undefined
}

/** Describes what the AGENTS.md write did, for the installer's output. */
function agentsOutcome(existingAgents, outside) {
  if (!existingAgents.trim()) return "created"
  if (existingAgents.includes(BEGIN)) return outside ? "updated the managed block, kept your content" : "updated the managed block"
  return "appended to your existing content"
}

/**
 * Merges the managed block into AGENTS.md text.
 *
 * Everything outside the markers belongs to the user and is preserved verbatim; a
 * previous managed block is replaced rather than duplicated. A file that already had
 * content keeps it — only the marked region is ours. Returns both the new text and a
 * description of what happened, so the installer can say precisely what it did.
 */
function mergeAgentsBlock(existingAgents, block) {
  const managed = `${BEGIN}\n${block.trim()}\n${END}`
  if (existingAgents.includes(BEGIN)) {
    // Replace the managed region where it sits, so surrounding user content keeps its
    // position and blank lines instead of being rejoined around a relocated block.
    const text = existingAgents.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`, "g"), () => managed)
    const outside = existingAgents.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g"), "").trimEnd()
    return { text, outcome: agentsOutcome(existingAgents, outside) }
  }
  if (!existingAgents.trim()) return { text: `${managed}\n`, outcome: "created" }
  const outside = existingAgents.trimEnd()
  return { text: `${outside}\n\n${managed}\n`, outcome: "appended to your existing content" }
}

function SNIPPET(path) {
  return `  "mcp": {\n    "servers": {\n      "rushdb": { "type": "local", "command": ["${path}"] }\n    }\n  }`
}

function mcpStatusFrom(text) {
  if (!text) return { state: "no-config" }
  const block = /"rushdb"\s*:\s*\{[\s\S]*?\}/.exec(text)
  if (!block) return { state: "no-entry" }
  const path = /"command"\s*:\s*\[\s*"([^"]+)"/.exec(block[0])
  if (!path) return { state: "no-command" }
  return { state: path[1].endsWith("/bin/rushdb-mcp") ? "ok" : "other", path: path[1] }
}

// ------------------------------------------------------------------ commands

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
  let existingAgents = ""
  try {
    existingAgents = await readFile(AGENTS, "utf8")
  } catch {}
  const merged = mergeAgentsBlock(existingAgents, block)
  await writeFileRetry(AGENTS, merged.text)

  console.log(`plugin  -> ${PLUGIN_DIR}`)
  console.log(`mcp     -> ${MCP_TARGET}`)
  console.log(`agents  -> ${AGENTS} (${merged.outcome})`)

  console.log("")
  let configText
  try {
    configText = await readFile(CONFIG, "utf8")
  } catch {
    configText = undefined
  }

  if (configureMcp) {
    const resolved = await resolveHostPath(configText)
    if (!resolved) {
      console.log("MCP: AGENT_MEMORY_CONFIGURE_MCP is set but the host path is unknown.")
      console.log("     Pass -e AGENT_MEMORY_HOST_PATH=<host path of this directory> and re-run.")
      console.log(SNIPPET("<host path>/bin/rushdb-mcp"))
    } else if (!configText) {
      const fresh = `{\n  "mcp": {\n    "servers": {\n      "rushdb": {\n        "type": "local",\n        "command": [${JSON.stringify(`${resolved}/bin/rushdb-mcp`)}]\n      }\n    }\n  }\n}\n`
      mcpCommandOf(fresh)
      await writeFileRetry(CONFIG, fresh)
      console.log(`MCP: created ${CONFIG} with the rushdb server.`)
    } else {
      const result = configureMcpIn(configText, `${resolved}/bin/rushdb-mcp`)
      if (result.error) {
        console.log(`MCP: could not edit ${CONFIG} (${result.error}); add this by hand:`)
        console.log(SNIPPET(`${resolved}/bin/rushdb-mcp`))
      } else {
        let check
        try { check = mcpCommandOf(result.text) } catch { check = undefined }
        if (check !== `${resolved}/bin/rushdb-mcp`) {
          console.log(`MCP: edit did not validate; ${CONFIG} left untouched. Add this by hand:`)
          console.log(SNIPPET(`${resolved}/bin/rushdb-mcp`))
        } else {
          await writeFileRetry(CONFIG, result.text)
          console.log(`MCP: ${result.replaced ? "updated" : "added"} the rushdb server in ${CONFIG}.`)
        }
      }
    }
  } else {
    const status = mcpStatusFrom(configText)
    if (status.state === "ok") console.log("MCP: configured, pointing at the installed wrapper.")
    else if (status.state === "other") console.log(`MCP: configured, but points at ${status.path}`)
    else if (status.state === "no-entry") {
      console.log("MCP: not configured. Re-run with -e AGENT_MEMORY_CONFIGURE_MCP=1 to add it,")
      console.log("     or add this by hand:")
      console.log(SNIPPET("<host path>/bin/rushdb-mcp"))
    } else console.log("MCP: no opencode.jsonc found; skipping the config check.")
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
    await writeFileRetry(AGENTS, stripped ? `${stripped}\n` : "")
  } catch {}

  let configText
  try {
    configText = await readFile(CONFIG, "utf8")
  } catch {}
  if (configText) {
    const result = unconfigureMcpIn(configText)
    if (result.error) {
      // "no servers key" and "no rushdb entry" mean there is nothing of ours to remove.
      if (result.error !== "no rushdb entry" && result.error !== "no servers key") {
        console.log(`MCP: left ${CONFIG} unchanged (${result.error})`)
      }
    } else if (isRemoved(result.text)) {
      await writeFileRetry(CONFIG, result.text)
      console.log(`MCP: removed the rushdb server from ${CONFIG}`)
    } else {
      console.log(`MCP: removal did not validate; ${CONFIG} left untouched`)
    }
  }

  console.log(`removed ${PLUGIN_DIR}, ${MCP_TARGET}, and the AGENTS.md block`)
}

// Set AGENT_MEMORY_INSTALLER_LIB=1 to import this file for its helpers without acting.
if (process.env.AGENT_MEMORY_INSTALLER_LIB !== "1") {
  if (command === "install-opencode") await install()
  else if (command === "uninstall-opencode") await uninstall()
  else {
    console.error(`unknown command: ${command}`)
    process.exit(2)
  }
}

export { stripJsonc, matchBrace, configureMcpIn, unconfigureMcpIn, mcpCommandOf, isRemoved, mergeAgentsBlock }
