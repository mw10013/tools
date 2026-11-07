#!/usr/bin/env vpx
import { runCli } from "../core/cli.mjs";
import { command } from "../cloudflare/deployed-stage.mjs";
// bin/stage.ts
/**
* `devkit-stage up|check|reset <stage>`: an app's script is `"stage": "devkit-stage"`.
*
* The shebang is `vpx`, not `node`: the command imports the app's `stacks/stage-env.ts`, whose
* imports (`#backend/…`) can reach syntax Node's built-in type stripping refuses.
*
* @module
*/
runCli(command);
export {};
