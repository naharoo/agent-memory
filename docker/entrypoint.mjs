#!/usr/bin/env node
/**
 * Entrypoint dispatch.
 *
 * The image has two modes: run the stack (default) or act on a mounted host
 * directory (install-opencode / uninstall-opencode). Dispatching here rather than
 * relying on --entrypoint keeps the documented one-liner honest, and makes it
 * impossible to start a second engine on a data directory by accident.
 */
const command = process.argv[2]

if (command === "install-opencode" || command === "uninstall-opencode") {
  await import("./install-opencode.mjs")
} else if (command === undefined) {
  await import("./supervisor.mjs")
} else {
  console.error(`unknown command: ${command}`)
  console.error("usage: <image>                     run the stack")
  console.error("       <image> install-opencode    install the adapter into a mounted host dir")
  console.error("       <image> uninstall-opencode  remove it")
  process.exit(2)
}
