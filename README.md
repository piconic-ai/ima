# ima

Co-edit a local Markdown file with others, right now.

```sh
npx @piconic/ima notes.md
```

`ima` prints a link (and copies it to your clipboard). Paste it into Slack or wherever; whoever opens it edits the file with you in their browser. No install or account for them. Edits land in your local file about a second later. Press Ctrl+C to finish: the final state is written and the room closes.

**Why "ima"?** It comes from two Japanese words read *ima*: 居間 (the living room, where you casually invite people in) and 今 (now). You invite people into your place to write together, right now, and the document never leaves your home.

## How it works

```
your machine                     Cloudflare (ima.piconic.ai)           collaborators
notes.md  <->  ima CLI  <--wss-->  Worker -> Room (Durable Object)  <--wss-->  browser editor
```

- Your local file is the source of truth. The server stores nothing.
- Every update is encrypted end to end (AES-GCM) with a key that lives only in the link's `#fragment`. Browsers never send the fragment to the server, so the server only relays ciphertext it cannot read.
- Documents are synced with [Yjs](https://yjs.dev). Edits you make to the file in your own editor while sharing are streamed to the room too.
- Anyone with the link can edit. Share it like you would share a Google Docs link.

## Requirements

Node.js 22 or later.

Set `IMA_SERVER` to use a server other than `https://ima.piconic.ai`.

## Development

```sh
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm lint
```

Run everything locally:

```sh
pnpm --filter @ima/worker dev                  # builds the web editor, serves on http://localhost:8787
pnpm --filter @piconic/ima build
IMA_SERVER=http://localhost:8787 node packages/cli/dist/ima.js notes.md
```

| Package | What it is |
| --- | --- |
| `packages/protocol` | Encryption, message framing and the Yjs room client shared by CLI and web |
| `packages/worker` | Hono Worker + `Room` Durable Object (WebSocket Hibernation API); also serves the web editor |
| `packages/cli` | The `ima` command, published as `@piconic/ima` |
| `packages/web` | CodeMirror 6 editor for collaborators |

## Releases and deploys

Production (`ima.piconic.ai`) deploys when a tagpr release PR is merged
(see `.github/workflows/tagpr.yml`): the merge tags the release, the workflow
fast-forwards the `release` branch to the tag, and Cloudflare Workers Builds
deploys `release`. Every other branch gets its own
[Worker Preview](https://developers.cloudflare.com/workers/previews/) on push, at
`https://<branch-name>-ima.<subdomain>.workers.dev`, with its own Durable Object
namespace and its own logs under the Preview's Observability tab (Cloudflare
dashboard → ima Worker → Previews). Previews are configured by the `previews`
block in `packages/worker/wrangler.jsonc`.

To try a Preview with the CLI:

```sh
IMA_SERVER=https://<branch-name>-ima.<subdomain>.workers.dev npx @piconic/ima notes.md
```

Workers Builds settings (Cloudflare dashboard → ima Worker → Settings → Build):

| Setting | Value |
| --- | --- |
| Git repository | `piconic-ai/ima` |
| Root directory | `/` |
| Production branch | `release` |
| Build command | *(empty)* |
| Deploy command | `pnpm run deploy` |
| Non-production branch builds | enabled |
| Preview command | `pnpm run preview` |

The Worker runs on the Workers Free plan (100,000 requests a day). It uses a
SQLite-backed Durable Object and no D1 or KV. `piconic.ai` must be on the same
Cloudflare account for the custom domain.

## Publishing the CLI

The CLI shares the release version: tagpr bumps `version` in
`packages/cli/package.json`.

1. After the release PR is merged, check out the tag.
2. `cd packages/cli && npm publish` (`prepublishOnly` typechecks, tests and bundles into `dist/ima.js`; the package has no runtime dependencies).
3. On another machine, check that `npx @piconic/ima notes.md` works.
