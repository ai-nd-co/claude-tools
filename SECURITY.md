# Security notes and known limitations

These are properties of the tool a user should know before installing it. None is a disclosure of a
vulnerability in anyone else's software.

## The browser extension trusts a local WebSocket

`extension/` talks to a bridge on `ws://127.0.0.1:7331` and accepts debugger-backed commands from it.
There is no authentication on that socket, so **any local process that binds the port first, or
reaches it, can drive the browser tabs the extension can reach.** Use it only on a machine where you
trust every local process, and do not load the extension on a shared or multi-user host.
The bridge also accepts any `Origin` on the WebSocket upgrade and trusts the responses it
receives, so a local process can both drive it and answer for it.

## `postinstall` patches a dependency in place

`scripts/postinstall.js` rewrites `node_modules/telegram/extensions/markdownv2.js` to move inline-link
handling ahead of other formatting and to disable hyphen-italics, which otherwise corrupt URLs. GramJS
is MIT-licensed and permits modification. The patch is optional: if the file is not found, for example
under a hoisted or pnpm layout, the script logs and exits 0 rather than failing the install. If you
would rather not have a dependency mutated, install with `--ignore-scripts`; formatting of links in
Telegram messages is then less reliable.

## `--dangerously-skip-permissions` is passed by design

`fork`, `resume`, `startup` and `spawn` (on Linux and on Windows) launch Claude Code with `--dangerously-skip-permissions`, because they
exist to continue an existing session without re-prompting. That disables permission checks for the
launched session. This is deliberate; if it is not what you want, do not use those subcommands.

## Dependency advisories

`npm audit --omit=dev` reports open advisories in the production dependency tree, including transitive
`protobufjs` and `basic-ftp` findings. They arrive through `telegram`, `@grpc/*` and
`screenshot-desktop`. Run `npm audit` yourself and judge reachability for your use; this project does
not pin patched forks.

## A dependency's licence metadata is inconsistent

`@cryptography/aes`, reached through `telegram`, publishes npm metadata declaring GPL-3.0-or-later
while its upstream repository's root licence is Apache-2.0. This project's own code is MIT. If that
distinction matters to you, resolve it with the dependency's authors before redistributing a bundle.
