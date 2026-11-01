# Stores and worktrees backlog

Decisions and open work for moving baton, bang and motio to one store pool and per-task worktrees. Started 2026-11-01. Update an item's status in place; move it to **Done** with the commit or date when it lands.

## Decided

- **Store plan: `basic`.** Every store in the pool is a dev store on Shopify's Basic plan. Grow adds nothing these apps use; Advanced (200 points/s) and Plus (1000 points/s) only raise rate limits, which would hide the throttling real merchants on Basic and Grow hit. A store needing a Plus-only feature (checkout UI extensions, custom-app Functions) is a separate named store, outside the pool. Source: `shopify-docs/dev/docs/apps/build/apis/graphql-admin/rate-limits.md`; measured on `mw10013-dev-shop-00`: bucket 2000, restore 100/s.
- **One pool, no dev/e2e split.** berth leases any pool store to any checkout and environment.
- **Pool store names: `mw10013-pool-NN`**, two digits from `00`. A name states only what is permanent: the owner prefix (Shopify store names share one global namespace) and that the store is pooled. `dev` is left out because every store is a Shopify development store and it would read as the dev environment; the plan is left out because every pool store is `basic`. The rule for readers: a `pool` store is interchangeable and leased by berth, so no code or config names one; every other store is named for its one permanent purpose.
- **A pool store arrives in an unknown state; each app makes it ready.** Shopify has no store reset (deleting it is the only one, and whether its name can be reused is unknown), so a "pristine" store is not on offer. berth guarantees one holder at a time and nothing about contents. We live within the pool and Shopify's limits: stores are neither created nor deleted casually. Each app declares, per environment, an idempotent prepare step that converges whatever is on the store to what that environment needs, and its tests own their data instead of assuming an empty store. A need that only a never-used store can meet (an empty-store onboarding test, say) is a separate named store, outside the pool.
- **Work reaches main through PRs, squash merged** (2026-11-01). An agent pushes its task branch and opens the PR; it merges only when the owner says so, with `gh pr merge <n> --squash` after rebasing on main and rerunning the checks. No CI for now: the agent runs the checks locally and reports them in the PR. Baton's GitHub settings (set 2026-11-01): delete branch on merge on; squash commit title and body from the PR title and body. Pushed branches build nothing: staging's only Workers Builds trigger includes `main` alone (measured), and production's watches `production` with previews off. `wt rm` asks GitHub whether the branch's PR merged, since a squash leaves the branch's commits off main. bang, motio and tools settings: not yet changed.
- **Fixed stores keep their names:** `mw10013-staging-shop-00` and `mw10013-production-shop-00`. Never in the pool.
- **First plan acceptance is not automated.** Every pool store holds a plan before use. To test a first acceptance by hand, uninstall and reinstall the app on a store. Cancelling is not used: a cancelled plan stays active until its period or trial ends.
- **Plan display names.** Baton Dev's cards read "Basic"/"Pro" (legacy plans, legacy numbers); Baton Staging's "Baton Basic"/"Baton Pro" (measured 2026-11-01). Code reads handles only. `baton/docs/billing-runbook.md` corrected (not yet committed).

## Proposed, awaiting the owner

- **Pool size:** 20 to start.
- **Worktree names are free-form; nothing derives from them.** A worktree is named for its task at creation, directory and branch alike, kebab case, 40 characters at most (T3 hashes longer directory names). Code never parses the name: ports and stores come from berth (keyed by path), and stage names drop the checkout segment, so every checkout of a repo uses `dev-<user>`, `e2e-<user>`, `test-<user>`. Measured 2026-11-01 in a scratch worktree with `stageOf` patched: its `alchemy dev --stage dev-mw` ran beside Baton main's (and bang's and motio's, which already share `dev-mw` daily), main's embedded app hydrated, and stopping the scratch left main running; two `vp test --project integ` runs at once on `test-mw` passed 161/161 each. Not run: two e2e servers on `e2e-mw` (same `alchemy dev` path, inferred safe).
- **A worktree tool in this repo, used by agents, not a per-project T3 setting.** Working name `wt`. `wt new <repo> <name words>`: the agent's words are the name (`pr 123 plan labels` gives `pr-123-plan-labels`); `wt` only normalizes them to kebab case, caps the length and adds `-2` when the branch or folder exists (`--exact` fails instead), runs `git worktree add` at `~/.t3/worktrees/<repo>/<name>` from `main`, runs the repo's `worktree:init` script, then prints the path; `--thread "<prompt>"` also starts a T3 thread there. `wt rm` refuses uncommitted or unmerged work, runs the repo's `worktree:teardown` script (stop servers), `berth release`, removes the worktree and deletes the branch. `wt list`. One global agent rule ("make and remove worktrees only with `wt`") replaces per-project instructions and `t3.json`. Names need to be unique only per repo: git requires unique branches, and berth keys by path. Measured 2026-11-01: `t3 thread start <worktree path>` refuses a worktree path ("No T3 Code project matches"), while the MCP `t3_thread_launch` with `workspaceStrategy {type: existing_worktree, worktreePath}` binds a thread to a worktree T3 did not create, even on a detached HEAD. So `wt` creates the worktree, and an agent with T3 tools binds a thread to it; `--thread` is dropped unless the CLI gains that option.
- **Worktree support is layered, and every layer above git is opt-in per repo.** `wt` knows only git: names, create, remove, refusing unmerged work. A repo opts into more by having it: a `worktree:init` and a `worktree:teardown` package script (`wt` runs them when present, skips them when absent), and a `berth.json` for ports (any project) and stores (Shopify apps only). A local-only project like xnotes or ableton-m4l-prelive needs at most a berth.json for its dev port and an init script that runs `vp install`; a repo with neither still gets plain worktrees. Shopify, Cloudflare and Alchemy live only in the repos that use them, never in `wt`.
- **`vp run app:open`** opens this checkout's app in the default browser: the dev lease's store and the app handle, beside the existing `app:open:staging` and `app:open:production`. `vp run browser open` stays the agent Chrome's.

## Open

2. berth's printed create command (`src/berth/domain.ts:396`) lacks `--plan basic`. The CLI requires `--plan` when it cannot prompt, and prompts a person to pick any plan.
3. Check that e2e specs tolerate a store that held dev fixture data (e2e stores never had the fixture). Blocks the single pool.
4. A provision-store command, run once per new store: Shopify CLI store auth, agent Chrome login, the app's plan for each of baton, bang and motio. Add new stores to bang's "Stores with plan access" list for its private `-test` plans (Partner Dashboard).
5. Create the pool stores. A taken name gets a suffix silently, so check each resulting domain.
6. Code and docs for the new pool: berth pool regexes (`docs/berth.md`), `StoreName` in each repo's `scripts/lib/worktree.ts`, Baton's fixture guard (`mw10013-dev-shop-NN` only), `scripts/lib/stores.ts` in each repo, the runbooks, AGENTS.md files.
7. Move every checkout to the new pool; retire the old `dev-shop`/`e2e-shop` pools from berth. Never delete stores.
8. Worktrees, in order:
   1. Done: `wt` (`1c9d21a`; fixes `3e61aa8` name lookup from main, berth `a138a78` release without an e2e config); the coder skill's git workflow and Shopify worktree playbook (agent-skills `a63e6d8`, `4190369`).
   2. Done: Baton PR 1, squash merged as `893b787`, its worktree removed with `wt rm`.
   3. Done: bang PR 1 (`5de20bc`) and motio PR 1 (`fe98e28`), squash merged, worktrees removed, stores released.
   4. xnotes PR https://github.com/mw10013/xnotes/pull/1 (deletes the parallel-agents runbook) and notes PR https://github.com/mw10013/notes/pull/1 (drops main-only rules): awaiting the owner's merge.
   5. Retire `wt-01`..`wt-04` (Baton) and motio's `wt-01` as their work lands; no rename. After pulling the stage change, their local dev data starts empty.
   6. motio: one `vp test` failure not root-caused (2026-11-01): the first run in a fresh worktree failed `test/integ/ping.test.ts` with `SchemaError: Missing key at ["backend"]`, likely Alchemy's worker-proxy 502 JSON before workerd answered; 7 reruns passed, including two from an empty `.alchemy/`. State kept at `/tmp/motio-alchemy-bak-1`.
9. berth's sweep frees a deleted checkout's stores without `shopify app dev clean` and without checking for a live `app dev` on them.
10. Each app's prepare step per environment, written down and run by its start command. Baton: dev runs the fixture (today by hand), e2e needs none (specs tag and cancel their own orders, the e2e stage is rebuilt each run). bang and motio: not yet surveyed.
11. Concurrent test runs across checkouts need a worker cap. Two full `vp test` runs at once on this 12-core machine timed out (22 and 6 failures; integ alone 66 s, two at once 177 s), whatever their stage names; with `--maxWorkers=3` each, both passed. Measured 2026-11-01. With many agents in many worktrees, the default worker count oversubscribes the CPU.
12. ableton-m4l-prelive hardcodes port 4500 (`scripts/lib/server.ts`), inside berth's range 4100-4999, which stays free for berth. The port stays hardcoded (ableton-m4l-liveql depends on it), so move it to a fixed port outside the range, in both projects. Not reserving it in berth meanwhile, by the owner's call: until it moves, a berth lease can take 4500 while prelive is stopped.
13. Stray stores in the org: `dev-shop-00`, `e2e-shop-00` (basic), `sandbox-shop-00/01/02`, `stress-shop-01` (advanced, used by bang). Leave unless the owner decides otherwise.

## Unverified

- Whether a Dev Dashboard dev store's plan can change after creation (Shopify's docs are silent; treat as permanent).
- Advanced and Plus bucket sizes on dev stores.
- Store name length and character rules; whether a deleted name can be reused.

## Done

- 2026-11-01: Baton wt-02 moved onto berth (`dev-shop-02`, `e2e-shop-02`).
- 2026-11-01: GitHub settings for baton, bang, motio, tools, agent-skills, xnotes and notes: delete branch on merge, squash commit title and body from the PR.
- 2026-11-01: Baton billing runbook committed and pushed (`9cbec56`).
