/**
 * Durable fact operations: remember, forget, reembed.
 *
 * Nothing is ever deleted. Retiring a fact merges active:false plus a pointer to what
 * replaced it, so the store stays auditable and a bad correction can be traced.
 */
import { embeddingSettings } from "./config.mjs"
import { ensureVectorIndex, embed, upsertFactVectors } from "./embeddings.mjs"
import { execute, mergeRecord, putRecord, query } from "./engine.mjs"
import { clip } from "./recall.mjs"

const EMBED_BATCH = 64

export async function remember({ tenant, text, kind, subjectKey, supersedes, pinned, sessionID }) {
  const body = String(text ?? "").slice(0, 2000)
  if (!body.trim()) throw new Error("text is required")

  // Retire what this fact restates. The write happens first and the merges after, so
  // an engine hiccup leaves a duplicate active fact rather than dropping the old one.
  const prior = new Set()
  if (subjectKey) {
    try {
      const rows = await query(
        { kind: "records", query: { labels: ["MEMORY_FACT"], predicate: { active: true, subjectKey }, limit: 100 } },
        tenant,
      )
      for (const row of rows) if (row.id) prior.add(String(row.id))
    } catch {}
  }
  if (supersedes) prior.add(String(supersedes))

  // Embed before the write so the record is created once, but never let an embedding
  // failure cost the fact: the text is written regardless and reembed backfills it.
  let vector
  try {
    const settings = embeddingSettings()
    if (settings.enabled) {
      await ensureVectorIndex(tenant)
      ;[vector] = await embed([body])
    }
  } catch {
    vector = undefined
  }

  const fact = {
    factId: `fact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: body,
    kind: kind ?? "fact",
    subjectKey: subjectKey || undefined,
    active: true,
    ...(pinned === true ? { pinned: true } : {}),
    provenance: "explicit-user-request",
    sessionID,
    createdAt: new Date().toISOString(),
  }
  const created = await putRecord("MEMORY_FACT", fact, tenant)
  const newId = created?.record?.id

  let indexed = false
  if (vector && newId) {
    try {
      await upsertFactVectors(tenant, [{ recordId: String(newId), vector }])
      indexed = true
    } catch {}
  }

  let retired = 0
  for (const id of prior) {
    if (id === newId) continue
    try {
      await mergeRecord(id, { active: false, supersededBy: fact.factId }, tenant)
      retired++
    } catch {}
  }

  return { id: newId, factId: fact.factId, tenant, subjectKey, retired, indexed, text: clip(body, 200) }
}

export async function forget({ tenant, id }) {
  if (!id) throw new Error("id is required")
  await mergeRecord(String(id), { active: false, forgottenAt: new Date().toISOString() }, tenant)
  return { id: String(id), tenant }
}

/** Re-embeds every fact from its stored text. Safe to run repeatedly. */
export async function reembed({ tenant, includeInactive }) {
  const settings = embeddingSettings()
  if (!settings.enabled) {
    return { enabled: false, reason: settings.reason, tenant, embedded: 0, total: 0 }
  }
  const rows = await query(
    {
      kind: "records",
      query: {
        labels: ["MEMORY_FACT"],
        ...(includeInactive ? {} : { predicate: { active: true } }),
        limit: 5000,
      },
    },
    tenant,
  )
  const items = rows
    .map((row) => ({ id: String(row.id ?? ""), text: String(row.properties?.text ?? "").trim() }))
    .filter((item) => item.id && item.text)
  if (!items.length) return { enabled: true, tenant, embedded: 0, total: 0, model: settings.model }

  // Ensures the index exists at the configured dimensions, rebuilding it first if the
  // model changed — which is exactly why the vectors are not stored on the records.
  await ensureVectorIndex(tenant)

  let embedded = 0
  for (let start = 0; start < items.length; start += EMBED_BATCH) {
    const batch = items.slice(start, start + EMBED_BATCH)
    const vectors = await embed(batch.map((item) => item.text))
    embedded += await upsertFactVectors(
      tenant,
      batch.map((item, offset) => ({ recordId: item.id, vector: vectors[offset] })),
    )
  }
  return { enabled: true, tenant, embedded, total: items.length, model: settings.model, dimensions: settings.dimensions }
}

/** Facts with an active flag, for the maintenance view. */
export async function factStats(tenant) {
  const rows = await query({ kind: "records", query: { labels: ["MEMORY_FACT"], limit: 5000 } }, tenant)
  const active = rows.filter((row) => row.properties?.active === true)
  return { total: rows.length, active: active.length, pinned: active.filter((r) => r.properties?.pinned === true).length }
}

export { execute }
