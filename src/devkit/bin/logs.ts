#!/usr/bin/env vpx
/** `devkit-logs`: an app's script is `"logs": "devkit-logs"`. @module */
import { command } from "#devkit/cloudflare/logs.ts";
import { runCli } from "#devkit/core/cli.ts";

runCli(command);
