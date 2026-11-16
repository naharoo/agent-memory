/**
 * OpenCode adapter for agent-memory.
 *
 * Deliberately thin: all memory logic (ranking, fusion, embeddings, capture shaping,
 * tenant routing) lives in the container. This file only knows how OpenCode hands it
 * messages and how to put a block back into the prompt.
 *
 * Configure with one optional environment variable:
 *   AGENT_MEMORY_URL   default http://127.0.0.1:3001
 *
 * Everything is fail-open: if the container is down the session works as usual.
 */
import { Plugin } from "@opencode/plugin"

const SERVICE = (process.env.AGENT_MEMORY_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "")
const RECALL_TIMEOUT_MS = 20_000
const TIMEOUT_MS = 10_000
const RECALL_TTL_MS = 120_000

type Json = Record<string, any>

async function call(path: string, payload: Json, timeout = TIMEOUT_MS): Promise<Json | undefined> {
  try {
    const res = await fetch(`${SERVICE}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeout),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return undefined
    return (await res.json()) as Json
  } catch {
    return undefined
  }
}

/** The context hook gets AI-SDK messages; session.context() gets SessionMessage. */
function messageText(message: Json | undefined): string {
  if (!message || typeof message !== "object") return ""
  if (Array.isArray(message.content)) {
    const fromParts = message.content
      .filter((part: Json) => part?.type === "text" && typeof part.text === "string")
      .map((part: Json) => part.text)
      .join("\n")
    if (fromParts) return fromParts
  }
  return typeof message.text === "string" ? message.text : ""
}

function isUser(message: Json | undefined): boolean {
  if (!message || typeof message !== "object") return false
  return message.type === "user" || message.role === "user"
}

export default Plugin.define({
  id: "agent-memory",

  async setup(ctx) {
    const sessions = new Map<string, { directory: string }>()
    const recall = new Map<string, { at: number; text: string }>()

    async function directory(sessionID: string): Promise<string> {
      const known = sessions.get(sessionID)
      if (known) return known.directory
      let dir: string = ctx.location?.directory ?? process.cwd()
      try {
        const info = await ctx.session.get({ sessionID })
        dir = (info?.location?.directory as string | undefined) ?? dir
      } catch {}
      sessions.set(sessionID, { directory: dir })
      return dir
    }

    // --- recall: one system part per turn
    await ctx.session.hook("context", async (event) => {
      if (!event.messages?.length) return
      const messages = (event.messages ?? []) as unknown as Json[]
      const lastUser = [...messages].reverse().find(isUser)
      const query = lastUser ? messageText(lastUser).slice(0, 4000) : ""

      const hit = recall.get(event.sessionID)
      if (hit && hit.text && Date.now() - hit.at < RECALL_TTL_MS) {
        event.system.push({ type: "text", text: hit.text })
        return
      }

      const dir = await directory(event.sessionID)
      const result = await call("/recall", { directory: dir, sessionID: event.sessionID, message: query }, RECALL_TIMEOUT_MS)
      const block = String(result?.block ?? "")
      recall.set(event.sessionID, { at: Date.now(), text: block })
      if (block) event.system.push({ type: "text", text: block })
    })

    // --- capture: one episode per finished execution
    await ctx.session.hook("experimental.idle", async (event) => {
      if (event.background?.length) return // work still running; the hook runs again
      let messages: Json[] = []
      try {
        const info = await ctx.session.get({ sessionID: event.sessionID })
        if (info?.parentID) return // subagent: its parent's episode covers it
        messages = (await ctx.session.context({ sessionID: event.sessionID })) as unknown as Json[]
      } catch {
        return
      }
      if (!messages.length) return
      recall.delete(event.sessionID)
      await call("/capture", { directory: await directory(event.sessionID), sessionID: event.sessionID, messages })
    })

    // --- tools
    const remember = {
      name: "memory_remember",
      description:
        "Store one durable fact in long-term memory. Call it as soon as a durable fact is established — a " +
        "preference, correction, constraint, identity or decision — not only at the end of the session. One " +
        "self-contained sentence. Not for transient state. When subjectKey is given, any active fact with the " +
        "same key is retired in favour of the new one, so reuse the key whenever a fact can be restated.",
      input: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact, one sentence, self-contained." },
          kind: {
            type: "string",
            enum: ["preference", "decision", "constraint", "identity", "procedure", "fact"],
            description: "Category of the fact.",
          },
          subjectKey: {
            type: "string",
            description:
              "Stable key for the fact's subject, e.g. 'deploy-target'. Reusing a key retires the previous active " +
              "fact with that key, so the newest value is the only one recalled.",
          },
          supersedes: { type: "string", description: "Optional id of a fact this replaces." },
          pinned: {
            type: "boolean",
            description:
              "Show this fact in every prompt regardless of relevance — for constraints that must never be missed.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      } as const,
      async execute(input: Json, tool: any) {
        const result = await call("/remember", {
          ...input,
          directory: await directory(tool.sessionID),
          sessionID: tool.sessionID,
        })
        if (!result) return { content: "Memory service unreachable; the fact was not stored." }
        return {
          content:
            `Remembered in tenant "${result.tenant}"` +
            (result.retired ? `, superseding ${result.retired} earlier fact(s)` : "") +
            (result.indexed ? ", indexed for semantic recall" : "") +
            `: ${result.text}`,
          metadata: result,
        }
      },
    }

    const forget = {
      name: "memory_forget",
      description: "Deactivate a stored memory fact by its id. The record stays for provenance but stops being recalled.",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "Fact record id." } },
        required: ["id"],
        additionalProperties: false,
      } as const,
      async execute(input: Json, tool: any) {
        const result = await call("/forget", { id: input.id, directory: await directory(tool.sessionID) })
        if (!result) return { content: "Memory service unreachable; nothing was changed." }
        return { content: `Forgot ${result.id} in tenant "${result.tenant}".`, metadata: result }
      },
    }

    const reembed = {
      name: "memory_reembed",
      description:
        "Rebuild the semantic vector index for this tenant from the stored fact text. Run it after changing " +
        "AGENT_MEMORY_EMBEDDING_MODEL or AGENT_MEMORY_EMBEDDING_DIMENSIONS, or to backfill facts written while " +
        "embeddings were off. Safe to run repeatedly.",
      input: {
        type: "object",
        properties: {
          includeInactive: { type: "boolean", description: "Also re-embed superseded and forgotten facts." },
        },
        additionalProperties: false,
      } as const,
      async execute(input: Json, tool: any) {
        const result = await call(
          "/reembed",
          { includeInactive: input.includeInactive === true, directory: await directory(tool.sessionID) },
          RECALL_TIMEOUT_MS,
        )
        if (!result) return { content: "Memory service unreachable; nothing was re-embedded." }
        if (result.enabled === false) {
          return { content: `Embeddings are off (${result.reason}). Recall is keyword-only; nothing to re-embed.` }
        }
        return {
          content: `Re-embedded ${result.embedded}/${result.total} facts in tenant "${result.tenant}" with ${result.model} (${result.dimensions} dims).`,
          metadata: result,
        }
      },
    }

    await ctx.tool.transform((editor) => {
      editor.add(remember as any)
      editor.add(forget as any)
      editor.add(reembed as any)
    })
  },
})
