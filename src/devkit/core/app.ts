/**
 * The app devkit is vendored into. devkit sits three levels below the app's root, at
 * `vendor/devkit/<layer>/` (`src/devkit/<layer>/` in tools, where the app is tools).
 *
 * @module
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import * as Schema from "effect/Schema";

export const ROOT = path.resolve(import.meta.dirname, "../../..");

/** `package.json`'s `name`: the app's Alchemy stack and the prefix of its deployed Workers. */
export const APP_NAME = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
)(readFileSync(path.join(ROOT, "package.json"), "utf8")).name;
