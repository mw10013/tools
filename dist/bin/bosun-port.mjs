#!/usr/bin/env vpx
import { command } from "../core/bosun-port.mjs";
import { runCli } from "../core/cli.mjs";
// bin/bosun-port.ts
/** `devkit-bosun-port`: `port=$(devkit-bosun-port)` in a script bosun starts. @module */
runCli(command);
export {};
