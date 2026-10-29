# Tools

CLI tools and automation, written in TypeScript with Effect and run with Vite+.
Each tool has its own entry point and package command.

## Setup

Install Vite+ (`vp`) and Git, then run `vp install`.
The project pins Node and pnpm in `package.json` and dependencies in `pnpm-lock.yaml`.

## Shared references

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
vpx /Users/mw/projects/tools/src/references/cli.ts status
```

## Development

```sh
vp check --fix
vp run test
```

Integration tests use temporary local Git repositories; they do not contact
GitHub or modify reference checkouts.

- `src/references/cli.ts`: Effect CLI entry point.
- `src/references/sources.ts`: source definitions and configuration decoding.
- `src/references/checkouts.ts`: checkout inspection and synchronization.
- `references.json`: Shopify CLI source release pin.
- `vite.config.ts`: formatting, lint, and TypeScript checks.

Add future tools in their own `src/<tool>/` directory with a corresponding
package script. Introduce shared modules when multiple tools need them.
