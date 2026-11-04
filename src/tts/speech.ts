/**
 * Workers AI text to speech: one Aura request per line, written as an MP3 that never replaces an
 * existing file. `vp run tts` calls {@link synthesize}.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * The supported models, by the name the CLI takes; `aura-2` means English. Voices are the
 * feminine English voices Cloudflare serves for each model, and help and validation read the
 * same lists. Estimates use the published per-character rates.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/aura-1/
 * @see https://developers.cloudflare.com/workers-ai/models/aura-2-en/
 * @see https://developers.deepgram.com/docs/tts-models
 * @see https://developers.cloudflare.com/workers-ai/platform/pricing/
 */
export const MODELS = {
  "aura-1": {
    id: "@cf/deepgram/aura-1",
    voices: ["asteria", "athena", "hera", "luna", "stella"],
    neuronsPerCharacter: 1.36364,
    usdPerCharacter: 0.000015,
  },
  "aura-2": {
    id: "@cf/deepgram/aura-2-en",
    voices: [
      "amalthea",
      "andromeda",
      "asteria",
      "athena",
      "aurora",
      "callista",
      "cora",
      "cordelia",
      "delia",
      "electra",
      "harmonia",
      "helena",
      "hera",
      "iris",
      "janus",
      "juno",
      "luna",
      "minerva",
      "ophelia",
      "pandora",
      "phoebe",
      "thalia",
      "theia",
      "vesta",
    ],
    neuronsPerCharacter: 2.72727,
    usdPerCharacter: 0.00003,
  },
} as const;

export type ModelName = keyof typeof MODELS;
export const MODEL_NAMES = Object.keys(MODELS) as readonly ModelName[];
export const VOICES: readonly string[] = [
  ...new Set(Object.values(MODELS).flatMap((model) => model.voices)),
];

/** Every request's ceiling: past it the request is abandoned, though it may still be charged. */
const DEADLINE_MS = 60_000;

/** Responses are read in chunks up to this size, never buffered whole first. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export class SpeechError extends Schema.TaggedError<SpeechError>()(
  "SpeechError",
  {
    message: Schema.String,
  },
) {}

/** Unicode code points, not UTF-16 units: what the length rule and the estimates count. */
export const countCharacters = (text: string): number =>
  // oxlint-disable-next-line typescript/no-misused-spread -- code points are the unit counted
  [...text].length;

/** One request's text: at least one non-whitespace character and at most 500 code points. */
export const SpeechText = Schema.String.check(
  Schema.makeFilter(
    (text: string) => /\S/u.test(text) || "text must contain non-whitespace",
  ),
  Schema.makeFilter(
    (text: string) =>
      countCharacters(text) <= 500 || "text must be at most 500 code points",
  ),
);

const AccountId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{32}$/iu, {
    message: "CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID",
  }),
);

/** The account whose Workers AI runs the request, from the shell's `CLOUDFLARE_ACCOUNT_ID`. */
export const speechAccount = Config.String("CLOUDFLARE_ACCOUNT_ID").pipe(
  Effect.mapError(
    () =>
      new SpeechError({
        message: "Set CLOUDFLARE_ACCOUNT_ID in the environment.",
      }),
  ),
  Effect.flatMap((value) =>
    Schema.decodeUnknownEffect(AccountId)(value).pipe(
      Effect.mapError((error) => new SpeechError({ message: error.message })),
    ),
  ),
);

/** The shell's Cloudflare token, `CLOUDFLARE_API_TOKEN`; never logged. */
export const speechToken = Config.Redacted("CLOUDFLARE_API_TOKEN").pipe(
  Effect.mapError(
    () =>
      new SpeechError({
        message: "Set CLOUDFLARE_API_TOKEN in the environment.",
      }),
  ),
  Effect.filterOrFail(
    (token) => /\S/u.test(Redacted.value(token)),
    () => new SpeechError({ message: "CLOUDFLARE_API_TOKEN is blank." }),
  ),
);

/** What a call costs at the published rate, for a preview or a summary line. */
export const estimate = (model: ModelName, characters: number) => ({
  estimatedNeurons:
    Math.round(characters * MODELS[model].neuronsPerCharacter * 100) / 100,
  estimatedUsd: characters * MODELS[model].usdPerCharacter,
});

/** Reads the body in chunks, failing once it passes {@link MAX_AUDIO_BYTES}. */
const readAudio = async (response: Response): Promise<Uint8Array> => {
  if (response.body === null)
    throw new SpeechError({
      message: "Cloudflare returned an empty audio body.",
    });
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_AUDIO_BYTES)
        throw new SpeechError({
          message: "Audio exceeds the local 10 MiB limit.",
        });
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => null);
    reader.releaseLock();
  }
  if (size === 0)
    throw new SpeechError({
      message: "Cloudflare returned an empty audio body.",
    });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const isCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/**
 * Speaks `text` into the MP3 at `output`, with a `.metadata.json` sidecar.
 *
 * Every request is metered, so: one request and never a retry; a timeout or transport failure says
 * it may have been charged; `output` is refused before the request if it exists, and published
 * by a hard link from a staging file, so a race never overwrites either. Failures carry fixed
 * messages, since a raw transport error can carry the token.
 */
export const synthesize = Effect.fn("Tts.synthesize")(function* (options: {
  readonly account: string;
  readonly token: Redacted.Redacted;
  readonly model: ModelName;
  readonly speaker: string;
  readonly text: string;
  readonly output: string;
}) {
  const { account, token, model, speaker, text, output } = options;
  if (!(MODELS[model].voices as readonly string[]).includes(speaker))
    return yield* new SpeechError({
      message: `voice ${speaker} is not supported with model ${model}. Choose: ${MODELS[model].voices.join(", ")}.`,
    });
  yield* Schema.decodeUnknownEffect(SpeechText)(text).pipe(
    Effect.mapError((error) => new SpeechError({ message: error.message })),
  );
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const staging = resolve(dirname(output), `.speech-${randomUUID()}.part`);
      let staged = false;
      try {
        try {
          await mkdir(dirname(output), { recursive: true });
          const exists = await lstat(output).then(
            () => true,
            (error: unknown) => {
              if (isCode(error, "ENOENT")) return false;
              throw error;
            },
          );
          if (exists)
            throw new SpeechError({
              message: `${output} already exists; choose another path.`,
            });
          await (await open(staging, "wx", 0o600)).close();
          staged = true;
        } catch (error) {
          if (error instanceof SpeechError) throw error;
          throw new SpeechError({
            message: "Cannot prepare the output directory and staging file.",
          });
        }

        const started = performance.now();
        const deadline = new AbortController();
        const timer = setTimeout(() => {
          deadline.abort();
        }, DEADLINE_MS);
        let bytes: Uint8Array;
        let ray: string | null;
        try {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODELS[model].id}`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.any([signal, deadline.signal]),
              headers: {
                Authorization: `Bearer ${Redacted.value(token)}`,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({ text, speaker, encoding: "mp3" }),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new SpeechError({
              message: `Cloudflare returned HTTP ${String(response.status)}. Check credentials, permissions, or service availability; no retry was sent.`,
            });
          }
          if (
            response.headers
              .get("content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase() !== "audio/mpeg"
          ) {
            await response.body?.cancel();
            throw new SpeechError({
              message:
                "Cloudflare did not return audio/mpeg; no audio file was published.",
            });
          }
          ray = response.headers.get("cf-ray");
          bytes = await readAudio(response);
        } catch (error) {
          if (error instanceof SpeechError) throw error;
          throw new SpeechError({
            message: deadline.signal.aborted
              ? "Speech request exceeded 60 seconds. It may have been charged; no retry was sent."
              : "Speech transport failed. It may have been charged; no retry was sent.",
          });
        } finally {
          clearTimeout(timer);
        }

        try {
          await writeFile(staging, bytes);
          await link(staging, output);
        } catch {
          throw new SpeechError({
            message:
              "Audio was received but could not be published without overwriting. The request may have been charged.",
          });
        }
        const metadata = {
          createdAt: new Date().toISOString(),
          output,
          model: MODELS[model].id,
          speaker,
          text,
          characters: countCharacters(text),
          bytes: bytes.byteLength,
          elapsedMs: Math.round(performance.now() - started),
          cfRay: ray,
        };
        const metadataSaved = await writeFile(
          output.replace(/\.mp3$/u, ".metadata.json"),
          `${JSON.stringify(metadata, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        ).then(
          () => true,
          () => false,
        );
        return { ...metadata, metadataSaved };
      } finally {
        if (staged) await unlink(staging).catch(() => null);
      }
    },
    catch: (error) =>
      error instanceof SpeechError
        ? error
        : new SpeechError({
            message: "Speech command failed; no automatic retry was sent.",
          }),
  });
});

/**
 * A recording's folder and file name: Unicode letters and numbers kept, apostrophes removed,
 * other punctuation turned into one `-`, cut to 80 code points at a word boundary (a single
 * longer word is truncated). Text with none of those is `speech`.
 */
export const speechExcerpt = (text: string): string => {
  const slug = text
    .normalize("NFC")
    .toLowerCase()
    .replaceAll(/['’]/gu, "")
    .replaceAll(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  // oxlint-disable-next-line typescript/no-misused-spread -- the cut is at 80 code points
  const points = [...slug];
  if (points.length <= 80) return slug || "speech";
  const prefix = points.slice(0, 80).join("");
  if (points[80] === "-") return prefix;
  const boundary = prefix.lastIndexOf("-");
  return boundary > 0 ? prefix.slice(0, boundary) : prefix;
};

const readFolders = (root: string) =>
  readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  });

/**
 * Where `gen` writes by default: `<root>/<YYYYMMDD>-<NN>-<excerpt>/<excerpt>.mp3`, dated in UTC.
 * The daily number is one past the highest folder number that day, not the folder count. With
 * `reserve` the folder is made with an exclusive `mkdir` before the paid request, rescanning
 * after a collision; without it nothing is written and no number is used. Numbers have at least
 * two digits.
 */
export const recordingOutput = async (
  root: string,
  text: string,
  reserve: boolean,
  date = new Date(),
): Promise<string> => {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const excerpt = speechExcerpt(text);
  if (reserve) await mkdir(root, { recursive: true });
  while (true) {
    const highest = (await readFolders(root)).reduce((maximum, entry) => {
      const match = entry.isDirectory()
        ? new RegExp(`^${day}-(\\d+)-`, "u").exec(entry.name)
        : null;
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0);
    const folder = resolve(
      root,
      `${day}-${String(highest + 1).padStart(2, "0")}-${excerpt}`,
    );
    if (!reserve) return resolve(folder, `${excerpt}.mp3`);
    try {
      await mkdir(folder);
      return resolve(folder, `${excerpt}.mp3`);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
};

/**
 * The newest recording under `root`: the greatest folder date, then daily number, not file
 * modification time; folders without an MP3 are skipped, and in a folder with several the first
 * name sorted wins. A `sequence` selects that daily number on the newest date that has one, and
 * never falls back to another number.
 */
export const latestRecording = async (
  root: string,
  sequence?: number,
): Promise<string> => {
  const candidates = (await readdir(root, { withFileTypes: true }))
    .flatMap((entry) => {
      const groups = entry.isDirectory()
        ? /^(?<day>\d{8})-(?<sequence>\d+)-/u.exec(entry.name)?.groups
        : undefined;
      if (groups?.day === undefined || groups.sequence === undefined) return [];
      if (sequence !== undefined && Number(groups.sequence) !== sequence)
        return [];
      return [
        {
          name: entry.name,
          day: Number(groups.day),
          sequence: Number(groups.sequence),
        },
      ];
    })
    .toSorted(
      (a, b) =>
        b.day - a.day ||
        b.sequence - a.sequence ||
        b.name.localeCompare(a.name),
    );
  for (const folder of candidates) {
    const audio = (
      await readdir(resolve(root, folder.name), { withFileTypes: true })
    )
      .filter((file) => file.isFile() && file.name.endsWith(".mp3"))
      .map((file) => file.name)
      .toSorted()[0];
    if (audio !== undefined) return resolve(root, folder.name, audio);
  }
  throw new Error("No recording found");
};
