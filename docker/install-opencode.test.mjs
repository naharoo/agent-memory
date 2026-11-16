// Run: AGENT_MEMORY_INSTALLER_LIB=1 node --test docker/install-opencode.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  configureMcpIn,
  unconfigureMcpIn,
  mergeAgentsBlock,
  mcpCommandOf,
  isRemoved,
} from "./install-opencode.mjs"

const CMD = "/Users/me/.config/opencode/bin/rushdb-mcp"

const CONFIG_BARE = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`
const CONFIG_MCP_ONLY = `{\n  // keep me\n  "mcp": {\n    "other": { "type": "local", "command": ["x"] }\n  }\n}\n`
const CONFIG_SIBLING = `{\n  "mcp": {\n    "servers": {\n      "keep": { "type": "local", "command": ["y"] }\n    }\n  }\n}\n`
const CONFIG_EXISTING = `{\n  "mcp": {\n    "servers": {\n      "rushdb": { "type": "local", "command": ["/old/bin/rushdb-mcp"] }\n    }\n  }\n}\n`

const collapse = (s) => s.replace(/\s+/g, "")

test("configureMcpIn adds the mcp object when absent", () => {
  const r = configureMcpIn(CONFIG_BARE, CMD)
  assert.equal(r.added, "mcp")
  assert.equal(mcpCommandOf(r.text), CMD)
})

test("configureMcpIn adds servers inside an existing mcp object, keeping comments", () => {
  const r = configureMcpIn(CONFIG_MCP_ONLY, CMD)
  assert.equal(r.added, "servers")
  assert.equal(mcpCommandOf(r.text), CMD)
  assert.ok(r.text.includes("// keep me"))
  assert.ok(r.text.includes('"other"'))
})

test("configureMcpIn replaces an existing rushdb entry in place", () => {
  const r = configureMcpIn(CONFIG_EXISTING, CMD)
  assert.equal(r.replaced, true)
  assert.equal(mcpCommandOf(r.text), CMD)
})

test("configureMcpIn adds rushdb beside an unrelated server", () => {
  const r = configureMcpIn(CONFIG_SIBLING, CMD)
  assert.equal(r.added, "rushdb")
  assert.equal(mcpCommandOf(r.text), CMD)
  assert.ok(r.text.includes('"keep"'))
})

for (const [name, before] of [
  ["bare config", CONFIG_BARE],
  ["mcp without servers", CONFIG_MCP_ONLY],
  ["servers with a sibling", CONFIG_SIBLING],
]) {
  test(`unconfigureMcpIn restores the ${name} exactly`, () => {
    const added = configureMcpIn(before, CMD)
    const removed = unconfigureMcpIn(added.text)
    assert.equal(removed.error, undefined)
    assert.ok(isRemoved(removed.text))
    assert.equal(collapse(removed.text), collapse(before))
  })
}

test("unconfigureMcpIn refuses an entry pointing at a different wrapper", () => {
  const foreign = `{\n  "mcp": {\n    "servers": {\n      "rushdb": { "type": "local", "command": ["/usr/local/bin/other"] }\n    }\n  }\n}\n`
  const r = unconfigureMcpIn(foreign)
  assert.ok(r.error)
  assert.equal(r.text, undefined)
})

test("unconfigureMcpIn reports when there is no servers key", () => {
  assert.equal(unconfigureMcpIn(CONFIG_MCP_ONLY).error, "no servers key")
})

test("unconfigureMcpIn reports when there is no rushdb entry", () => {
  assert.equal(unconfigureMcpIn(CONFIG_SIBLING).error, "no rushdb entry")
})

const BLOCK = "## Memory\n\nUse memory_remember."

test("mergeAgentsBlock creates the file when absent", () => {
  const r = mergeAgentsBlock("", BLOCK)
  assert.equal(r.outcome, "created")
  assert.ok(r.text.includes("agent-memory:begin"))
})

test("mergeAgentsBlock appends to existing content", () => {
  const r = mergeAgentsBlock("# Mine\n\nAlways pnpm.\n", BLOCK)
  assert.equal(r.outcome, "appended to your existing content")
  assert.ok(r.text.startsWith("# Mine"))
  assert.ok(r.text.includes("Always pnpm."))
})

test("mergeAgentsBlock replaces a managed block in place, keeping surrounding content", () => {
  const before = `# Mine\n\nAlways pnpm.\n\n<!-- agent-memory:begin -->\nOLD\n<!-- agent-memory:end -->\n\n## Footer\n\nKeep.\n`
  const r = mergeAgentsBlock(before, BLOCK)
  assert.equal(r.outcome, "updated the managed block, kept your content")
  assert.ok(!r.text.includes("OLD"))
  assert.ok(r.text.includes("Keep."))
  assert.ok(r.text.indexOf("# Mine") < r.text.indexOf("agent-memory:begin"))
  assert.ok(r.text.indexOf("agent-memory:end") < r.text.indexOf("## Footer"))
})

test("mergeAgentsBlock refreshes a block-only file", () => {
  const r = mergeAgentsBlock("<!-- agent-memory:begin -->\nOLD\n<!-- agent-memory:end -->\n", BLOCK)
  assert.equal(r.outcome, "updated the managed block")
  assert.ok(!r.text.includes("OLD"))
})

test("mergeAgentsBlock is idempotent", () => {
  const once = mergeAgentsBlock("# Mine\n\nAlways pnpm.\n", BLOCK)
  const twice = mergeAgentsBlock(once.text, BLOCK)
  assert.equal(twice.text, once.text)
})
