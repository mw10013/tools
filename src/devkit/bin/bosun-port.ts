#!/usr/bin/env vpx
/** `devkit-bosun-port`: `port=$(devkit-bosun-port)` in a script bosun starts. @module */
import { command } from "#devkit/core/bosun-port.ts";
import { runCli } from "#devkit/core/cli.ts";

runCli(command);
