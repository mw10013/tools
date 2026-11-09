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
| `distilled`      | `@distilled.cloud/stripe`          |
| `playwright`     | `@playwright/test` or `playwright` |
| `shopify-app-js` | `@shopify/shopify-api`             |
| `graphql`        | `graphql`                          |
| `graphql-yoga`   | `graphql-yoga`                     |
| `stylex`         | `@stylexjs/stylex`                 |

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

## Dev servers

`bosun` runs a checkout's dev servers in the background: start, stop, status
and logs, with each server publishing the port it picked. See
[docs/bosun.md](docs/bosun.md). Put it on PATH the same way as berth below, with
`exec vpx /Users/mw/projects/tools/bosun.ts "$@"` in `~/.local/bin/bosun`.

## Dev stores

`berth` leases Shopify dev stores from the pool in `stores.json` to each
checkout and env, so no two Shopify app checkouts on one machine share a store.
Ports are not berth's: each dev server runs under bosun and picks its own. The
design is in [docs/berth.md](docs/berth.md).

### Put berth on PATH

Consumers in other repos call `berth`, so create a shim at `~/.local/bin/berth`:

```sh
#!/bin/sh
exec vpx /Users/mw/projects/tools/berth.ts "$@"
```

Make it executable with `chmod +x ~/.local/bin/berth`, and keep `~/.local/bin`
on PATH. Inside this repository, `vp run berth` runs the same entry point,
though `vp run` adds a task banner to stdout.

### Declare what a project needs

Commit a `berth.json` at the project root. Each env names the app config its
`shopify app dev` runs with. An env without `store` is rejected. A
`store.pool` field is accepted and ignored:

```json
{
  "project": "baton",
  "envs": {
    "dev": { "store": { "config": "shopify.app.toml" } },
    "e2e": { "store": { "config": "shopify.app.e2e.toml" } }
  }
}
```

### Lease, release and list

```sh
berth acquire dev                         # print this checkout's dev lease as JSON
berth acquire dev --adopt store=mw10013-pool-01
berth show dev                            # this checkout's dev lease, or null; never creates one
berth release                             # free this checkout's leases
berth list                                # every lease and the store pool
berth list --json
```

`berth` finds the checkout by walking up from the current directory to the
nearest `berth.json`. `acquire` returns the same lease on every run, and a
rerun writes nothing. A typed failure exits 1 with
`{ "berth": 1, "error": { "_tag", "message", ... } }` on stdout. A usage error
exits 2.

- `StorePoolExhaustedError`: every store in `stores.json` is leased. Release
  a lease, or grow the pool with `berth pool ensure <count>`. berth never
  deletes a store.
- `LeaseInUseError`: this checkout's `shopify app dev` runs on the store. Stop
  it, then release.

A lease whose checkout directory is gone ends at the next `acquire` or
`release` anywhere on the machine. berth runs no `shopify app dev clean`. The
next holder's `shopify app dev` replaces the store's dev preview.

### The store pool

`stores.json` at the repository root names the Shopify organization, the pool's
name prefix and the store handles, such as `"mw10013-pool-00"`. berth leases
`<handle>.myshopify.com` for each, first free in list order. Only
`berth pool ensure` writes it:

```sh
berth pool ensure                         # check every listed store, adopt strays
berth pool ensure 16                      # also create stores until the pool holds 16
```

It creates each store with the Shopify CLI, then lists it, so commit
`stores.json` after a run that changed it. See
[docs/berth.md](docs/berth.md#pool-ensure).

### Machine config

`$XDG_CONFIG_HOME/berth/config.json` (default `~/.config/berth/config.json`)
sets machine policy. Its one field, `machine`, is optional and defaults to the
host name without `.local`. The ledger lives in `$XDG_STATE_HOME/berth/ledger/` (default
`~/.local/state/berth/ledger/`). To try berth without touching the real
ledger, set both variables to temporary directories.

## Development

```sh
vp check --fix
vp test
```

Verify changes with formatting, lint, and type checks, then run the relevant CLI
commands directly.

- `refs.ts`: project refs executable; only runtime wiring.
- `src/refs/command.ts`: Effect command definitions and help.
- `src/refs/project.ts`: project setup, dependency pins, and source snapshots.
- `src/refs/shared.ts`: shared snapshot replacement and source archive downloads.
- `src/refs/shopify-docs.ts`: developer docs, Flow manual, and local images.
- `src/refs/process.ts`: scoped child-process execution.
- `berth.ts`: berth executable; only runtime wiring.
- `src/berth/command.ts`: the CLI and its JSON contract.
- `src/berth/lease.ts`: `acquire`, `release`, `show` and `list`.
- `src/berth/domain.ts`: the ledger state and its pure transitions.
- `src/berth/ledger.ts`: the generation ledger and its compare-and-swap.
- `src/berth/shopify.ts`: the Shopify CLI's dev session files.
- `vite.config.ts`: formatting, lint, TypeScript checks, and the test scope.

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

## Worktrees

`wt` makes and removes git worktrees for tasks in any repository. Run it from
any checkout of the repository.

```sh
wt new fix plan labels        # ~/.t3/worktrees/<repo>/fix-plan-labels, branch fix-plan-labels
wt new pr 123 --exact         # fail instead of adding -2 when the name is taken
wt new hotfix --from origin/production
wt rm                         # the worktree you are in; or wt rm <name|path|branch>
wt rm --force                 # discard unlanded commits; uncommitted changes still refuse
wt init                       # link the main checkout's shared files again, after one is added
wt list
```

`new` starts from origin's default branch after a fetch, with no upstream, so
the first push names the branch (`git push -u origin HEAD`). It symlinks every
untracked `.env`, `.env.<suffix>` (`.env.staging`, not the tracked
`.env.example`) and `refs` directory the main checkout has, at any depth outside
`node_modules` (`apps/testbed/.env` as well as `.env`), to the same path in the
worktree, when the worktree has that path's folder. A worktree's `.env` is the
main checkout's file, so an edit in either is seen by every checkout. With a `package.json` it runs `vp install --frozen-lockfile`. It runs
no package script: berth leases come on demand from `vp run dev` and e2e, so a
repo needs no worktree hooks, and a worktree made by another tool works the
same. `init` only shares again. A copy of a shared file identical to the main
checkout's, as an older `wt` left `.env`, becomes the link; any other file, or a
link pointing elsewhere, fails rather than being replaced. `rm` removes only landed work: no commits
beyond origin's default branch, or a merged pull request whose head is the
branch's tip, which is what a squash merge leaves. It then tears down every app
in the worktree, at any depth outside `node_modules` and `.git`: `bosun stop
<name>` in each folder whose `.bosun/<name>/record.json` exists, `rigging server
stop <name>` with that folder's own `node_modules/.bin/rigging` for each
`.rigging/servers/<name>/record.json` (or, with no such bin, a stop of the
recorded process group), then `berth
release` in each folder with a `berth.json`. A failed step stops `rm` before it
removes anything. Then it stops what the worktree left running, removes the
worktree and deletes the branch. After `wt rm` from inside the worktree, `cd`
out: the directory is gone.

Each command prints one JSON document on stdout, `{ "wt": 1, ... }`, and its
progress on stderr. A typed failure exits 1 with `{ "wt": 1, "error": { "_tag",
"message", ... } }`; a usage error exits 2. `$WT_ROOT` moves the worktrees
root.

Put it on PATH like berth, with `~/.local/bin/wt`:

```sh
#!/bin/sh
exec vpx /Users/mw/projects/tools/wt.ts "$@"
```

## Shared app tooling

`devkit` is the dev tooling the apps share, in `src/devkit/<layer>/`: `core` for
any project, `cloudflare` for Alchemy on Workers, `shopify` for an embedded
Shopify app. It ships as the package `@mw10013/devkit`, installed from a release
tag of this public repository:

```json
"@mw10013/devkit": "github:mw10013/tools#devkit-v0.1.0"
```

A pnpm monorepo declares that spec once, in its `pnpm-workspace.yaml` catalog,
and each package depends on it as `catalog:`. The lockfile pins the tag's commit
and the tarball's sha512, and the tarball downloads from codeload without a token,
so Workers Builds installs it like any dependency. The app imports
`@mw10013/devkit/<layer>/<module>` and runs the `devkit-*` bins; it holds no copy.

```sh
devkit release 0.2.0 --dry-run  # everything except the tag and the push
devkit release 0.2.0            # publish devkit-v0.2.0
devkit status                   # this app: declared spec, locked version, latest release
devkit status --projects ~/projects  # every consumer one level under ~/projects
devkit upgrade                  # this app to the latest release (or: devkit upgrade 0.2.0)
devkit check-pin                # fail unless devkit is pinned to a release
```

`devkit` works on the app root around the working directory: the nearest folder
upward that holds a `package.json`, never above the git toplevel. Each command
prints one JSON document on stdout, `{ "devkit": 1, ... }`, and its progress on
stderr; a typed failure exits 1 with `{ "devkit": 1, "error": { "_tag", "message" } }`.

### Release

`devkit release <major.minor.patch>` runs in tools. It refuses unless the checkout
is clean, `HEAD` is the commit `origin` holds as `main` (read with `git ls-remote`,
not a possibly stale remote-tracking ref), and the version is greater than the
latest `devkit-v*` tag. It then runs `vp check` and
`vp test run src/devkit src/devkit-cli`, the whole gate and not only the build
test: an app loads devkit's lint plugin and type-checks its declarations, so a lint
or type error in devkit breaks every consumer, and the build test sees neither.

It builds the package into a temporary directory with the version stamped into
`package.json` (`pnpm list` reports it as the locked version), adds `LICENSE` and a
short `README.md`, and writes that tree through a temporary index, so the working
tree is never touched. The commit is an orphan whose parent is the previous release
commit; its message, which is also the tag's annotation, records the source sha and
the `src/devkit` commits since the previous release. Then it creates the annotated
tag `devkit-v<version>` and pushes that tag, nothing else. No branch holds the
release commit.

A tag is never moved, because lockfiles pin its commit. Re-running a release whose
tag exists with the same tree succeeds, and pushes the tag if only the local copy
exists; a different tree fails. `--dry-run` runs the checks, the build and the
commit, but creates no tag, because a local tag is a ref every worktree of the
repository shares, and pushes nothing.

### Status and upgrade

`devkit status` reports one row for the app: `spec` and where it is declared (a
`package.json` dependency or devDependency, or the workspace catalog behind
`catalog:`), `declared` (the release it pins), `locked` (what `pnpm list --json
--lockfile-only` resolved), and `latest` (the newest `devkit-v*` tag on GitHub,
`unknown` offline). `state` is `current` or `behind` by comparing `declared` with
`latest`, `unknown` when `latest` is unknown, `unpinned` for a `file:`, `link:`,
branch, sha or prerelease spec, `legacy` for a `vendor/devkit/devkit.json` stamp
(its `legacy` field is the tools sha) with no declaration, or `none`.

`--projects <dir>` scans each directory one level under `<dir>`, skipping
`node_modules`, `.git` and `refs`, and reports a row for each repository root and
workspace package that declares devkit or holds a legacy stamp. Consumers are found
by looking, never from a list.

`devkit upgrade [x.y.z]` refuses a dirty tree, sets the one declaration to
`github:mw10013/tools#devkit-v<x.y.z>` (the latest release by default), runs
`vp install` and prints the release log: the annotations of the tags after the old
version up to the new. It edits the workspace catalog when the spec lives there,
and the `package.json` otherwise, changing only that line. It does not commit,
test or open a pull request.

`devkit check-pin` exits 1 unless every declaration under the app, its workspace
packages included, is a release pin: a `file:`, `link:`, branch, bare sha or
prerelease spec, or a legacy stamp, fails. An app's `vp check` or CI can run it so
a trial spec cannot merge.

`devkit sync` is retired and refuses.

`core/lint/rules.ts` is the house lint rule set. tools lints the whole repo with
it, devkit included. An app spreads `lint` from `@mw10013/devkit/core/lint/rules`
into its config and adds only its own data: `ignorePatterns`, the website's plugins
and rules, and its import boundaries, which start from `baseRestrictions`.

Two bins cover the deployed stages. `devkit-logs` reads a deployed stage's Worker
logs from Workers Observability (`show`, `follow`, `wait`). `devkit-stage` sets up
staging and production's Workers Builds deploys from a laptop, run as
`vp run stage <up|check|reset> <stage>` with `"stage": "devkit-stage"` (`vp run
stage --help`). `up` checks `.env.<stage>` against the fields the app declares in
`stacks/stage-env.ts`,
gives a stage with no Website its first deploy from the laptop (`alchemy deploy`
with the file's values in its environment, only from a clean checkout whose
`HEAD` is the stage's branch on `origin`), makes its one trigger canonical, sets
the trigger's variables from the file (secrets as Builds secrets, through a
temporary file, never on argv), deletes undeclared ones, and builds the
stage's branch; `production` writes only with `--confirm production`. `check`
reads the plan, the trigger, its variables' names and the latest build.
`reset staging --confirm staging` destroys staging, then runs `up`. The stack
helpers it relies on, `requireStageEnv` among them, are in
`cloudflare/deployed-stack.ts`. The coder skill's `deployed-stages.md` is the
lifecycle.

### The package

`src/devkit/package.json` makes devkit the package `@mw10013/devkit` and is the
one list of its public surface: `exports` (the modules an app imports, layer
first: `@mw10013/devkit/core/app`), `bin` (`devkit-stage`, `devkit-logs`,
`devkit-bosun-port`) and the peer dependencies, optional for what only a layer
needs. A module it does not list, such as `core/orphans`, is internal.

```sh
vp run build:devkit   # dist/devkit/: package.json plus dist/*.mjs and *.d.mts
```

The build's entries come from that file and the built manifest maps each export
to `{ types, default }` in `dist/`, so the list exists once.
`src/devkit-cli/build.test.ts` runs the build and checks it: every export has
script and types, no `.ts` specifier remains, `cloudflare/stage` reaches only
`effect`, no `core` export reaches Alchemy or Playwright, and an unlisted module
cannot be imported. tools lints with the same plugin its consumers load, by
specifier, through its `@mw10013/devkit` link to `src/devkit`.

The app is `app(directory)` from `core/app.ts` (nearest `package.json`, never
above the git toplevel), which replaced `ROOT` and `APP_NAME`: a config passes
`import.meta.dirname`, a CLI takes the working directory, and `integ-setup` takes
the Vitest project's root.
