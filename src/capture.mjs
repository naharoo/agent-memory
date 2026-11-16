/**
 * Capture: one EPISODE per finished agent execution.
 *
 * The capture unit is the latest user/assistant pair — the user's final instruction
 * plus the assistant's closing report — not the whole transcript. Mid-session
 * decisions are written by memory_remember as they happen.
 */
import { clip, toIso } from "./recall.mjs"
import { putRecord } from "./engine.mjs"

const MAX_SUMMARY = 4000

function partText(message) {
  if (!message || typeof message !== "object") return ""
  if (Array.isArray(message.content)) {
    const fromParts = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (fromParts) return fromParts
  }
  return typeof message.text === "string" ? message.text : ""
}

function isRole(message, role) {
  if (!message || typeof message !== "object") return false
  return message.type === role || message.role === role
}

/**
 * Accepts the common transcript shapes: {type, text, content} (opencode SessionMessage)
 * and {role, content} (AI-SDK). Anything else is ignored rather than thrown on —
 * a capture failure must never cost the episode.
 */
export function buildEpisode(sessionID, directory, messages, title) {
  const valid = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === "object")
  const users = valid.filter((m) => isRole(m, "user") && partText(m).trim())
  const assistants = valid.filter((m) => isRole(m, "assistant") && partText(m).trim())
  if (!users.length && !assistants.length) return undefined

  const lastIdle = [...valid].reverse().find((m) => m.type === "idle")
  const first = users[0]
  const lastUser = users.at(-1)
  const lastAssistant = assistants.at(-1)
  const summary = [
    lastUser ? `User: ${clip(partText(lastUser), 1200)}` : "",
    lastAssistant ? `Assistant: ${clip(partText(lastAssistant), MAX_SUMMARY - 1200)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  const fallbackTitle = partText(first) || "session"

  return {
    episodeId: `${sessionID}:${valid.length}`,
    sessionID,
    directory,
    title: clip(title ?? fallbackTitle, 120),
    summary,
    outcome: lastIdle?.outcome ?? "succeeded",
    turnCount: users.length,
    messageCount: valid.length,
    startedAt: toIso(first?.time?.created) ?? new Date().toISOString(),
    endedAt: toIso(lastIdle?.time?.created) ?? new Date().toISOString(),
    createdAt: new Date().toISOString(),
    kind: "session",
  }
}

export async function capture({ tenant, sessionID, directory, messages, title }) {
  const episode = buildEpisode(sessionID, directory, messages, title)
  if (!episode) return undefined
  await putRecord("EPISODE", episode, tenant)
  return episode
}
