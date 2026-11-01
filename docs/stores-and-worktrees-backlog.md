# Stores and worktrees backlog

Decisions and open work for moving baton, bang and motio to one store pool and per-task worktrees. Started 2026-11-01. Update an item's status in place; move it to **Done** with the commit or date when it lands.

## Decided

- **Store plan: `basic`.** Every store in the pool is a dev store on Shopify's Basic plan. Grow adds nothing these apps use; Advanced (200 points/s) and Plus (1000 points/s) only raise rate limits, which would hide the throttling real merchants on Basic and Grow hit. A store needing a Plus-only feature (checkout UI extensions, custom-app Functions) is a separate named store, outside the pool. Source: `shopify-docs/dev/docs/apps/build/apis/graphql-admin/rate-limits.md`; measured on `mw10013-dev-shop-00`: bucket 2000, restore 100/s.
- **One pool, no dev/e2e split.** berth leases any pool store to any checkout and environment.
- **Fixed stores keep their names:** `mw10013-staging-shop-00` and `mw10013-production-shop-00`. Never in the pool.
- **First plan acceptance is not automated.** Every pool store holds a plan before use. To test a first acceptance by hand, uninstall and reinstall the app on a store. Cancelling is not used: a cancelled plan stays active until its period or trial ends.
- **Plan display names.** Baton Dev's cards read "Basic"/"Pro" (legacy plans, legacy numbers); Baton Staging's "Baton Basic"/"Baton Pro" (measured 2026-11-01). Code reads handles only. `baton/docs/billing-runbook.md` corrected (not yet committed).

## Proposed, awaiting the owner

- **Pool store names: `mw10013-pool-NN`**, two digits from `00`. See the reasoning in the conversation of 2026-11-01; the rule for readers: a `pool` store is interchangeable and leased by berth, so no code or config names one; every other store is named for its one permanent purpose.
- **Pool size:** 20 to start.

## Open

1. Commit `baton/docs/billing-runbook.md` (plan display names). Needs the owner's go (Baton AGENTS.md).
2. berth's printed create command (`src/berth/domain.ts:396`) lacks `--plan basic`. The CLI requires `--plan` when it cannot prompt, and prompts a person to pick any plan.
3. Check that e2e specs tolerate a store that held dev fixture data (e2e stores never had the fixture). Blocks the single pool.
4. A provision-store command, run once per new store: Shopify CLI store auth, agent Chrome login, the app's plan for each of baton, bang and motio. Add new stores to bang's "Stores with plan access" list for its private `-test` plans (Partner Dashboard).
5. Create the pool stores. A taken name gets a suffix silently, so check each resulting domain.
6. Code and docs for the new pool: berth pool regexes (`docs/berth.md`), `StoreName` in each repo's `scripts/lib/worktree.ts`, Baton's fixture guard (`mw10013-dev-shop-NN` only), `scripts/lib/stores.ts` in each repo, the runbooks, AGENTS.md files.
7. Move every checkout to the new pool; retire the old `dev-shop`/`e2e-shop` pools from berth. Never delete stores.
8. Worktrees, in order:
   1. A teardown script: stop dev and e2e, `berth release`, `git worktree remove`, delete the branch.
   2. A setup script (`vp install`, `vp run worktree:init`) and a `t3.json` that runs it on worktree creation. Claude Code and OpenCode run the same command.
   3. Stage names from any branch. `src/backend/stage.ts` accepts only `wt-NN`; a free-form slug makes `test-<user>-<x>` ambiguous between a checkout stage and a test-file stage.
   4. AGENTS.md and runbook rules: any branch name, created in T3 with an explicit name.
   5. Copy to bang and motio.
9. berth's sweep frees a deleted checkout's stores without `shopify app dev clean` and without checking for a live `app dev` on them.
10. Stray stores in the org: `dev-shop-00`, `e2e-shop-00` (basic), `sandbox-shop-00/01/02`, `stress-shop-01` (advanced, used by bang). Leave unless the owner decides otherwise.

## Unverified

- Whether a Dev Dashboard dev store's plan can change after creation (Shopify's docs are silent; treat as permanent).
- Advanced and Plus bucket sizes on dev stores.
- Store name length and character rules; whether a deleted name can be reused.

## Done

- 2026-11-01: Baton wt-02 moved onto berth (`dev-shop-02`, `e2e-shop-02`).
