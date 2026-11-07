#!/usr/bin/env vpx
/**
 * `devkit-stage up|check|reset <stage>`: an app's script is `"stage": "devkit-stage"`.
 *
 * The shebang is `vpx`, not `node`: the command imports the app's `stacks/stage-env.ts`, whose
 * imports (`#backend/…`) can reach syntax Node's built-in type stripping refuses.
 *
 * @module
 */
import { command } from "#devkit/cloudflare/deployed-stage.ts";
import { runCli } from "#devkit/core/cli.ts";

runCli(command);
