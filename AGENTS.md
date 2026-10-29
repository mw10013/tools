# Working agreements

Use the coder skill for coding and development-tool conventions.

## Project

CLI tools and automation using TypeScript, Effect, and Vite+.
Each tool has an independent entry point under `src/<tool>/cli.ts` and a
corresponding package script. Do not introduce a universal command wrapper.

## Commands

- Install dependencies: `vp install`.
- Run a tool: `vp run <tool> [arguments]`.
- Run TypeScript directly: `vpx path/to/file.ts [arguments]`.
- After edits: `vp check --fix`, then exercise the affected CLI.

## Implementation

- Use Effect CLI for argument parsing, help, and version output.
- Import Effect modules as namespaces from their individual module paths.
- Validate untrusted input at boundaries with Schema.
- Use package imports for local imports crossing directory boundaries.
- Keep downloaded content and generated artifacts out of Git.
- Reference-management operations must preserve local checkout changes.
- Add tests for meaningful behavior as tools gain functionality.
