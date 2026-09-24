# ima

A CLI that lets you co-edit a local Markdown file with other people, right now.
`ima <file>` prints a URL; others join from their browser.
The name comes from the Japanese 居間 (living room) and 今 (now).

## Principles
- The host's local file is the source of truth. The server never stores content.
- Updates are end-to-end encrypted with a key held in the URL fragment; the server only relays ciphertext.
- Never send the key to the server (not in requests, logs, or error reports).
- The minimal version only co-edits a single Markdown file. No auth, comments, or AI features.

## Layout (pnpm workspaces)
- packages/protocol: encryption and message format (shared by CLI and web)
- packages/worker: Hono + Durable Objects (WebSocket Hibernation API). Also serves the web assets.
- packages/cli: the `ima` command (Node.js 22+). Published to npm as @piconic/ima
- packages/web: editor built on CodeMirror 6 + y-codemirror.next

## Stack
TypeScript / Yjs / y-protocols / Cloudflare Workers / Vitest

## Workflow
- Present a plan before implementing.
- Add tests with every change and make them pass before committing.
