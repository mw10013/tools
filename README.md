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
```

`refs.ts` currently supports Effect source snapshots. It reads the exact `effect`
pin from the target project's `package.json` (dependencies or devDependencies),
resolves `effect@<version>`, and downloads the source archive at that commit.
Version ranges and catalog references are rejected in this first iteration.
Git, curl, and tar must be available.

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

The existing shared-reference manager below remains available separately during
this first iteration; shared sources and website mirrors are not yet integrated
into `refs.ts`.

## Shared references

```sh
vpx ./references.ts status
vpx ./references.ts sync cloudflare-docs
```

The package command is also available as a shortcut:

```sh
vp run references status
vp run references sync cloudflare-docs
vp run references sync shopify-cli
vp run references sync all
vp run references sync --help
```

The optional source argument defaults to `all`. Checkouts live beside the tools
repository by default (for example `/Users/mw/projects/cloudflare-docs` and
`/Users/mw/projects/shopify-cli`). Override the parent directory with
`--directory /path/to/references`. Relative overrides resolve from the current
working directory.

- **Cloudflare docs:** `cloudflare/cloudflare-docs`, tracking `production`.
- **Shopify CLI source:** `Shopify/cli`, checked out at the release in
  `references.json` with a detached HEAD. Edit `shopifyCliVersion` and run sync
  to change releases. This manages source only; it does not install or upgrade
  the globally installed Shopify CLI.

Missing checkouts are shallow-cloned into a temporary sibling folder and moved
into place after a successful clone. Failed clones are cleaned up. Existing
Cloudflare checkouts update through a fast-forward merge only. Sync refuses
uncommitted or untracked changes, unexpected origins, and unexpected branches.
Shopify CLI updates also refuse to leave an untagged detached commit. The tool
does not reset, stash, clean, or delete existing checkouts.

`status` inspects local state without contacting GitHub. Matching the local
remote-tracking branch does not prove that a checkout is current on GitHub;
run `sync` to fetch updates. An invalid checkout or failed operation exits
nonzero; operations stop at the first failure.

These commands do not migrate or remove existing project `refs` folders.
Shopify developer docs and Flow documentation will have their own downloader
project.

## Running from another directory

```sh
(cd /Users/mw/projects/tools && vp run references status)
```

No global installation or PATH changes are required. For direct execution
without package-task banners:

```sh
vpx /Users/mw/projects/tools/references.ts status
```

## Development

```sh
vp check --fix
vp run test
```

Integration tests use temporary local Git repositories; they do not contact
GitHub or modify reference checkouts.

- `references.ts`: Effect CLI entry point.
- `src/references/sources.ts`: source definitions and configuration decoding.
- `src/references/checkouts.ts`: checkout inspection and synchronization.
- `references.json`: Shopify CLI source release pin.
- `vite.config.ts`: formatting, lint, and TypeScript checks.

Give future tools named entry points at the repository root, with supporting
modules in `src/<tool>/` as needed. Introduce shared modules when multiple tools
need them.
