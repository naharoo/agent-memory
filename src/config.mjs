/**
 * Runtime configuration.
 *
 * Everything has a working default so the container needs no configuration at all.
 * The only value anyone has to supply is OPENROUTER_API_KEY, and only if they want
 * semantic recall rather than keyword ranking.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const DATA_DIR = process.env.AGENT_MEMORY_DATA_DIR ?? "/data"
export const CONFIG_DIR = join(DATA_DIR, "config")
export const LOG_DIR = join(DATA_DIR, "logs")
export const ENGINE_DATA_DIR = join(DATA_DIR, "engine")

export const ENGINE_URL = process.env.AGENT_MEMORY_ENGINE_URL ?? "http://127.0.0.1:3000"

// The engine refuses to listen on a non-loopback address with its built-in default
// token. It is bound to loopback inside the container and never published, so this
// constant is reachable only by processes in the same container — it is not a secret
// and is deliberately not configurable.
export const ENGINE_TOKEN = process.env.RUSHDB_TOKEN ?? "local-token"

export const HOST = process.env.AGENT_MEMORY_HOST ?? "0.0.0.0"
export const PORT = Number(process.env.AGENT_MEMORY_PORT ?? 3001)
export const ENGINE_TIMEOUT_MS = Number(process.env.AGENT_MEMORY_ENGINE_TIMEOUT_MS ?? 8000)

export const TENANTS_FILE = join(CONFIG_DIR, "tenants.tsv")
export const INDEX_INFO_FILE = join(CONFIG_DIR, "index-info.json")

export const DEFAULT_TENANT = process.env.AGENT_MEMORY_DEFAULT_TENANT ?? "default"

const TEMPLATE = `# Directory prefix -> tenant. Longest matching prefix wins; everything else
# uses the default tenant. Tab-separated, one rule per line.
#
# /Users/you/Projects/acme/	acme
`

/** Creates the config directory and a template tenant map on first run. */
export async function ensureLayout() {
  await mkdir(CONFIG_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  await mkdir(ENGINE_DATA_DIR, { recursive: true })
  try {
    await readFile(TENANTS_FILE, "utf8")
  } catch {
    await writeFile(TENANTS_FILE, TEMPLATE, "utf8")
  }
}

let tenantRules
let tenantStamp

/**
 * Directory -> tenant. The agent sends the directory it is running in; the mapping
 * lives here rather than on the agent host, so every adapter gets the same answer.
 *
 * Re-read when the file changes (mtime + size), so adding a project does not require
 * restarting the container. The file is tiny; the stat is the only steady-state cost.
 */
export async function tenantRulesList() {
  const stamp = await stat(TENANTS_FILE)
    .then((s) => `${s.mtimeMs}:${s.size}`)
    .catch(() => "missing")
  if (tenantRules && tenantStamp === stamp) return tenantRules

  const rules = []
  try {
    const text = await readFile(TENANTS_FILE, "utf8")
    for (const line of text.split("\n")) {
      const raw = line.trim()
      if (!raw || raw.startsWith("#")) continue
      const [prefixRaw, tenantRaw] = raw.split("\t")
      if (!prefixRaw?.trim() || !tenantRaw?.trim()) continue
      let prefix = prefixRaw.trim()
      if (!prefix.endsWith("/")) prefix += "/"
      rules.push({ prefix, tenant: tenantRaw.trim() })
    }
  } catch {}
  tenantRules = rules
  tenantStamp = stamp
  return rules
}

export function invalidateTenants() {
  tenantRules = undefined
  tenantStamp = undefined
}

export async function tenantFor(directory) {
  const target = String(directory ?? "").endsWith("/") ? String(directory) : String(directory ?? "") + "/"
  let best
  for (const rule of await tenantRulesList()) {
    if (target.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) best = rule
  }
  return best?.tenant ?? DEFAULT_TENANT
}

export async function tenantNames() {
  const names = new Set([DEFAULT_TENANT])
  for (const rule of await tenantRulesList()) names.add(rule.tenant)
  for (const name of String(process.env.AGENT_MEMORY_TENANTS ?? "").split(",")) {
    if (name.trim()) names.add(name.trim())
  }
  return [...names]
}

/** Tenant list with the directory prefixes that map to each, for the viewer picker. */
export async function tenantEntries() {
  const out = new Map()
  const add = (name) => {
    if (!name) return
    if (!out.has(name)) out.set(name, { name, prefixes: [] })
  }
  add(DEFAULT_TENANT)
  for (const name of String(process.env.AGENT_MEMORY_TENANTS ?? "").split(",")) add(name.trim())
  for (const rule of await tenantRulesList()) {
    add(rule.tenant)
    out.get(rule.tenant).prefixes.push(rule.prefix.replace(/\/$/, ""))
  }
  return [...out.values()]
}

// ------------------------------------------------------------------ embeddings

const truthy = new Set(["on", "1", "true", "yes"])

export function embeddingSettings() {
  const raw = String(process.env.AGENT_MEMORY_EMBEDDINGS ?? "on").trim().toLowerCase()
  const wanted = truthy.has(raw)
  const model = String(process.env.AGENT_MEMORY_EMBEDDING_MODEL ?? "mongodb/voyage-4-lite").trim()
  const dimensions = Number(process.env.AGENT_MEMORY_EMBEDDING_DIMENSIONS ?? 1024)
  const apiKey = process.env.OPENROUTER_API_KEY
  const enabled = wanted && Boolean(apiKey) && Number.isFinite(dimensions) && dimensions > 0
  return { enabled, wanted, model, dimensions, apiKey, reason: !wanted ? "disabled" : !apiKey ? "no OPENROUTER_API_KEY" : "ok" }
}

export async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true })
}
