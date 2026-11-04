import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export class M4lDocsError extends Schema.TaggedError<M4lDocsError>()(
  "M4lDocsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const ORIGIN = "https://docs.cycling74.com";
const USER_AGENT = "tools/refs-m4l-docs";
const CONCURRENCY = 8;

/**
 * The Max for Live user guide, the Live Object Model, the `v8` and Node for Max APIs, and
 * the three Max objects a patch reaches Live through. The rest of `reference/` is about
 * 1800 pages of unrelated Max object documentation.
 */
const SCOPE =
  /^\/(?:userguide\/m4l|apiref\/(?:lom|js|nodeformax))\/(?:[^/]+\/)?$|^\/reference\/live\.(?:path|object|observer)\/$/u;

/**
 * The sitemap lists every LOM and user-guide page but only the index of `apiref/js` and
 * `apiref/nodeformax`; those indexes link their pages instead. Some nodeformax links carry a
 * `?source=post_page…` query that names no page, so links with a query are dropped.
 */
const INDEXES = ["/apiref/lom/", "/apiref/js/", "/apiref/nodeformax/"];

/** The page body, without the site header, navigation sidebars and footer. */
const ARTICLE = "article.c74-article-content";

/** Section indexes become `index.md` in their own directory; every other page `<slug>.md`. */
const fileOf = (pathname: string) =>
  INDEXES.includes(pathname)
    ? `${pathname.slice(1)}index.md`
    : `${pathname.slice(1, -1)}.md`;

const client = HttpClient.HttpClient.pipe(
  Effect.map((http) =>
    http.pipe(
      HttpClient.mapRequest(
        HttpClientRequest.setHeader("user-agent", USER_AGENT),
      ),
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        schedule: Schedule.exponential("500 millis"),
        times: 3,
      }),
    ),
  ),
);

const requestText = Effect.fn("M4lDocs.requestText")(function* (
  pathname: string,
) {
  const http = yield* client;
  return yield* http.get(`${ORIGIN}${pathname}`).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError(
      (cause) => new M4lDocsError({ message: `Failed ${pathname}`, cause }),
    ),
  );
});

const requestBytes = Effect.fn("M4lDocs.requestBytes")(function* (
  pathname: string,
) {
  const http = yield* client;
  return yield* http.get(`${ORIGIN}${pathname}`).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (cause) => new M4lDocsError({ message: `Failed ${pathname}`, cause }),
    ),
  );
});

const inScope = (href: string) => {
  if (!href.startsWith("/") && !href.startsWith(ORIGIN)) return undefined;
  const url = new URL(href, ORIGIN);
  if (url.origin !== ORIGIN || url.search !== "") return undefined;
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  return SCOPE.test(pathname) ? pathname : undefined;
};

const discover = Effect.fn("M4lDocs.discover")(function* () {
  const sitemap = yield* requestText("/sitemap.xml");
  const indexes = yield* Effect.forEach(INDEXES, requestText, {
    concurrency: CONCURRENCY,
  });
  const hrefs = [
    ...[...sitemap.matchAll(/<loc>(?<url>[^<]+)<\/loc>/gu)].map(
      (match) => match.groups?.url ?? "",
    ),
    ...indexes.flatMap((html) =>
      [...html.matchAll(/href="(?<href>[^"#]+)"/gu)].map(
        (match) => match.groups?.href ?? "",
      ),
    ),
  ];
  return [...new Set(hrefs.flatMap((href) => inScope(href) ?? []))].toSorted();
});

/**
 * Turndown escapes Markdown syntax in text, which writes `cue_points` as `cue\_points` and
 * leaves every LOM member ungreppable by name; a reading copy wants the text verbatim.
 * Access tags (`get`, `set`, `observe`) are adjacent spans with no separator between them.
 */
const turndown = () => {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  service.escape = (text) => text;
  service.addRule("access-tag", {
    filter: (node) =>
      node.nodeName === "SPAN" && node.classList.contains("c74-tag"),
    replacement: (content, node) =>
      node.previousElementSibling?.classList.contains("c74-tag") === true
        ? `, ${content}`
        : content,
  });
  return service;
};

/**
 * The LOM overview diagram is inline SVG, which Markdown cannot hold. Its colors are the
 * site's `--svg-bg` and `--svg-fg` theme variables, so a standalone copy renders blank
 * until they are substituted. The DOM serializes it as HTML, which leaves a bare `&` in an
 * attribute (`id="Audio, Instruments & Drum Racks"`) that an SVG file, being XML, rejects.
 */
const standaloneSvg = (svg: string) =>
  svg
    .replaceAll("var(--svg-bg)", "#ffffff")
    .replaceAll("var(--svg-fg)", "#111111")
    .replaceAll(/&(?![a-z]+;|#\d+;|#x[\da-f]+;)/giu, "&amp;");

interface Converted {
  readonly file: string;
  readonly markdown: string;
  readonly images: readonly string[];
  readonly svgs: readonly { readonly name: string; readonly svg: string }[];
}

/**
 * Rewrite one page's article for a local reading copy: links to fetched pages point at
 * their Markdown files, other site links become absolute, images point into `_assets/`,
 * and heading self-links (`#cue_points`) are dropped so they do not bleed into headings.
 */
const convert = (
  path: Path.Path,
  pathname: string,
  html: string,
  files: ReadonlyMap<string, string>,
  service: TurndownService,
): Converted | undefined => {
  const article = parseHTML(html).document.querySelector(ARTICLE);
  if (article === null) return undefined;
  const file = fileOf(pathname);
  const relative = (target: string) =>
    path.relative(path.dirname(file), target).replaceAll("\\", "/");
  for (const anchor of article.querySelectorAll('a[href^="#"]'))
    if (anchor.textContent === "") anchor.remove();
  for (const anchor of article.querySelectorAll('a[href^="/"]')) {
    const href = anchor.getAttribute("href") ?? "";
    const url = new URL(href, ORIGIN);
    const target = files.get(inScope(href) ?? "");
    anchor.setAttribute(
      "href",
      target === undefined ? url.href : `${relative(target)}${url.hash}`,
    );
  }
  const images: string[] = [];
  for (const image of article.querySelectorAll('img[src^="/images/"]')) {
    const src = image.getAttribute("src") ?? "";
    images.push(src);
    image.removeAttribute("srcset");
    image.setAttribute("src", relative(`_assets/${path.basename(src)}`));
  }
  const svgs = [...article.querySelectorAll("svg[width]")]
    .filter((svg) => Number(svg.getAttribute("width")) >= 400)
    .map((svg, index) => {
      const name = `${file.replaceAll("/", "-").replace(/\.md$/u, "")}-${String(index + 1)}.svg`;
      const content = standaloneSvg(svg.outerHTML);
      const image = article.ownerDocument.createElement("img");
      image.setAttribute("src", relative(`_assets/${name}`));
      image.setAttribute("alt", "");
      svg.replaceWith(image);
      return { name, svg: content };
    });
  return {
    file,
    markdown: `${service.turndown(article.innerHTML)}\n`,
    images,
    svgs,
  };
};

/**
 * Fetch the Max for Live documentation from docs.cycling74.com as Markdown. The site is
 * server-rendered Next.js, so each page's HTML already holds the full article: no browser
 * and no crawler. Page failures reject the snapshot; an image that fails to download logs
 * and is left out of `_assets/`.
 * @see https://docs.cycling74.com/apiref/lom/
 */
export const downloadInto = Effect.fn("M4lDocs.downloadInto")(function* (
  staging: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pathnames = yield* discover();
  yield* Console.log(`m4l-docs: downloading ${String(pathnames.length)} pages`);
  const files = new Map(
    pathnames.map((pathname) => [pathname, fileOf(pathname)]),
  );
  const service = turndown();
  const pages = yield* Effect.forEach(
    pathnames,
    (pathname) =>
      requestText(pathname).pipe(
        Effect.flatMap((html) => {
          const page = convert(path, pathname, html, files, service);
          return page === undefined
            ? Effect.fail(
                new M4lDocsError({ message: `No article in ${pathname}` }),
              )
            : Effect.succeed(page);
        }),
      ),
    { concurrency: CONCURRENCY },
  );
  const assets = path.join(staging, "_assets");
  yield* fs.makeDirectory(assets, { recursive: true });
  for (const page of pages) {
    const file = path.join(staging, page.file);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, page.markdown);
    for (const { name, svg } of page.svgs)
      yield* fs.writeFileString(path.join(assets, name), svg);
  }
  const images = [...new Set(pages.flatMap((page) => page.images))];
  const saved = yield* Effect.forEach(
    images,
    (src) =>
      requestBytes(src).pipe(
        Effect.flatMap((bytes) =>
          fs.writeFile(path.join(assets, path.basename(src)), bytes),
        ),
        Effect.as(true),
        Effect.catch((error) =>
          Console.error(`m4l-docs: image failed ${src}: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
      ),
    { concurrency: CONCURRENCY },
  );
  yield* Console.log(
    `m4l-docs: images ${String(saved.filter(Boolean).length)}/${String(images.length)} saved to _assets/`,
  );
}, Effect.provide(FetchHttpClient.layer));
