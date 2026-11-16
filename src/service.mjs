/**
 * The single HTTP surface.
 *
 * One Node process serves the viewer, the memory API that agent adapters call, and a
 * raw engine passthrough. The engine itself listens on loopback inside the container
 * and is never published, so nothing here needs a user-facing token.
 *
 *   GET  /                          viewer
 *   GET  /api/*                     viewer data (schema, records, indexes, sql)
 *   POST /recall                    {directory, sessionID, message} -> memory block
 *   POST /capture                   {directory, sessionID, messages}
 *   POST /remember                  durable fact
 *   POST /forget                    deactivate a fact
 *   POST /reembed                   rebuild the vector index from stored text
 *   POST /engine                    raw protocol passthrough (MCP, ad-hoc)
 *   GET  /health
 */
import { createServer } from "node:http"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  CONFIG_DIR,
  DEFAULT_TENANT,
  ENGINE_TOKEN,
  ENGINE_URL,
  HOST,
  INDEX_INFO_FILE,
  LOG_DIR,
  PORT,
  ensureLayout,
  embeddingSettings,
  tenantFor,
  tenantEntries,
} from "./config.mjs"
import { execute, health as engineHealth, query } from "./engine.mjs"
import { buildMemory, invalidateRecall } from "./recall.mjs"
import { capture } from "./capture.mjs"
import { forget, reembed, remember } from "./memory.mjs"

const APP_HTML = join(import.meta.dirname, "..", "ui", "app.html")
const REFRESH_SECONDS = clampInterval(process.env.AGENT_MEMORY_REFRESH_SECONDS ?? 30)
const AUTH_KEY = process.env.AGENT_MEMORY_KEY ?? ""

function clampInterval(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(Math.round(n), 3600)) : 30
}

async function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  try {
    await appendFile(join(LOG_DIR, "service.log"), entry, "utf8")
  } catch {}
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(value))
}

async function body(req) {
  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 8 * 1024 * 1024) throw new Error("request body too large")
  }
  if (!raw) return {}
  return JSON.parse(raw)
}

async function indexAnnotations() {
  try {
    const parsed = JSON.parse(await readFile(INDEX_INFO_FILE, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function indexesFor(tenant) {
  const [text, vector, annotations] = await Promise.all([
    execute({ kind: "describe", describe: { kind: "indexes" } }, tenant).catch((e) => ({ error: e })),
    execute({ kind: "describe", describe: { kind: "vectorIndexes" } }, tenant).catch((e) => ({ error: e })),
    indexAnnotations(),
  ])
  const indexes = []
  const errors = []
  if (text.error) errors.push(`indexes: ${text.error.message}`)
  if (vector.error) errors.push(`vectorIndexes: ${vector.error.message}`)

  for (const i of text.indexes ?? []) {
    const info = annotations[i.name] ?? {}
    indexes.push({
      name: i.name,
      kind: i.kind ?? "text",
      label: i.label ?? null,
      property: i.property ?? null,
      status: i.state ?? i.status ?? "unknown",
      consistency: i.consistency ?? null,
      pending: i.pending ?? null,
      dimensions: null,
      similarity: null,
      indexed: null,
      total: null,
      unindexed: null,
      stale: null,
      model: info.model ?? null,
      note: info.note ?? null,
      details: { ...i, ...(info.model ? { model: info.model } : {}), ...(info.note ? { note: info.note } : {}) },
    })
  }
  for (const i of vector.indexes ?? []) {
    const info = annotations[i.name] ?? {}
    indexes.push({
      name: i.name,
      kind: "vector",
      label: i.label ?? null,
      property: i.property ?? null,
      status: i.status ?? "unknown",
      consistency: null,
      pending: null,
      dimensions: i.dimensions ?? null,
      similarity: i.similarity ?? null,
      indexed: i.indexedRecords ?? null,
      total: i.totalRecords ?? null,
      unindexed: i.unindexedRecords ?? null,
      stale: i.staleBindings ?? null,
      model: i.model ?? info.model ?? null,
      note: info.note ?? null,
      details: { ...i, ...(info.model ? { model: info.model } : {}), ...(info.note ? { note: info.note } : {}) },
    })
  }
  return { indexes, errors }
}

function authorized(req) {
  if (!AUTH_KEY) return true
  return req.headers.authorization === `Bearer ${AUTH_KEY}`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(APP_HTML, "utf8")
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      return res.end(html)
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const settings = embeddingSettings()
      try {
        const engine = await engineHealth()
        return json(res, 200, {
          ok: true,
          engine,
          embeddings: { enabled: settings.enabled, model: settings.model, dimensions: settings.dimensions },
        })
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }

    const needsAuth = !url.pathname.startsWith("/api/") && url.pathname !== "/protocol/v1/execute"
    if (needsAuth && !authorized(req)) return json(res, 401, { error: "unauthorized" })

    // ------------------------------------------------------- engine passthrough
    //
    // Re-exposes the engine protocol without a token so clients written against
    // RushDB (the MCP server, ad-hoc tools) work unchanged. The engine stays on
    // loopback inside the container and is never published.
    if (req.method === "POST" && url.pathname === "/protocol/v1/execute") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" })
      const payload = await body(req)
      const tenant =
        String(req.headers["x-rushdb-tenant"] ?? "") ||
        String(payload?.context?.scope ?? "") ||
        DEFAULT_TENANT
      const upstream = await fetch(`${ENGINE_URL}/protocol/v1/execute`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: `Bearer ${ENGINE_TOKEN}`,
          "Content-Type": "application/json",
          "X-RushDB-Tenant": tenant,
        },
        body: JSON.stringify({ ...payload, context: { ...(payload?.context ?? {}), scope: tenant } }),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      return res.end(text)
    }

    // Resolves the tenant for a directory without exposing the mapping file.
    if (req.method === "GET" && url.pathname === "/api/tenant-for") {
      const directory = String(req.headers["x-directory"] ?? url.searchParams.get("directory") ?? "")
      return json(res, 200, { directory, tenant: await tenantFor(directory) })
    }

    // ---------------------------------------------------------------- viewer API

    if (req.method === "GET" && url.pathname === "/api/health") {
      const settings = embeddingSettings()
      try {
        const engine = await engineHealth()
        return json(res, 200, { ok: true, engine: "agent-memory", health: engine, embeddings: settings.enabled })
      } catch (error) {
        return json(res, 200, { ok: false, engine: "agent-memory", error: String(error?.message ?? error) })
      }
    }

    if (req.method === "GET" && url.pathname === "/api/tenants") {
      return json(res, 200, { tenants: await tenantEntries(), default: DEFAULT_TENANT })
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, { refreshSeconds: REFRESH_SECONDS })
    }

    const tenant = url.searchParams.get("tenant") || DEFAULT_TENANT

    if (req.method === "GET" && url.pathname === "/api/schema") {
      return json(res, 200, await execute({ kind: "describe", describe: { kind: "schemaSummary" } }, tenant))
    }

    if (req.method === "GET" && url.pathname === "/api/indexes") {
      return json(res, 200, await indexesFor(tenant))
    }

    if (req.method === "GET" && url.pathname === "/api/records") {
      const label = url.searchParams.get("label")
      if (!label) return json(res, 400, { error: "label is required" })
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500)
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0)
      return json(
        res,
        200,
        await execute(
          { kind: "query", query: { kind: "records", query: { labels: [label], limit, offset, order: { createdAt: "desc" } } } },
          tenant,
        ),
      )
    }

    if (req.method === "GET" && url.pathname === "/api/record") {
      const id = url.searchParams.get("id")
      if (!id) return json(res, 400, { error: "id is required" })
      return json(res, 200, await execute({ kind: "query", query: { kind: "record", id } }, tenant))
    }

    if (req.method === "POST" && url.pathname === "/api/sql") {
      const { tenant: t, sql } = await body(req)
      if (!sql) return json(res, 400, { error: "sql is required" })
      return json(
        res,
        200,
        await execute({ kind: "query", query: { kind: "statement", statement: String(sql), language: "sql" } }, t || DEFAULT_TENANT),
      )
    }

    // ---------------------------------------------------------------- memory API

    if (req.method === "POST" && url.pathname === "/recall") {
      const { directory, sessionID = "", message = "" } = await body(req)
      const resolved = await tenantFor(directory)
      const started = Date.now()
      const { block, stats } = await buildMemory(resolved, String(message).slice(0, 4000), sessionID, AbortSignal.timeout(20_000))
      await log(
        `recall tenant=${resolved} session=${sessionID} facts=${stats.pinned}+${stats.ranked}/${stats.candidates} words=${stats.words} sem=${stats.semantic} chars=${block.length} ms=${Date.now() - started}`,
      )
      return json(res, 200, { tenant: resolved, block, stats })
    }

    if (req.method === "POST" && url.pathname === "/capture") {
      const { directory, sessionID, messages, title } = await body(req)
      if (!sessionID) return json(res, 400, { error: "sessionID is required" })
      const resolved = await tenantFor(directory)
      const episode = await capture({ tenant: resolved, sessionID, directory, messages, title })
      if (episode) {
        invalidateRecall(sessionID)
        await log(`capture tenant=${resolved} session=${sessionID} summary=${episode.summary.length} turns=${episode.turnCount}`)
      }
      return json(res, 200, { tenant: resolved, captured: Boolean(episode), episodeId: episode?.episodeId })
    }

    if (req.method === "POST" && url.pathname === "/remember") {
      const input = await body(req)
      const resolved = await tenantFor(input.directory)
      const result = await remember({ ...input, tenant: resolved })
      if (input.sessionID) invalidateRecall(input.sessionID)
      await log(`remember tenant=${resolved} id=${result.id} indexed=${result.indexed} retired=${result.retired}`)
      return json(res, 200, result)
    }

    if (req.method === "POST" && url.pathname === "/forget") {
      const input = await body(req)
      const resolved = await tenantFor(input.directory)
      const result = await forget({ ...input, tenant: resolved })
      if (input.sessionID) invalidateRecall(input.sessionID)
      await log(`forget tenant=${resolved} id=${result.id}`)
      return json(res, 200, result)
    }

    if (req.method === "POST" && url.pathname === "/reembed") {
      const input = await body(req)
      const resolved = await tenantFor(input.directory)
      const result = await reembed({ ...input, tenant: resolved })
      invalidateRecall()
      await log(`reembed tenant=${resolved} embedded=${result.embedded}/${result.total} model=${result.model ?? "-"}`)
      return json(res, 200, result)
    }

    if (req.method === "POST" && url.pathname === "/engine") {
      const { directory, tenant: explicit, operation } = await body(req)
      if (!operation) return json(res, 400, { error: "operation is required" })
      const resolved = explicit || (await tenantFor(directory))
      return json(res, 200, { tenant: resolved, response: await execute(operation, resolved) })
    }

    json(res, 404, { error: "not found" })
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) })
  }
})

await ensureLayout()

server.listen(PORT, HOST, () => {
  const settings = embeddingSettings()
  console.log(`agent-memory on http://${HOST}:${PORT}`)
  console.log(`  config: ${CONFIG_DIR}`)
  console.log(`  embeddings: ${settings.enabled ? `${settings.model} (${settings.dimensions}d)` : `off (${settings.reason})`}`)
  if (!AUTH_KEY) console.log("  auth: none (bind to loopback, or set AGENT_MEMORY_KEY)")
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
