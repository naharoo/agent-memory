/**
 * Semantic recall via OpenRouter embeddings.
 *
 * Vectors live only in the engine's vector index, never on the record: a fact stays
 * ~83 bytes to read, and its `text` is always the single source for re-embedding
 * after a model change. The engine does not maintain the index from record writes,
 * so every fact write is paired with an explicit upsertVectors call.
 */
import { embeddingSettings } from "./config.mjs"
import { execute } from "./engine.mjs"

export const EMBED_INDEX = "fact_embedding"
const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings"
const EMBED_TIMEOUT_MS = 8000
const EMBED_BATCH = 64
const VECTOR_CANDIDATES = 60

/** Embeds text. Throws on any failure; callers decide the fallback. */
export async function embed(texts, signal) {
  const settings = embeddingSettings()
  if (!settings.apiKey) throw new Error("embeddings: no OPENROUTER_API_KEY")
  const out = []

  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH)
    const res = await fetch(EMBED_ENDPOINT, {
      method: "POST",
      signal: signal ?? AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.model, input: batch }),
    })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = await res.json()
    if (body.error) throw new Error(`embeddings: ${body.error.message ?? JSON.stringify(body.error).slice(0, 200)}`)

    const ordered = new Array(batch.length)
    for (const row of body.data ?? []) {
      const index = Number(row?.index ?? 0)
      if (Array.isArray(row?.embedding) && index >= 0 && index < batch.length) ordered[index] = row.embedding
    }
    for (let i = 0; i < batch.length; i++) {
      const vector = ordered[i]
      if (!vector) throw new Error(`embeddings: missing vector at index ${i}`)
      // A model/dimension mismatch would silently produce unusable vectors, so it
      // fails loudly here rather than quietly degrading recall.
      if (vector.length !== settings.dimensions) {
        throw new Error(
          `embeddings: ${settings.model} returned ${vector.length} dims but AGENT_MEMORY_EMBEDDING_DIMENSIONS=${settings.dimensions}`,
        )
      }
      out.push(vector)
    }
  }
  return out
}

/** Creates the index if absent, or rebuilds it when the configured dimensions changed. */
export async function ensureVectorIndex(tenant, signal) {
  const settings = embeddingSettings()
  const described = await execute({ kind: "describe", describe: { kind: "vectorIndexes" } }, tenant, { signal })
  const existing = (described?.indexes ?? []).find((index) => index?.name === EMBED_INDEX)
  if (Number(existing?.dimensions) === settings.dimensions) return existing

  if (existing) {
    await execute({ kind: "index", index: { kind: "dropVector", name: EMBED_INDEX } }, tenant, { signal })
  }
  const created = await execute(
    {
      kind: "index",
      index: {
        kind: "createVector",
        definition: { name: EMBED_INDEX, label: "MEMORY_FACT", property: "embedding", dimensions: settings.dimensions },
      },
    },
    tenant,
    { signal },
  )
  return created?.index
}

export async function upsertFactVectors(tenant, items, signal) {
  let updated = 0
  for (let start = 0; start < items.length; start += EMBED_BATCH) {
    const slice = items.slice(start, start + EMBED_BATCH)
    const response = await execute(
      { kind: "index", index: { kind: "upsertVectors", name: EMBED_INDEX, items: slice } },
      tenant,
      { signal },
    )
    updated += Number(response?.updated ?? slice.length)
  }
  return updated
}

/** id -> {score, properties} for active facts only. Never throws. */
export async function semanticFacts(tenant, queryText, signal) {
  const out = new Map()
  const settings = embeddingSettings()
  if (!settings.enabled || !String(queryText ?? "").trim()) return out

  try {
    await ensureVectorIndex(tenant, signal)
    const [vector] = await embed([queryText], signal)
    const response = await execute(
      {
        kind: "query",
        query: {
          kind: "vector",
          query: {
            labels: ["MEMORY_FACT"],
            limit: VECTOR_CANDIDATES,
            vector,
            property: "embedding",
            index: EMBED_INDEX,
            predicate: { active: true },
          },
        },
      },
      tenant,
      { signal },
    )
    for (const row of response?.records ?? []) {
      const properties = row?.properties ?? {}
      // The engine applies the predicate, but a forgotten fact must never resurface,
      // so the same condition is enforced here too.
      if (properties.active === false) continue
      if (row?.id) out.set(String(row.id), { score: Number(row.score ?? 0), properties })
    }
  } catch (error) {
    out.error = String(error?.message ?? error)
  }
  return out
}
