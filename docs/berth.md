# berth

berth leases Shopify dev stores, so many Shopify apps and checkouts run side by side on one machine without two of them sharing a store. The stores come from a fixed list, `stores.json` at the root of this repository. A lease belongs to one checkout and one environment, and it lasts until the checkout releases it or its directory disappears. berth leases no ports: each dev server runs under bosun and picks its own.

## Usage

A project commits `berth.json` at its root. It declares what each environment needs and holds no values.

```json
{
  "project": "baton",
  "envs": {
    "dev": { "store": { "config": "shopify.app.toml" } },
    "e2e": { "store": { "config": "shopify.app.e2e.toml" } }
  }
}
```

`store.config` is the app config file the env's `shopify app dev` runs with. Every env needs `store`: an env without one fails to decode with `SettingsInvalidError`. A `store.pool` field, which older manifests carry, is accepted and ignored, and so is an env's `ports`.

berth walks up from the working directory to the nearest `berth.json`. That directory, with symlinks resolved, is the checkout.

```sh
berth acquire <env> [--adopt store=<handle>]   # ensure and print this checkout's lease
berth show <env>                               # print this checkout's lease, or null; never creates one
berth release [<env>]                          # free this checkout's leases
berth list [--json]                            # who holds which stores, across all projects
```

- `acquire` is idempotent. The same checkout and env always get the same store. When the env's `store.config` changes, `acquire` updates the lease's config and keeps the store. It drops a held store that `stores.json` no longer lists and grants a listed one.
- `--adopt store=mw10013-pool-01` takes an exact store once, for migration. It fails with `AdoptRefusedError` if another lease holds the store, or if `stores.json` does not list it.
- `show` reads the ledger only. It prints `{ "berth": 1, "lease": <the lease as acquire prints it> }`, with `lease` null when the checkout holds none for the env.
- `release` refuses with `LeaseInUseError` while this checkout's `shopify app dev` runs on a leased store, read from `.shopify/dev/app-dev-*.json`. It leaves the store's dev preview in place. The next holder's `shopify app dev` installs its own preview over it.

`acquire` prints only this on stdout. Human lines go to stderr.

```json
{
  "berth": 1,
  "project": "baton",
  "checkout": "/Users/mw/.t3/worktrees/baton/wt-02",
  "env": "dev",
  "machine": "mw-mbp",
  "store": {
    "domain": "mw10013-pool-07.myshopify.com",
    "config": "shopify.app.toml"
  },
  "acquiredAt": "2026-11-01T09:12:44.120Z"
}
```

A typed failure exits 1 and prints `{ "berth": 1, "error": { "_tag": "...", "message": "..." } }`. When every listed store is leased, `acquire` fails with `StorePoolExhaustedError`, whose `stores` field is the list's length: "all 14 stores in stores.json are leased". A usage error exits 2. Version 1 only grows: fields are added, never renamed. The one removal is `ports`, dropped with port leasing on 2026-11-03, when no consumer read it.

`stores.json` is a JSON array of store handles, `["mw10013-pool-00", …]`. berth turns each into the domain `<handle>.myshopify.com` and reads the file from beside its own source at startup. To grow the pool, create the store in Shopify and add its handle to the list. berth makes no Shopify call that lists or creates stores.

Machine policy is `~/.config/berth/config.json`, and its one field is optional. `machine` defaults to the host name without `.local`.

```json
{ "machine": "mw-mbp" }
```

## Design

**State.** The one stored value is `State = { leases }`. A `Lease` is `{ key: { machine, checkout, env }, project, store: { domain, config }, acquiredAt }`. A store's holder and stale leases are derived, never stored. The pool is `stores.json`, not the ledger. `checkState` runs on every read and write and rejects a store or key held twice. Older generations decode: `pool` and `poolSyncedAt` from before the pool moved out, a store's `pool`, and a lease's `ports` are dropped, and a lease with no store, from when berth leased ports, is dropped whole. The next write commits the result, even one whose transition changes nothing.

**Ledger.** State lives in `$XDG_STATE_HOME/berth/ledger/` (default `~/.local/state/berth`) as immutable generation files `g-<n>.json`. The highest `n` is current. A write goes to a synced temp file and commits with `link(temp, g-<n+1>)`, which fails if another writer won. The loser re-reads and re-runs its transition. There is no lock to go stale. A transition whose output encodes to the current file's text writes nothing, so a repeat `acquire` is one directory read and one file read. The last 10 generations stay on disk.

**Transitions are pure.** `domain.ts` holds `reconcile`, `release`, `sweep` and `pickStore`. The shell gathers facts first (which checkouts exist, the clock), so a retried transition does no I/O beyond them.

**No ports.** berth leased ports until 2026-11-03. Every app's dev server now runs under bosun, binds a port it picks, and publishes it, so berth dropped `ports`, `--bindable`, `PortBusyError`, `PortsExhaustedError`, the port range, and the reserved ports.

**Stores.** `pickStore` takes the first store in `stores.json` that no lease holds. Any env of any project may lease any listed store. berth never creates or deletes a store, because store domains are global and permanent.

**No dev preview clean.** berth used to run `shopify app dev clean` whenever a store left a checkout. It no longer does. On 2026-11-03 a motio worktree ran its e2e suite on `mw10013-pool-07` and was removed with no clean. A second worktree then leased the same store, started its e2e server and passed all 21 tests, because its `shopify app dev` installed its own dev preview over the old one.

**Stale sweep.** Each `acquire` and `release` first ends this machine's leases whose checkout directory is gone.

**Machines.** `machine` is in the lease key. The sweep only judges this machine's leases. A shared store pool later is another implementation of the ledger's `modify`, such as a row with a version column.

**Not done.** No time-based expiry, no store creation or deletion, no daemon, no env injection or exec wrapper, no `.env` writing.

## Consumers

Consumers are separate repos. They run `berth` and decode the JSON with their own small schema naming only the fields they read. `berth` reaches PATH through a shim, `~/.local/bin/berth`, that runs `vpx ~/projects/tools/berth.ts`.

- A Shopify app's dev server calls `berth acquire <env>` (devkit's `src/devkit/shopify/berth.ts`) and passes the store's handle to `--store` and `store.config` to `--config`.
- `worktree:init` calls `berth acquire` for each env, so a full pool fails at init with `StorePoolExhaustedError`. Worktree removal calls `berth release` before `git worktree remove`.
- A command that stops a server calls `berth show <env>`, not `acquire`: no lease means nothing of this checkout's runs on one, and a checkout whose `worktree:init` failed is not handed a lease on its way out.
- Playwright configs call `berth acquire <env>` for the store their tests run against.

CLI 5.0 refuses a second `shopify app dev` in one directory with the same config basename. A checkout that runs dev and e2e at once needs a second config file for e2e, which `store.config` names.

## Design record

Two candidates were sketched in parallel. Both chose a committed manifest and the same three commands. The base is candidate 1, a lock-free generation ledger with pure transitions. One compare-and-swap serializes a whole-state change, so a grant is atomic and the rules test against an in-memory ledger.

Grafted from candidate 2:

- per-env store config in the manifest;
- `--adopt` for migration.

Candidate 2 also cleaned a store's dev preview before release. **No dev preview clean** says why berth dropped it.

Rejected:

- Candidate 2's claim files under a TCP-socket lock. Its lock port can be taken by any program, and a crash mid-grant leaves partial claims.
- Candidate 1's store pick from `.shopify/dev`. `--adopt` migrates explicitly and fails loudly on the existing collision.
- One `leases.json` behind a pid lock. Stealing a dead lock races.
- Flags instead of a manifest. Every call site would repeat the env's app config.

No cross-model judge ran. The configured judge pool has only the parent model, which never judges.
