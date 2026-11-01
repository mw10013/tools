# berth

berth hands out local dev resources so many projects and checkouts run side by side on one machine without collisions. Every project can lease ports. A Shopify app can also lease a dev store. A lease belongs to one checkout and one environment, and it lasts until the checkout releases it or its directory disappears.

## Usage

A project commits `berth.json` at its root. It declares what each environment needs and holds no values.

```json
{
  "project": "baton",
  "envs": {
    "dev": {
      "ports": ["web", "graphiql"],
      "store": { "pool": "dev", "config": "shopify.app.toml" }
    },
    "e2e": {
      "ports": ["web", "graphiql"],
      "store": { "pool": "e2e", "config": "shopify.app.e2e.toml" }
    }
  }
}
```

A project with no Shopify app leaves out `store`.

```json
{ "project": "sole-prop", "envs": { "dev": { "ports": ["web"] } } }
```

berth walks up from the working directory to the nearest `berth.json`. That directory, with symlinks resolved, is the checkout.

```sh
berth acquire <env> [--bindable] [--adopt role=value ...]   # ensure and print this checkout's lease
berth release [<env>]                                        # clean the store's dev preview, then free
berth list [--json]                                          # who holds what, across all projects
```

- `acquire` is idempotent. The same checkout and env always get the same lease. When the manifest changes, `acquire` adds ports for new roles, frees ports for removed roles, and adds or drops the store.
- `--bindable` means the caller is about to bind the ports. It fails with `PortBusyError` unless every leased port binds right now. A leased port never moves.
- `--adopt web=3901 --adopt store=mw10013-dev-shop-01` takes exact values once, for migration from `.env`. It fails if another lease holds a value.
- `release` runs `shopify app dev clean --config <config> --store <domain>` from the checkout first. If the clean fails, the lease stays and `release` exits nonzero, so running it again is safe. It refuses while this checkout's `shopify app dev` runs on the store, read from `.shopify/dev/app-dev-*.json`.

`acquire` prints only this on stdout. Human lines go to stderr.

```json
{
  "berth": 1,
  "project": "baton",
  "checkout": "/Users/mw/.t3/worktrees/baton/wt-02",
  "env": "dev",
  "machine": "mw-mbp",
  "ports": { "web": 3912, "graphiql": 3913 },
  "store": {
    "domain": "mw10013-dev-shop-07.myshopify.com",
    "config": "shopify.app.toml"
  },
  "acquiredAt": "2026-11-01T09:12:44.120Z"
}
```

`store` is `null` for an env without a store. A typed failure exits 1 and prints `{ "berth": 1, "error": { "_tag": "...", "message": "..." } }`. `StorePoolExhaustedError` adds `create`, the exact `shopify store create dev --name <next> --organization-id 130059740 --json` command. A usage error exits 2. Version 1 only grows. Fields are added, never renamed or removed.

Machine policy is `~/.config/berth/config.json`. Every field is optional.

```json
{
  "machine": "mw-mbp",
  "ports": {
    "first": 3500,
    "last": 4999,
    "reserved": [3457, 6969, 7171, 9333]
  },
  "stores": {
    "organizationId": "130059740",
    "pools": {
      "dev": "^mw10013-dev-shop-\\d{2}$",
      "e2e": "^mw10013-e2e-shop-\\d{2}$"
    }
  }
}
```

The reserved ports are xnotes (6969, 7171), the shared agent Chrome's CDP (9333) and the Shopify CLI's default GraphiQL (3457).

## Design

**State.** The one stored value is `State = { leases, pool, poolSyncedAt }`. A `Lease` is `{ key: { machine, checkout, env }, project, ports: Record<role, Port>, store: Option<{ domain, pool, config }>, acquiredAt }`. Taken ports, a store's holder and stale leases are derived, never stored. `checkState` runs on every read and write and rejects a port, store or key held twice, a leased reserved port, and a held store missing from the pool.

**Ledger.** State lives in `$XDG_STATE_HOME/berth/ledger/` (default `~/.local/state/berth`) as immutable generation files `g-<n>.json`. The highest `n` is current. A write goes to a synced temp file and commits with `link(temp, g-<n+1>)`, which fails if another writer won. The loser re-reads and re-runs its transition. There is no lock to go stale. A transition that returns an equal state writes nothing, so a repeat `acquire` is one directory read and one file read. The last 10 generations stay on disk.

**Transitions are pure.** `domain.ts` holds `reconcile`, `release`, `sweep`, `mergePool`, `pickPort` and `pickStore`. The shell gathers facts first (which checkouts exist, bind probes, the clock), so a retried transition repeats no network call. The Shopify CLI runs only between ledger writes.

**Ports.** `pickPort` takes the lowest port in the range that no lease holds, is not reserved, and binds on 127.0.0.1, ::1, 0.0.0.0 and ::. An unleased busy port belongs to an unknown program and is skipped.

**Stores.** Pools come from `shopify store list --type dev --json`, which prints `{ stores: [{ store, name, ... }] }`. Each pool's pattern matches the handle, the `store` domain without `.myshopify.com`, never the display `name`. The patterns are also what keep the staging and production stores out, since Shopify lists them as type dev too. berth runs it only when no store in the env's pool is free, then retries once. berth never creates or deletes a store, because store domains are global and permanent. `pickStore` prefers the store this key held last, then the lowest free one.

**Stale sweep.** Each `acquire` and `release` first ends this machine's leases whose checkout directory is gone. A swept store is freed without a clean, with a warning, because its config left with the checkout. The next `shopify app dev` on that store replaces the preview.

**Machines.** `machine` is in the lease key. The sweep only judges this machine's leases. A shared store pool later is another implementation of the ledger's `modify`, such as a row with a version column.

**Not done.** No time-based expiry, no store creation, no daemon, no env injection or exec wrapper, no `.env` writing.

## Consumers

Consumers are separate repos. They run `berth` and decode the JSON with their own small schema naming only the fields they read. `berth` reaches PATH through a shim, `~/.local/bin/berth`, that runs `vpx ~/projects/tools/berth.ts`.

- A Shopify app's `serve.ts` calls `berth acquire <env> --bindable` and passes `store.domain` to `--store`, `ports.graphiql` to `--graphiql-port`, and `ports.web` as `BACKEND_PORT` and `WEBSITE_PORT`.
- `worktree:init` calls `berth acquire` for each env, so a full pool fails at init with the create command. Worktree removal calls `berth release` before `git worktree remove`.
- Playwright and Vite configs call `berth acquire <env>` without `--bindable`, because their own server may hold the port.

CLI 5.0 refuses a second `shopify app dev` in one directory with the same config basename. A checkout that runs dev and e2e at once needs a second config file for e2e, which `store.config` names.

## Design record

Two candidates were sketched in parallel. Both chose a committed manifest and the same three commands. The base is candidate 1, a lock-free generation ledger with pure transitions. One compare-and-swap serializes a whole-state change, so a multi-port grant is atomic and the rules test against an in-memory ledger.

Grafted from candidate 2:

- per-env store pools and config in the manifest;
- `--adopt` for migration;
- release cleans first and keeps the lease on failure.

That replaces candidate 1's outbox of owed cleans, which needed a rule that a store with an owed clean is never granted back to its project.

Rejected:

- Candidate 2's claim files under a TCP-socket lock. Its lock port can be taken by any program, and a crash mid-grant leaves partial claims.
- Candidate 1's store pick from `.shopify/dev`. `--adopt` migrates explicitly and fails loudly on the existing collision.
- One `leases.json` behind a pid lock. Stealing a dead lock races.
- Flags instead of a manifest. Every call site would repeat the role list.

No cross-model judge ran. The configured judge pool has only the parent model, which never judges.
