/**
 * `vp run tts`: Workers AI text to speech from the shell. `gen` speaks one line into an MP3 under
 * `tmp/tts/` ({@link synthesize}); `play` plays a recording through `mpv`. Credentials come from
 * the shell's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, not `.env`. Every `gen` is a
 * metered request: `--dry-run` previews it with no credentials, files or request.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";

import {
  countCharacters,
  estimate,
  latestRecording,
  MODEL_NAMES,
  MODELS,
  recordingOutput,
  SpeechError,
  SpeechText,
  speechAccount,
  speechToken,
  synthesize,
  VOICES,
} from "./speech.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RECORDINGS = resolve(REPO_ROOT, "tmp/tts");

const toUserError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const voiceHelp = MODEL_NAMES.map(
  (name) => `${name}: ${MODELS[name].voices.join(", ")}`,
).join("; ");

const gen = Command.make(
  "gen",
  {
    model: Flag.Literals("model", MODEL_NAMES).pipe(
      Flag.withDescription("Speech model: aura-1 or aura-2 (English, default)"),
      Flag.withDefault("aura-2" as const),
    ),
    voice: Flag.Literals("voice", VOICES).pipe(
      Flag.withDescription(`Female voice (default: luna). ${voiceHelp}`),
      Flag.withDefault("luna"),
    ),
    text: Argument.String("text").pipe(
      Argument.withDescription(
        "Text to speak, 1–500 Unicode code points, quoted as one argument",
      ),
    ),
    output: Flag.String("output").pipe(
      Flag.withDescription(
        "MP3 path, absolute or relative to the repo root; defaults to tmp/tts/<YYYYMMDD>-<NN>-<excerpt>/<excerpt>.mp3; never overwrites",
      ),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription(
        "Preview without loading credentials, writing files, or making requests",
      ),
      Flag.withDefault(false),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const model = MODELS[options.model];
      if (!(model.voices as readonly string[]).includes(options.voice))
        return yield* new SpeechError({
          message: `--voice ${options.voice} is not supported with --model ${options.model}. Choose: ${model.voices.join(", ")}.`,
        });
      yield* Schema.decodeUnknownEffect(SpeechText)(options.text).pipe(
        Effect.mapError((error) => new SpeechError({ message: error.message })),
      );
      const output = (reserve: boolean) =>
        Effect.tryPromise({
          try: () =>
            options.output._tag === "Some"
              ? Promise.resolve(resolve(REPO_ROOT, options.output.value))
              : recordingOutput(RECORDINGS, options.text, reserve),
          catch: () =>
            new SpeechError({
              message: "Cannot choose or reserve the output folder.",
            }),
        });
      const preview = yield* output(false);
      if (!preview.endsWith(".mp3"))
        return yield* new SpeechError({
          message: "--output must end in .mp3.",
        });
      const characters = countCharacters(options.text);
      if (options.dryRun) {
        yield* Console.log(
          JSON.stringify(
            {
              dryRun: true,
              model: model.id,
              speaker: options.voice,
              text: options.text,
              characters,
              output: preview,
              ...estimate(options.model, characters),
            },
            null,
            2,
          ),
        );
        return;
      }
      const token = yield* speechToken;
      const account = yield* speechAccount;
      const result = yield* synthesize({
        account,
        token,
        model: options.model,
        speaker: options.voice,
        text: options.text,
        output: yield* output(true),
      });
      yield* Console.log(JSON.stringify(result, null, 2));
      if (!result.metadataSaved)
        yield* Console.warn(
          "Audio was saved, but its metadata sidecar could not be written.",
        );
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Speak one line into an MP3. Defaults to aura-2 and luna. Example: vp run tts gen 'Hello from Tools!' --voice athena. One request, no retries.",
  ),
);

const play = Command.make(
  "play",
  {
    path: Argument.String("path").pipe(
      Argument.withDescription(
        "MP3 path, or today's-or-latest daily number; defaults to the latest recording in tmp/tts",
      ),
      Argument.optional,
    ),
    device: Flag.String("device").pipe(
      Flag.withDescription(
        "mpv output device; defaults to Speakers + BlackHole; auto for system output, mpv --audio-device=help to list",
      ),
      Flag.withDefault("coreaudio/~:AMS2_StackedOutput:0"),
    ),
  },
  ({ path, device }) =>
    Effect.gen(function* () {
      const given = path._tag === "Some" ? path.value : undefined;
      const sequence =
        given !== undefined && /^\d+$/u.test(given) ? Number(given) : undefined;
      const file = yield* Effect.tryPromise({
        try: () =>
          given !== undefined && sequence === undefined
            ? Promise.resolve(resolve(REPO_ROOT, given))
            : latestRecording(RECORDINGS, sequence),
        catch: () =>
          new SpeechError({
            message:
              sequence === undefined
                ? "No recording found, or tmp/tts could not be read."
                : `No recording numbered ${String(sequence)} found, or tmp/tts could not be read.`,
          }),
      });
      if (!file.endsWith(".mp3"))
        return yield* new SpeechError({
          message: "Playback path must end in .mp3.",
        });
      yield* Console.log(`Playing ${file} on ${device}`);
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((done, fail) => {
            const child = spawn(
              "mpv",
              ["--no-config", "--no-video", `--audio-device=${device}`, file],
              {
                stdio: "inherit",
              },
            );
            child.once("error", fail);
            child.once("exit", (code) => {
              if (code === 0) done();
              else fail(new Error("Playback failed"));
            });
          }),
        catch: () =>
          new SpeechError({
            message:
              "Playback failed. Check the path and the output device; mpv must be installed (brew install mpv).",
          }),
      });
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Play the latest recording, a daily number, or an MP3 path with mpv",
  ),
);

export const command = Command.make("tts").pipe(
  Command.withDescription("Workers AI text to speech"),
  Command.withSubcommands([gen, play]),
);
