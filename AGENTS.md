Use coder skill.

## Project

CLI tools and automation using TypeScript, Effect, and Vite+.

## Git

Overrides to the coder skill's git workflow:

- Agents merge their own PRs once `vp check` and `vp test run` pass; no owner approval needed.
- `stores.json` changes written by `berth pool ensure` are committed straight to `main` in `~/projects/tools`: berth writes the file in the checkout its shim runs, and it records stores Shopify already created.
