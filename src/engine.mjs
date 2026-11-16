/**
 * RushDB protocol client.
 *
 * The self-hosted engine speaks one endpoint: POST /protocol/v1/execute with a
 * bearer token, an X-RushDB-Tenant header, and context.scope in the body. Multitenant
 * mode requires both the header and the scope; either alone is rejected.
 */
import { ENGINE_TIMEOUT_MS, ENGINE_TOKEN, ENGINE_URL } from "./config.mjs"

export class EngineError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

export async function execute(operation, tenant, { signal, timeout = ENGINE_TIMEOUT_MS } = {}) {
  let res
  try {
    res = await fetch(`${ENGINE_URL}/protocol/v1/execute`, {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(timeout),
      headers: {
        Authorization: `Bearer ${ENGINE_TOKEN}`,
        "Content-Type": "application/json",
        "X-RushDB-Tenant": tenant,
      },
      body: JSON.stringify({ protocolVersion: 1, context: { scope: tenant }, operation }),
    })
  } catch (error) {
    throw new EngineError(`engine unreachable: ${error?.message ?? error}`, "unreachable")
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new EngineError(`engine returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, "bad_response")
  }
  if (!res.ok || body.error) {
    throw new EngineError(body.error?.message ?? `HTTP ${res.status}`, body.error?.code ?? `http_${res.status}`)
  }
  return body.response
}

export async function query(q, tenant, options) {
  const response = await execute({ kind: "query", query: q }, tenant, options)
  return response?.records ?? []
}

export function putRecord(label, properties, tenant, id) {
  return execute(
    {
      kind: "mutate",
      mutation: { kind: "putRecord", mode: "create", ...(id ? { id } : {}), label, properties, options: {} },
    },
    tenant,
  )
}

export function mergeRecord(id, properties, tenant) {
  return execute(
    { kind: "mutate", mutation: { kind: "putRecord", mode: "merge", id, properties, options: {} } },
    tenant,
  )
}

export async function health() {
  const res = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new EngineError(`HTTP ${res.status}`, "unhealthy")
  return res.json()
}
