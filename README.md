# Tools

CLI tools and automation, written in TypeScript with Effect and run with Vite+.
Each tool has a named TypeScript entry point at the repository root.

## Setup

Install Vite+ (`vp`) and Git, then run `vp install`.
The project pins Node and pnpm in `package.json` and dependencies in `pnpm-lock.yaml`.

## Project references

```sh
vpx ./refs.ts sync
vpx ./refs.ts init
vpx ./refs.ts sync effect
vpx ./refs.ts status
vpx ./refs.ts --help
vpx ./refs.ts sync --help
```

Run `sync` without a reference name to initialize refs and synchronize every
supported dependency declared in the project. Undeclared dependencies are skipped.
`status` without a name reports those same dependencies without modifying files or
accessing the network. Explicit requests such as `sync tanstack-form` fail clearly if
the dependency is not declared. Invalid declared pins fail rather than being skipped.

Project source snapshots read exact dependency pins from the target project's
`package.json` (dependencies or devDependencies), resolve their release tags, and
download source archives at the resolved commits. Default and named `catalog:`
references resolve through the nearest ancestor `pnpm-workspace.yaml`. Version
ranges are rejected.

| Reference        | Dependency                         |
| ---------------- | ---------------------------------- |
| `astryx`         | `@astryxdesign/core`               |
| `effect`         | `effect`                           |
| `tanstack-start` | `@tanstack/react-start`            |
| `tanstack-form`  | `@tanstack/react-form`             |
| `better-auth`    | `better-auth`                      |
| `alchemy`        | `alchemy`                          |
| `playwright`     | `@playwright/test` or `playwright` |
| `shopify-app-js` | `@shopify/shopify-api`             |

For example, `vpx ./refs.ts -p /path/to/project sync tanstack-start` downloads into
that project's shared `refs/tanstack-start/` directory. An undeclared dependency fails
with a clear message. Start's repository archive also includes Router source.
Playwright downloads the monorepo into `refs/playwright/`, preferring the
`@playwright/test` pin when both packages are declared. It is included in automatic
project sync; the globally installed browser CLI has no effect on refs.
Shopify App JS downloads the repository at the release tag for the pinned
`@shopify/shopify-api` version.
Astryx downloads the repository at the `v`-prefixed release tag for the pinned
`@astryxdesign/core` version.
Git, curl, and tar must be available.

Running without arguments shows help. Each subcommand has `--help` with examples;
`--project` (or `-p`) selects an existing project directory before or after the
subcommand. Effect supplies `--version`, usage validation, and shell completions
(for example `vpx ./refs.ts --completions zsh`). Invalid invocations and failed
operations exit nonzero; inspecting a missing or stale snapshot is a successful
status report.

`init` ensures the root `.gitignore` contains `/refs` (without a trailing slash,
so it ignores both directories and symlinks) and prepares the directory or worktree
link. It is safe to rerun, never edits `AGENTS.md`, and does not fetch source.
Project sync runs this same setup automatically, so `init` is optional. Shared
sync commands do not initialize project refs.

`package.json` is the version authority; there are no project reference config or
lock files. The ignored `refs/<reference>/.ref.json` stamp records the downloaded
version, commit, and fetch date. `sync` skips an existing snapshot matching the
pin; changing the pin resolves and downloads the new release on the next sync.
Removed dependencies are no longer synchronized; their existing folders are left alone. `status` compares
the stamp against the pin without network access or checking source files for edits.

The main checkout owns `refs/`. In a linked worktree, `init` creates or verifies a
symlink to the main checkout's directory, refusing to replace an existing directory
or unexpected link. From a new worktree, run `vpx /path/to/tools/refs.ts sync`;
it prepares the symlink and synchronizes all matching project dependencies. Before synchronization, worktrees declaring the selected dependency must agree on
its resolved pin. A directory lock prevents concurrent writers. If a process is
killed without cleanup, confirm no sync is running before removing
`refs/.sync-lock`.

Source snapshots are disposable reading copies. Repeated syncs of the same
snapshot skip downloading. A version change stages the new archive and replaces
the previous copy only after successful extraction; do not keep edits in these
snapshots. Directories without the tool's `.ref.json` stamp are never replaced.

To operate on another project, invoke the entry point by absolute path and pass
`--project`:

```sh
vpx /Users/mw/projects/tools/refs.ts --project /path/to/project init
vpx /Users/mw/projects/tools/refs.ts --project /path/to/project sync effect
```

## Shared references

```sh
vpx ./refs.ts sync cloudflare-docs
vpx ./refs.ts status cloudflare-docs
vpx ./refs.ts sync shopify-cli
vpx ./refs.ts sync shopify-docs
vpx ./refs.ts sync m4l-docs
vpx ./refs.ts sync vite-plus
vpx ./refs.ts sync vite
vpx ./refs.ts sync vitest
```

Shared sources live beside the tools repository by default, for example
`/Users/mw/projects/cloudflare-docs` and `/Users/mw/projects/shopify-cli`.
Use `--directory /path/to/projects` to override their parent directory. Relative
paths resolve from the current working directory. `--project` selects the project
for project dependencies and `init`; it does not change the shared destination.

Cloudflare docs is a fresh archive download of `cloudflare/cloudflare-docs`'s
`production` branch on every explicit sync. No Git history, version configuration,
or metadata stamp is kept. `status` reports directory presence without checking
upstream. Downloads and extraction happen in a temporary sibling directory; the
previous copy is replaced after success. These are disposable reading snapshots:
local edits are replaced on sync. Existing Git checkouts, files, and symlinks are
refused. Run shared sync commands one at a time.

Shopify CLI source is downloaded as a release archive matching `shopify version`
on your PATH. Every explicit sync checks the installed version and downloads that
release to `shopify-cli`. No hardcoded pin, Git history, or metadata stamp is kept.
Missing or unparseable CLI versions fail with a clear error. `status` reports only
whether the directory exists. This downloads source; it does not install the CLI.
Existing Git checkouts are refused rather than converted or replaced.

All commands now use `refs.ts`; the former `references.ts`, `references.json`,
and `src/references/` implementation have been removed. The optional reference
argument defaults to all matching project dependencies. Shared downloads must be
named explicitly and are never included in a bare project sync.
Shopify docs combines Baton's selected developer documentation with the complete
Shopify Flow Help Center manual in `shopify-docs/`. Developer Markdown lives under
`dev/docs/`, Flow Markdown under `flow/`, and shared images under `_assets/`.
`polaris-code/` contains the original Shopify CDN runtime bundle and a formatted
reading copy. Its README points back to the Polaris documentation under `dev/`;
it is code, not a substitute for those docs. It refreshes with Shopify docs.
API documentation, including webhook topics, follows `latest`. Discovery uses
Shopify's sitemaps and pages are downloaded through their native `.md` endpoints;
webhook topics are rendered from Shopify's `.data` endpoint.

Each explicit sync refreshes the combined snapshot. A failed page preserves the
previous copy; failed images retain their online URLs and print a warning. Flow
requests are paced and retried to handle rate limits. No config, lockfile, or
metadata stamp is written. A full download takes several minutes.

Vite+, Vite, and Vitest shared source archives follow `vp toolchain --global --json`.
Each explicit sync reads the global installation's version and downloads its
upstream release archive. The script locates the global `vp` outside `node_modules`
because `vpx` prepends local binaries to PATH. Local project toolchains may differ;
upstream Vite source is the bundled version's baseline and may omit Vite+ patches.
These shared snapshots have no metadata stamps; `status` reports presence only.

## Text to speech

```sh
vp run tts gen "Hello world" --dry-run
vp run tts gen "Hello world"
vp run tts gen "Another take" --voice athena
vp run tts play
vp run tts play 1
vp run tts play --device auto
```

Generation uses Cloudflare Workers AI with Aura 2 English and the `luna` voice
by default. `--model aura-1` selects Aura 1; see `gen --help` for supported voices.
Text must contain non-whitespace and fit within 500 Unicode code points.
Credentials come from the shell's `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; `.env` files are not loaded.
`--dry-run` previews the request, output path, and estimated cost without loading
credentials, creating files, or sending a request. Cost estimates are bundled
rates, not a live billing quote. Generation sends one paid request with no retries.

Recordings live in this checkout's ignored `tmp/tts/` directory, regardless of
the current working directory:

```text
tmp/tts/20261029-01-hello-world/
  hello-world.mp3
  hello-world.metadata.json
```

Folders use the UTC date, a daily sequence number, and a text excerpt. The metadata
includes the spoken text, model, voice, and request details. `--output` chooses an
MP3 path relative to this checkout or an absolute path; existing files are never
overwritten. Custom outputs outside `tmp/tts/` are played by explicit path.
Each worktree has its own disposable recordings; they are not shared or committed.

Playback requires `mpv` and defaults to the Speakers + BlackHole device
(`coreaudio/~:AMS2_StackedOutput:0`). Use `--device auto` for system output.
With no argument, `play` chooses the newest recording under `tmp/tts/`; a number
selects that daily sequence on the newest date containing it. A file path resolves
relative to this checkout. `mpv --audio-device=help` lists available devices.

## Development

```sh
vp check --fix
```

Verify changes with formatting, lint, and type checks, then run the relevant CLI
commands directly.

- `refs.ts`: project refs executable; only runtime wiring.
- `src/refs/command.ts`: Effect command definitions and help.
- `src/refs/project.ts`: project setup, dependency pins, and source snapshots.
- `src/refs/shared.ts`: shared snapshot replacement and source archive downloads.
- `src/refs/shopify-docs.ts`: developer docs, Flow manual, and local images.
- `src/refs/process.ts`: scoped child-process execution.
- `vite.config.ts`: formatting, lint, and TypeScript checks.

Give future tools named entry points at the repository root, with supporting
modules in `src/<tool>/` as needed. Introduce shared modules when multiple tools
need them.

M4L docs downloads the Max for Live documentation from `docs.cycling74.com` into
`m4l-docs/`: the Max for Live user guide, the Live Object Model, the `v8` (`apiref/js`)
and Node for Max APIs, and the `live.path`, `live.object` and `live.observer` reference
pages. The site is server-rendered, so each page's article is converted from its HTML to
Markdown without a browser or crawler. Links between fetched pages point at their
Markdown files, images are saved under `_assets/`, and inline SVG diagrams are saved as
standalone files there. No version or metadata stamp is kept; every explicit sync
replaces the snapshot.
