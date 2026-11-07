#!/usr/bin/env vpx
import { runCli } from "../core/cli.mjs";
import { command } from "../cloudflare/logs.mjs";
// bin/logs.ts
/** `devkit-logs`: an app's script is `"logs": "devkit-logs"`. @module */
runCli(command);
export {};
