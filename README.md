# Tools

CLI tools and automation, written in TypeScript with Effect and run with Vite+.
Each tool has a named TypeScript entry point at the repository root.

## Setup

Install Vite+ (`vp`) and Git, then run `vp install`.
The project pins Node and pnpm in `package.json` and dependencies in `pnpm-lock.yaml`.

## Project references

```sh
vpx ./refs.ts init
vpx ./refs.ts sync effect
vpx ./refs.ts status
vpx ./refs.ts --help
vpx ./refs.ts sync --help
```

For Effect source snapshots, `refs.ts` reads the exact `effect`
pin from the target project's `package.json` (dependencies or devDependencies),
resolves `effect@<version>`, and downloads the source archive at that commit.
Version ranges and catalog references are rejected in this first iteration.
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

`package.json` is the version authority; there are no project reference config or
lock files. The ignored `refs/effect/.ref.json` stamp records the downloaded
version, commit, and fetch date. `sync` skips an existing snapshot matching the
pin; changing the pin resolves and downloads the new release. `status` compares
the stamp against the pin without network access or checking source files for edits.

The main checkout owns `refs/`. In a linked worktree, `init` creates or verifies a
symlink to the main checkout's directory, refusing to replace an existing directory
or unexpected link. Before synchronization, worktrees with an Effect dependency must agree on
the Effect pin. A directory lock prevents concurrent writers. If a process is
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
```

Shared sources live beside the tools repository by default, for example
`/Users/mw/projects/cloudflare-docs` and `/Users/mw/projects/shopify-cli`.
Use `--directory /path/to/projects` to override their parent directory. Relative
paths resolve from the current working directory. `--project` selects the project
for Effect and `init`; it does not change the shared destination.

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
argument still defaults to `effect`. Shared downloads must be named explicitly.
Shopify docs combines Baton's selected developer documentation with the complete
Shopify Flow Help Center manual in `shopify-docs/`. Developer Markdown lives under
`dev/docs/`, Flow Markdown under `flow/`, and shared images under `_assets/`.
API documentation, including webhook topics, follows `latest`. Discovery uses
Shopify's sitemaps and pages are downloaded through their native `.md` endpoints;
webhook topics are rendered from Shopify's `.data` endpoint.

Each explicit sync refreshes the combined snapshot. A failed page preserves the
previous copy; failed images retain their online URLs and print a warning. Flow
requests are paced and retried to handle rate limits. No config, lockfile, or
metadata stamp is written. A full download takes several minutes.

## Development

```sh
vp check --fix
```

Verify changes with formatting, lint, and type checks, then run the relevant CLI
commands directly.

- `refs.ts`: project refs executable; only runtime wiring.
- `src/refs/command.ts`: Effect command definitions and help.
- `src/refs/project.ts`: project setup and Effect snapshots.
- `src/refs/shared.ts`: shared snapshot replacement and source archive downloads.
- `src/refs/shopify-docs.ts`: developer docs, Flow manual, and local images.
- `src/refs/process.ts`: scoped child-process execution.
- `vite.config.ts`: formatting, lint, and TypeScript checks.

Give future tools named entry points at the repository root, with supporting
modules in `src/<tool>/` as needed. Introduce shared modules when multiple tools
need them.
