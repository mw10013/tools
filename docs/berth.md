# berth

berth leases Shopify dev stores, so many Shopify apps and checkouts run side by side on one machine without two of them sharing a store. The stores come from `stores.json` at the root of this repository, which `berth pool ensure` writes. A lease belongs to one checkout and one environment, and it lasts until the checkout releases it or its directory disappears. berth leases no ports: each dev server runs under `rigging server` and picks its own.

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
berth pool ensure [<count>]                    # check stores.json against Shopify; grow the pool to <count>
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

`stores.json` is written by `berth pool ensure` only. Nobody edits it by hand.

```json
{
  "organization": "130059740",
  "prefix": "mw10013-pool-",
  "stores": ["mw10013-pool-00", "mw10013-pool-01"]
}
```

`organization` is the numeric id of the Shopify organization that owns the stores. Pool store names are `prefix` and two digits, `00` to `99`, because `StoreName` in `@mw10013/shopify-app-workers/dev/worktree` allows only two. `stores` lists handles, and berth turns each into the domain `<handle>.myshopify.com`. A file that lists a store twice fails to decode with `SettingsInvalidError`, which names the store, in every command. Every listed store was checked by `pool ensure` to exist in the organization as a dev store on the basic plan. berth reads the file from beside its own source at startup. `acquire`, `show`, `release` and `list` read only `stores` and make no Shopify call.

### pool ensure

`berth pool ensure [<count>]` makes sure the pool holds at least `<count>` stores. It runs from any directory and needs no `berth.json`. It is the only command that calls the Shopify CLI.

1. It lists every store in the organization once, with `shopify store list --json --no-input --organization-id <organization>`. It passes no `--type`, because `--type dev` hides a listed store of another type, which would then look missing, and a non-dev store that holds a pool name. Measured on 2026-11-05, `--type dev` on organization `130059740` omits `product-health-check.myshopify.com`, a `client-transfer` store.
2. It checks every listed store by its domain. A store that is missing, not type `dev`, or not plan `basic` fails the run with `PoolStoresUnfitError`, which names each one. berth never repairs or deletes a store.
3. It adopts every unlisted org store at a pool domain, `<prefix>NN.myshopify.com`, that is a dev store on basic. A run that crashed after a create leaves such a store.
4. While the pool is smaller than `<count>`, it creates one store at a time with `shopify store create dev --name <prefix>NN --plan basic --organization-id <organization> --json --no-input`. It takes the lowest `NN` that no listed store and no org store uses, by name or domain. A create can take minutes, and the CLI's progress shows on stderr.
5. After each create, it writes `stores.json` through a temp file and a rename. The store exists before the file lists it, so `acquire` never leases a store that does not exist. A run that fails keeps every store it created. A file that already holds the result is not written.
6. Each write, the adoptions' included, re-reads `stores.json` and writes the stores on disk, in their order, then this run's stores the disk lacks. A store that a concurrent run wrote meanwhile stays listed. A file whose `organization` or `prefix` changed meanwhile fails the run with `PoolFileChangedError`. The reported `stores` count is the file as last written.

A store Shopify creates at any other domain fails the run with `StoreDomainTakenError`, which names the domain, and stays out of the list. A `<count>` that would need a name past `99` fails with `PoolNamesExhaustedError` before anything is created. With `<count>` at or below the pool's size, or with none, `pool ensure` only checks and adopts: the pool only grows.

Human lines go to stderr: `ok`, `adopted` or `created` with each store's handle, and, when the file changed, a last line saying to commit `stores.json` in `~/projects/tools`. stdout gets one JSON object.

```json
{
  "berth": 1,
  "pool": {
    "organization": "130059740",
    "stores": 16,
    "adopted": [],
    "created": ["mw10013-pool-14", "mw10013-pool-15"]
  }
}
```

A typed failure prints `{ "berth": 1, "error": { "_tag": "...", "message": "..." } }` and exits 1, as the lease commands do. A Shopify CLI command fails with `ShopifyCliError` when it cannot start (`shopify is not on PATH`), exits non-zero, or prints output berth cannot read. A create that exits non-zero may still have made the store: Shopify CLI 5.0.0's status poll fails with "Unable to determine store creation status" while Shopify goes on to make it, and the org's list shows a new store some seconds later. So after a failed create, berth lists the org's stores every 2 seconds for up to 2 minutes, and a store by the requested name counts as created, at whatever domain it got. Only a store that never appears fails the run. Without that wait, a rerun that did not yet see the store made a second one at a suffixed domain (measured 2026-11-06). A create whose output berth cannot read may still have made the store, and the message says so: if the store landed at its pool domain, the next `berth pool ensure` adopts it. A store list that Shopify truncated, past 250 stores, fails with `StoreListTruncatedError`, because a store missing from it may still exist.

### Add a store outside the pool

A store that is not a pool store, such as one that needs `plus`, is created by hand and never listed in `stores.json`.

```sh
shopify store create dev --name mw10013-<purpose>-shop-NN --plan <plan> --organization-id 130059740
```

- Decide the plan first. A store's plan cannot change after creation.
- Check that the returned domain is exactly the name plus `.myshopify.com`. A taken name does not fail. The store gets a suffixed domain.
- Never delete a store you mean to keep. Its name does not come back.

Machine policy is `~/.config/berth/config.json`, and its one field is optional. `machine` defaults to the host name without `.local`.

```json
{ "machine": "mw-mbp" }
```

## Design

**State.** The one stored value is `State = { leases }`. A `Lease` is `{ key: { machine, checkout, env }, project, store: { domain, config }, acquiredAt }`. A store's holder and stale leases are derived, never stored. The pool is `stores.json`, not the ledger. `checkState` runs on every read and write and rejects a store or key held twice. Older generations decode: `pool` and `poolSyncedAt` from before the pool moved out, a store's `pool`, and a lease's `ports` are dropped. The next write commits the result, even one whose transition changes nothing.

**Ledger.** State lives in `$XDG_STATE_HOME/berth/ledger/` (default `~/.local/state/berth`) as immutable generation files `g-<n>.json`. The highest `n` is current. A write goes to a synced temp file and commits with `link(temp, g-<n+1>)`, which fails if another writer won. The loser re-reads and re-runs its transition. There is no lock to go stale. A transition whose output encodes to the current file's text writes nothing, so a repeat `acquire` is one directory read and one file read. The last 10 generations stay on disk.

**Transitions are pure.** `domain.ts` holds `reconcile`, `release`, `sweep` and `pickStore`. The shell gathers facts first (which checkouts exist, the clock), so a retried transition does no I/O beyond them.

**No ports.** berth leased ports until 2026-11-03. Every app's dev server now runs under `rigging server`, binds a port it picks, and publishes it, so berth dropped `ports`, `--bindable`, `PortBusyError`, `PortsExhaustedError`, the port range, and the reserved ports.

**Stores.** `pickStore` takes the first store in `stores.json` that no lease holds. Any env of any project may lease any listed store. `pool ensure` creates stores but never deletes one, because store domains are global and permanent. `stores.json` lists only stores that `pool ensure` checked exist as dev stores on basic, so it writes a created store only after Shopify returns its exact domain. The decisions are pure: `planPool` in `pool.ts` takes the listed stores, the org's stores, the prefix and the count, and returns the adoptions and the names to create, or the typed failure. The shell runs the CLI and writes the file. A store is known by its domain, which Shopify never changes after creation ([Development stores](https://shopify.dev/docs/apps/build/stores/development-stores)), not by its name, which can differ from it: the org's `stress-shop-01.myshopify.com` is named `Stress Shop 01`.

**No dev preview clean.** berth used to run `shopify app dev clean` whenever a store left a checkout. It no longer does. On 2026-11-03 a motio worktree ran its e2e suite on `mw10013-pool-07` and was removed with no clean. A second worktree then leased the same store, started its e2e server and passed all 21 tests, because its `shopify app dev` installed its own dev preview over the old one.

**Stale sweep.** Each `acquire` and `release` first ends this machine's leases whose checkout directory is gone.

**Machines.** `machine` is in the lease key. The sweep only judges this machine's leases. A shared store pool later is another implementation of the ledger's `modify`, such as a row with a version column.

**Not done.** No time-based expiry, no store deletion or repair, no daemon, no env injection or exec wrapper, no `.env` writing.

## Consumers

Consumers are separate repos. They run `berth` and decode the JSON with their own small schema naming only the fields they read. `berth` reaches PATH through a shim, `~/.local/bin/berth`, that runs `vpx ~/projects/tools/berth.ts`.

- A Shopify app's dev server calls `berth acquire <env>` (`@mw10013/shopify-app-workers/dev/berth`) and passes the store's handle to `--store` and `store.config` to `--config`.
- A new worktree takes no lease: its first `acquire` comes from `vp run dev` or e2e. `wt rm` runs `berth release` in every folder of the worktree with a `berth.json`, after `rigging server stop` for each of that worktree's servers, and before `git worktree remove`. With no lease held, `release` succeeds and releases nothing. A worktree removed some other way loses its leases at the next `acquire` or `release` on the machine (**Stale sweep**).
- A command that stops a server calls `berth show <env>`, not `acquire`: no lease means nothing of this checkout's runs on one, and a checkout is not handed a lease on its way out.
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
