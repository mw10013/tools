import zlib from "node:zlib";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as Process from "./process.ts";

export class ShopifyDocsError extends Schema.TaggedError<ShopifyDocsError>()(
  "ShopifyDocsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ORIGIN = "https://shopify.dev";
const API_VERSION = "latest";
const SITEMAP_URL = `${ORIGIN}/sitemap_standard.xml.gz`;
const USER_AGENT = "tools/refs-shopify-docs";
const CONCURRENCY = 8;

type DocSection = "apps" | "api" | "admin-graphql";
type DiscoveryKind = "sitemap-prefix" | "webhooks-data";

interface SectionSource {
  readonly label: string;
  readonly kind: DiscoveryKind;
  readonly prefix: string;
  readonly namePrefixes?: readonly string[];
}

const SECTION_SOURCES: Record<DocSection, readonly SectionSource[]> = {
  apps: [
    {
      label: "apps-build",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/apps/build`,
    },
    {
      label: "apps-design",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/apps/design`,
    },
    {
      label: "apps-launch",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/apps/launch`,
    },
  ],
  api: [
    {
      label: "api-admin-extensions",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/admin-extensions/latest`,
    },
    {
      label: "api-admin-rest",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/admin-rest`,
    },
    {
      label: "api-usage",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/usage`,
    },
    {
      label: "api-app-home",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/app-home`,
    },
    {
      label: "api-app-home-ui-extension",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/app-home-ui-extension/latest`,
    },
    {
      label: "api-polaris",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/polaris`,
    },
    {
      label: "api-shopify-cli",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-cli`,
    },
    {
      label: "api-shopify-app-react-router",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-app-react-router/latest`,
    },
    {
      label: "api-partner",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/partner/latest`,
    },
    {
      label: "api-webhooks",
      kind: "webhooks-data",
      prefix: `${ORIGIN}/docs/api/webhooks/${API_VERSION}`,
    },
  ],
  "admin-graphql": [
    {
      label: "admin-graphql",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/admin-graphql/latest`,
      namePrefixes: [
        "access",
        "app",
        "bulkOperation",
        "catalog",
        "collection",
        "company",
        "consent",
        "currentAppInstallation",
        "currentBulkOperation",
        "customer",
        "discount",
        "draftOrder",
        "event",
        "file",
        "fulfillment",
        "inventory",
        "job",
        "location",
        "market",
        "media",
        "menu",
        "metafield",
        "metaobject",
        "order",
        "page",
        "price",
        "product",
        "publication",
        "publishable",
        "redirect",
        "shop",
        "subscription",
        "url",
        "validation",
        "webhook",
      ],
    },
  ],
};

const DEFAULT_SECTIONS = Object.keys(SECTION_SOURCES) as DocSection[];

const WebhookTopic = Schema.Struct({
  name: Schema.NonEmptyString.check(
    Schema.isPattern(/^[A-Za-z0-9_]+(?:[/.][A-Za-z0-9_]+)*$/u),
  ),
  description: Schema.optional(Schema.String),
  isOptional: Schema.optional(Schema.Boolean),
  availableOn: Schema.optional(Schema.Array(Schema.String)),
  relatedResource: Schema.optional(Schema.String),
  webhooksNotices: Schema.optional(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          type: Schema.NonEmptyString,
          approvalScopes: Schema.optional(Schema.Array(Schema.String)),
        }),
      ]),
    ),
  ),
  examples: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        tabs: Schema.optional(
          Schema.Array(
            Schema.Struct({
              title: Schema.optional(Schema.String),
              code: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});
type WebhookTopic = typeof WebhookTopic.Type;

const WebhooksData = Schema.Struct({
  "templated-landing-webhooks": Schema.Struct({
    data: Schema.Struct({
      apiVersion: Schema.NonEmptyString,
      eventTopicsTypeDefinitions: Schema.Struct({
        WebhookTopics: Schema.Struct({
          members: Schema.NonEmptyArray(WebhookTopic),
        }),
      }),
    }),
  }),
});
const DataArray = Schema.Array(Schema.Unknown);
const DataRecord = Schema.Record(Schema.String, Schema.Unknown);
const DataIndex = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const DataKey = Schema.String.check(Schema.isPattern(/^_\d+$/u));
const DocUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      url.origin === ORIGIN &&
      url.pathname.startsWith("/docs/") &&
      !url.pathname.split("/").some((part) => part === ".." || part === "."),
  ),
);

type DocTask =
  | {
      readonly _tag: "Markdown";
      readonly section: DocSection;
      readonly docUrl: string;
    }
  | {
      readonly _tag: "Webhook";
      readonly section: DocSection;
      readonly docUrl: string;
      readonly content: string;
    };

function canonicalizeDocUrl(raw: string): string | null {
  const parsed = Schema.decodeUnknownOption(DocUrl)(raw);
  if (Option.isNone(parsed)) return null;
  const url = parsed.value;
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname
    .replace(/\.(?:md|txt)$/iu, "")
    .replaceAll(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
  return url.toString();
}

function isUnderPrefix(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`);
}

function matchesNamePrefixes(
  url: string,
  namePrefixes: readonly string[] | undefined,
  canonicalPrefix: string,
): boolean {
  if (!namePrefixes || url === canonicalPrefix) return true;
  const lastSegment =
    new URL(url).pathname.split("/").pop()?.toLowerCase() ?? "";
  return namePrefixes.some((p) => lastSegment.startsWith(p.toLowerCase()));
}

function collectSitemapUrls(
  sitemapXml: string,
  prefix: string,
  namePrefixes: readonly string[] | undefined,
): Set<string> {
  const canonicalPrefix = canonicalizeDocUrl(prefix);
  if (!canonicalPrefix) {
    throw new Error(`Invalid section prefix ${prefix}`);
  }

  const urls = new Set<string>([canonicalPrefix]);

  for (const match of sitemapXml.matchAll(/<loc>(?<url>[^<]+)<\/loc>/gu)) {
    const canonical = canonicalizeDocUrl(match.groups?.url ?? "");
    if (
      canonical &&
      isUnderPrefix(canonical, canonicalPrefix) &&
      matchesNamePrefixes(canonical, namePrefixes, canonicalPrefix)
    ) {
      urls.add(canonical);
    }
  }

  return urls;
}

/** Shopify's Single Fetch payload stores values in an array and refers to them by index. */
function decodeReactRouterData(input: unknown): unknown {
  const encoded = Schema.decodeUnknownSync(DataArray)(input);
  const decodeValue = (value: unknown, seen: ReadonlySet<number>): unknown => {
    if (Schema.is(DataArray)(value))
      return value.map((entry) => decodeIndex(entry, seen));
    if (Schema.is(DataRecord)(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => Schema.is(DataKey)(key))
          .map(([key, entry]) => [
            String(decodeIndex(Number(key.slice(1)), seen)),
            decodeIndex(entry, seen),
          ]),
      );
    }
    return value;
  };
  const decodeIndex = (entry: unknown, seen: ReadonlySet<number>): unknown => {
    if (!Schema.is(Schema.Number)(entry)) return entry;
    if (!Schema.is(DataIndex)(entry) || seen.has(entry)) return undefined;
    return decodeValue(encoded[entry], new Set([...seen, entry]));
  };
  return decodeIndex(0, new Set());
}

function readWebhookTopics(decoded: unknown): readonly WebhookTopic[] {
  return Schema.decodeUnknownSync(WebhooksData)(decoded)[
    "templated-landing-webhooks"
  ].data.eventTopicsTypeDefinitions.WebhookTopics.members;
}

function toWebhookTopicDocUrl(docUrl: string, topicName: string): string {
  return `${docUrl}/topics/${topicName}`;
}

function renderWebhookTopicsMarkdown(
  docUrl: string,
  dataUrl: string,
  topics: readonly WebhookTopic[],
): string {
  return `${[
    "---",
    "title: Webhooks",
    "description: The list of all webhook topics you can subscribe to.",
    "api_name: webhooks",
    `source_url: ${docUrl}`,
    `data_url: ${dataUrl}`,
    "---",
    "",
    "# Webhooks",
    "",
    "The list of all webhook topics you can subscribe to.",
    "",
    "## List of topics",
    "",
    ...topics.map(
      (topic) =>
        `- [${topic.name}](${toWebhookTopicDocUrl(docUrl, topic.name)})`,
    ),
  ].join("\n")}\n`;
}

function renderWebhookTopicMarkdown(
  docUrl: string,
  dataUrl: string,
  topic: WebhookTopic,
): string {
  return `${[
    "---",
    `title: ${Schema.encodeSync(Schema.fromJsonString(Schema.String))(topic.name)}`,
    `description: ${Schema.encodeSync(Schema.fromJsonString(Schema.String))(topic.description ?? "")}`,
    "api_name: webhooks",
    `source_url: ${docUrl}`,
    `data_url: ${dataUrl}`,
    "---",
    "",
    `# ${topic.name}`,
    "",
    topic.description ?? "",
    "",
    ...(topic.availableOn?.length
      ? [`- Available on: ${topic.availableOn.join(", ")}`]
      : []),
    ...(topic.relatedResource
      ? [`- Related resource: ${topic.relatedResource}`]
      : []),
    ...(topic.isOptional === undefined
      ? []
      : [`- Optional: ${topic.isOptional ? "yes" : "no"}`]),
    ...(topic.webhooksNotices?.length
      ? [
          "",
          "## Notices",
          "",
          ...topic.webhooksNotices.map((notice) =>
            Schema.is(Schema.String)(notice)
              ? notice
              : `- ${notice.type}${notice.approvalScopes ? `: ${notice.approvalScopes.join(", ")}` : ""}`,
          ),
        ]
      : []),
    ...(topic.examples?.length
      ? [
          "",
          "## Examples",
          "",
          ...topic.examples.flatMap((example) => [
            ...(example.title ? [`### ${example.title}`, ""] : []),
            ...(example.description ? [example.description, ""] : []),
            ...(example.tabs ?? []).flatMap((tab) => [
              ...(tab.title ? [`#### ${tab.title}`, ""] : []),
              "```json",
              tab.code ?? "",
              "```",
              "",
            ]),
          ]),
        ]
      : []),
  ].join("\n")}\n`;
}

const request = Effect.fn("ShopifyDocs.request")((url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("user-agent", USER_AGENT),
        ),
      ),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.mapError(
      (cause) => new ShopifyDocsError({ message: `Failed ${url}`, cause }),
    ),
  ),
);

const requestText = Effect.fn("ShopifyDocs.requestText")((url: string) =>
  request(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError((cause) =>
      cause instanceof ShopifyDocsError
        ? cause
        : new ShopifyDocsError({ message: `Failed ${url}`, cause }),
    ),
  ),
);

const requestBytes = Effect.fn("ShopifyDocs.requestBytes")((url: string) =>
  request(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((cause) =>
      cause instanceof ShopifyDocsError
        ? cause
        : new ShopifyDocsError({ message: `Failed ${url}`, cause }),
    ),
  ),
);

const fetchSitemapXml = requestBytes(SITEMAP_URL).pipe(
  Effect.flatMap((bytes) =>
    Effect.try({
      try: () => new TextDecoder().decode(zlib.gunzipSync(bytes)),
      catch: (cause) =>
        new ShopifyDocsError({ message: "Failed to gunzip sitemap", cause }),
    }),
  ),
);

function toLocalPath(staging: string, docUrl: string, path: Path.Path): string {
  const { pathname } = new URL(docUrl);
  return path.join(
    staging,
    `${pathname === "/" ? "index" : pathname.slice(1)}.md`,
  );
}

const persist = Effect.fn("ShopifyDocs.persist")(
  (localPath: string, content: string) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        Path.Path.pipe(
          Effect.flatMap((path) =>
            fs
              .makeDirectory(path.dirname(localPath), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(localPath, content))),
          ),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ShopifyDocsError({
            message: `Failed to write ${localPath}`,
            cause,
          }),
      ),
    ),
);

const buildSitemapTasks = Effect.fn("ShopifyDocs.buildSitemapTasks")(
  (section: DocSection, source: SectionSource, sitemapXml: string) =>
    Effect.try({
      try: () =>
        [...collectSitemapUrls(sitemapXml, source.prefix, source.namePrefixes)]
          .toSorted()
          .map((docUrl): DocTask => ({ _tag: "Markdown", section, docUrl })),
      catch: (cause) =>
        new ShopifyDocsError({
          message: `Failed to collect ${section}/${source.label}`,
          cause,
        }),
    }),
);

const buildWebhookTasks = Effect.fn("ShopifyDocs.buildWebhookTasks")(function* (
  section: DocSection,
  source: SectionSource,
) {
  const canonicalPrefix = canonicalizeDocUrl(source.prefix);
  if (!canonicalPrefix) {
    return yield* Effect.fail(
      new ShopifyDocsError({
        message: `Invalid webhooks data prefix ${source.prefix}`,
      }),
    );
  }
  const dataUrl = `${canonicalPrefix}.data`;
  const raw = yield* requestText(dataUrl);
  const topics = yield* Effect.try({
    try: () =>
      readWebhookTopics(
        decodeReactRouterData(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(raw),
        ),
      ),
    catch: (cause) =>
      new ShopifyDocsError({
        message: `Failed to decode webhooks data ${dataUrl}: ${String(cause)}`,
        cause,
      }),
  });
  yield* Console.log(
    `collecting ${section}/${source.label} topics=${String(topics.length)}`,
  );
  return [
    {
      _tag: "Webhook",
      section,
      docUrl: canonicalPrefix,
      content: renderWebhookTopicsMarkdown(canonicalPrefix, dataUrl, topics),
    },
    ...topics.map((topic): DocTask => ({
      _tag: "Webhook",
      section,
      docUrl: toWebhookTopicDocUrl(canonicalPrefix, topic.name),
      content: renderWebhookTopicMarkdown(
        toWebhookTopicDocUrl(canonicalPrefix, topic.name),
        dataUrl,
        topic,
      ),
    })),
  ] satisfies readonly DocTask[];
});

const runTask = Effect.fn("ShopifyDocs.runTask")(
  function* (staging: string, task: DocTask) {
    const path = yield* Path.Path;
    const content = yield* Match.valueTags(task, {
      Markdown: ({ docUrl }) => requestText(`${docUrl}.md`),
      Webhook: ({ content }) => Effect.succeed(content),
    });
    yield* persist(toLocalPath(staging, task.docUrl, path), content);
    return "saved" as const;
  },
  (effect, _staging, task) =>
    effect.pipe(
      Effect.catch((error) =>
        Console.error(
          `failed ${task.section} ${task.docUrl}: ${error.message}`,
        ).pipe(Effect.as(null)),
      ),
    ),
);

/** Every file under `dir`, walked iteratively so the effect stays non-recursive. */
const allFiles = Effect.fn("ShopifyDocs.allFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const out: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of yield* fs
      .readDirectory(current)
      .pipe(Effect.orElseSucceed(() => []))) {
      const full = path.join(current, entry);
      const type = yield* fs.stat(full).pipe(
        Effect.map((s) => s.type),
        Effect.orElseSucceed(() => "Other" as const),
      );
      if (type === "Directory") pending.push(full);
      else out.push(full);
    }
  }
  return out;
});

/** Make `name` unique within `used`, suffixing before the extension. */
const uniqueName = (name: string, used: Set<string>) => {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++)
    candidate = name.includes(".")
      ? name.replace(/(?<ext>\.[^.]+)$/u, `-${String(n)}$<ext>`)
      : `${name}-${String(n)}`;
  used.add(candidate);
  return candidate;
};

/**
 * Image URLs worth localizing: Shopify's own hosts only, so third-party embeds keep
 * their absolute URL rather than getting fetched from someone else's server.
 */
const IMAGE_URL_RE =
  /(?<open>!\[[^\]\n]*\]\(|<img\b[^>]*?\bsrc=["'])(?<url>https:\/\/(?:shopify\.dev|shopify-assets\.shopifycdn\.com|cdn\.shopify\.com)\/[^\s)"'<>\\]+\.(?:png|jpe?g|gif|svg|webp)(?:\?[^\s)"'<>\\]*)?)/gu;

/** Keep fenced examples intact when scanning or rewriting images. */
const mapProse = (markdown: string, transform: (prose: string) => string) =>
  markdown
    .split(
      /(^[ \t]*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*(?:`{3,}|~{3,})[^\n]*(?:\n|$))/gmu,
    )
    .map((part, index) => (index % 2 === 0 ? transform(part) : part))
    .join("");

/**
 * Download the images the fetched markdown references into `_assets/` and rewrite the
 * links relative to each file. The `.md` endpoints reference images absolutely, so
 * without this the ref has no local images at all. A failed download logs and leaves
 * that link absolute -- a missing figure should not fail the whole fetch.
 */
const localizeImages = Effect.fn("ShopifyDocs.localizeImages")(function* (
  staging: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const files = (yield* allFiles(staging)).filter((f) => f.endsWith(".md"));
  const urls = new Set<string>();
  for (const file of files) {
    mapProse(yield* fs.readFileString(file), (prose) => {
      for (const match of prose.matchAll(IMAGE_URL_RE)) {
        const url = match.groups?.url;
        if (url) urls.add(url);
      }
      return prose;
    });
  }
  if (urls.size === 0) return;

  const assetsDir = path.join(staging, "_assets");
  yield* fs.makeDirectory(assetsDir, { recursive: true });

  // Names are assigned up front (uniqueName mutates its set), then the downloads run
  // concurrently; a failure drops the URL from the map so its links stay absolute.
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const url of urls)
    names.set(
      url,
      uniqueName(
        decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""),
        used,
      ),
    );

  const results = yield* Effect.forEach(
    [...names],
    ([url, name]) =>
      requestBytes(url).pipe(
        Effect.flatMap((bytes) =>
          fs.writeFile(path.join(assetsDir, name), bytes),
        ),
        Effect.as(url),
        Effect.catch((error) =>
          Console.error(`image failed ${url}: ${error.message}`).pipe(
            Effect.andThen(() => {
              names.delete(url);
              return Effect.succeed(null);
            }),
          ),
        ),
      ),
    { concurrency: CONCURRENCY },
  );

  for (const file of files) {
    const before = yield* fs.readFileString(file);
    const after = mapProse(before, (prose) =>
      prose.replaceAll(IMAGE_URL_RE, (_match, open: string, url: string) => {
        const name = names.get(url);
        return (
          open +
          (name === undefined
            ? url
            : path
                .relative(path.dirname(file), path.join(assetsDir, name))
                .replaceAll("\\", "/"))
        );
      }),
    );
    if (after !== before) yield* fs.writeFileString(file, after);
  }
  yield* Console.log(
    `images: ${String(results.filter((r) => r !== null).length)}/${String(urls.size)} localized to _assets/`,
  );
});

/**
 * Fetch Shopify's first-party `.md` pages discovered through its sitemap, preserving code
 * fences that HTML conversion loses. Webhook topics come from Single Fetch data because
 * their `.md` endpoints return 404. Page failures reject the staged snapshot; image failures
 * leave their original URLs intact. Scope includes app docs, selected Admin resources, and the Flow manual.
 * @see https://shopify.dev/docs/apps/build
 */
export const downloadInto = Effect.fn("ShopifyDocs.downloadInto")(function* (
  staging: string,
) {
  const path = yield* Path.Path;
  const dev = path.join(staging, "dev");
  const sitemapXml = yield* fetchSitemapXml;

  const tasks: DocTask[] = [];
  const seen = new Set<string>();
  for (const section of DEFAULT_SECTIONS) {
    for (const source of SECTION_SOURCES[section]) {
      const sourceTasks = yield* Match.value(source.kind).pipe(
        Match.when("sitemap-prefix", () =>
          buildSitemapTasks(section, source, sitemapXml),
        ),
        Match.when("webhooks-data", () => buildWebhookTasks(section, source)),
        Match.exhaustive,
      );
      yield* Console.log(
        `collecting ${section}/${source.label} urls=${String(sourceTasks.length)}`,
      );
      for (const task of sourceTasks)
        if (!seen.has(task.docUrl)) {
          seen.add(task.docUrl);
          tasks.push(task);
        }
    }
  }

  const results = yield* Effect.forEach(tasks, (task) => runTask(dev, task), {
    concurrency: CONCURRENCY,
  });
  const saved = results.filter((r) => r === "saved").length;
  const failed = results.filter((r) => r === null).length;
  yield* Console.log(`pages: ${String(saved)}/${String(results.length)} saved`);
  if (failed > 0) {
    yield* Effect.fail(
      new ShopifyDocsError({
        message: `${String(failed)} page(s) failed to fetch`,
      }),
    );
  }
  yield* downloadFlow(staging);
  yield* downloadPolaris(staging);
  yield* localizeImages(staging);
}, Effect.provide(FetchHttpClient.layer));

const FLOW_PREFIX = "https://help.shopify.com/en/manual/shopify-flow";
const FLOW_RETRY = Schedule.exponential("2 seconds").pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 5 }),
);

const downloadFlow = Effect.fn("ShopifyDocs.downloadFlow")(function* (
  staging: string,
) {
  const path = yield* Path.Path;
  const xml = yield* requestText("https://help.shopify.com/sitemap-en.xml");
  const urls = new Set<string>([FLOW_PREFIX]);
  for (const match of xml.matchAll(/<loc>(?<url>[^<]+)<\/loc>/gu)) {
    const url = (match.groups?.url ?? "")
      .trim()
      .replace(/\.md$/u, "")
      .replace(/\/$/u, "");
    if (url === FLOW_PREFIX || url.startsWith(`${FLOW_PREFIX}/`)) urls.add(url);
  }
  yield* Console.log(`flow: downloading ${String(urls.size)} pages`);
  yield* Effect.forEach(
    [...urls].toSorted(),
    Effect.fn("ShopifyDocs.downloadFlowPage")(function* (url) {
      const relative = url.slice(FLOW_PREFIX.length).replace(/^\//u, "");
      const markdown = yield* requestText(`${url}.md`).pipe(
        Effect.retry(FLOW_RETRY),
      );
      yield* Effect.sleep("300 millis");
      const content = markdown.replaceAll(
        /(?<open>!\[[^\]]*\]\()(?<path>\/[^)\s]+)/gu,
        "$<open>https://cdn.shopify.com/shopifycloud/help-center$<path>",
      );
      yield* persist(
        path.join(staging, "flow", `${relative || "index"}.md`),
        `---\nsource_url: ${url}\n---\n\n${content.trimStart()}`,
      );
    }),
    { concurrency: 1 },
  );
});

const downloadPolaris = Effect.fn("ShopifyDocs.downloadPolaris")(function* (
  staging: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = "https://cdn.shopify.com/shopifycloud/polaris-2.0.js";
  const directory = path.join(staging, "polaris-code");
  yield* fs.makeDirectory(directory);
  const bytes = yield* requestBytes(url);
  yield* fs.writeFile(path.join(directory, "polaris-2.0.min.js"), bytes);
  const root = path.resolve(
    path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
    "../..",
  );
  const formatted = yield* Process.run(
    root,
    "vp",
    ["fmt", "--stdin-filepath=polaris-2.0.js"],
    new TextDecoder().decode(bytes),
  );
  yield* fs.writeFileString(
    path.join(directory, "polaris-2.0.js"),
    `${formatted}\n`,
  );
  yield* fs.writeFileString(
    path.join(directory, "README.md"),
    `# Polaris runtime code\n\nThis directory contains Shopify's distributed JavaScript runtime bundle, not its documentation.\n\nFor Polaris documentation, see [../dev/docs/api/polaris.md](../dev/docs/api/polaris.md) and the other Polaris pages under ../dev/docs/.\n\nSource: ${url}\n\n- polaris-2.0.min.js: original CDN bytes.\n- polaris-2.0.js: formatted reading copy.\n`,
  );
  yield* Console.log(
    "polaris-code: saved original and formatted runtime bundle",
  );
});
