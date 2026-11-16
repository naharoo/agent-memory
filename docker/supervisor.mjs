#!/usr/bin/env node
/**
 * PID 1 for the container.
 *
 * The engine image has no shell, so this is the smallest thing that can start two
 * processes, forward signals, and fail loudly enough for Docker's restart policy to
 * notice. The engine is bound to loopback: it is never published, so its built-in
 * default token is not reachable from outside the container.
 */
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"

const ENGINE_BIN = "/usr/local/bin/rushdb"
const ENGINE_PORT = Number(process.env.AGENT_MEMORY_ENGINE_PORT ?? 3000)
const DATA_DIR = process.env.AGENT_MEMORY_DATA_DIR ?? "/data"
const ENGINE_DATA = `${DATA_DIR}/engine`
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`

const children = []
let shuttingDown = false

function start(name, command, args, env) {
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } })
  child.on("exit", (code, signal) => {
    if (shuttingDown) return
    console.error(`[supervisor] ${name} exited (code=${code} signal=${signal})`)
    shutdown(code ?? 1)
  })
  child.on("error", (error) => {
    console.error(`[supervisor] ${name} failed to start: ${error.message}`)
    shutdown(1)
  })
  children.push({ name, child })
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of children) {
    try {
      child.kill("SIGTERM")
    } catch {}
  }
  setTimeout(() => process.exit(code), 4000).unref()
  Promise.all(
    children.map(
      ({ child }) =>
        new Promise((resolve) => {
          if (child.exitCode !== null) return resolve()
          child.once("exit", resolve)
        }),
    ),
  ).then(() => process.exit(code))
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0))
}

async function waitForEngine(deadlineMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

// Tenancy mode is an isolation invariant baked into the data directory; --multitenant
// must match however the store was created or the engine refuses to open it.
//
// The engine treats config.yml as the source of truth and *refuses to start* when a
// flag disagrees with it, so a data directory created by an older setup (listen-addr
// 0.0.0.0) has to be corrected before launch rather than overridden.
async function normalizeConfig() {
  const file = `${ENGINE_DATA}/config.yml`
  try {
    const text = await readFile(file, "utf8")
    const next = text.replace(/^(\s*listen-addr:\s*)0\.0\.0\.0\s*$/m, "$1127.0.0.1")
    if (next !== text) {
      await writeFile(file, next, "utf8")
      console.log("[supervisor] config.yml: listen-addr 0.0.0.0 -> 127.0.0.1")
    }
  } catch {}
}

await normalizeConfig()

start("engine", ENGINE_BIN, [
  "serve",
  "--multitenant",
  "--data-dir",
  ENGINE_DATA,
  "--listen",
  "127.0.0.1",
  "--port",
  String(ENGINE_PORT),
])

if (!(await waitForEngine())) {
  console.error("[supervisor] engine did not become healthy within 60s")
  shutdown(1)
} else {
  console.log(`[supervisor] engine ready on ${ENGINE_URL}`)
  start("service", process.execPath, ["/app/src/service.mjs"], {
    AGENT_MEMORY_ENGINE_URL: ENGINE_URL,
    AGENT_MEMORY_DATA_DIR: DATA_DIR,
  })
}
