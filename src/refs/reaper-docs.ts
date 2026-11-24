import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
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

import * as Process from "./process.ts";

export class ReaperDocsError extends Schema.TaggedError<ReaperDocsError>()(
  "ReaperDocsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const ORIGIN = "https://www.reaper.fm";
const USER_AGENT = "tools/refs-reaper-docs";
const CONCURRENCY = 4;
const API_PAGE = "/sdk/reascript/reascripthelp.html";
const USER_GUIDES_PAGE = "/userguide.php";
const JSFX_INDEX = "/sdk/js/js.php";

/** The developer pages REAPER's site footer lists, minus theme, cursor and language-pack authoring. */
const PAGES = [
  { pathname: "/sdk/reascript/reascript.php", file: "pages/reascript.md" },
  { pathname: "/sdk/plugin/plugin.php", file: "pages/extensions-sdk.md" },
  { pathname: "/sdk/osc/osc.php", file: "pages/osc.md" },
  { pathname: "/sdk/vst/vst_ext.php", file: "pages/vst-extensions.md" },
] as const;

/**
 * The user guide's file name carries REAPER's version (`ReaperUserGuide786c.pdf`), so each
 * PDF is found on the user guide page by its stem rather than pinned.
 */
const GUIDES = [
  { pattern: /userguide\/ReaperUserGuide[^"']*\.pdf/u, name: "user-guide" },
  {
    pattern: /userguide\/REAPEREffectsGuide[^"']*\.pdf/u,
    name: "effects-guide",
  },
  { pattern: /userguide\/WhatsNewReaper[^"']*\.pdf/u, name: "whats-new" },
] as const;

const ARCHIVES = [
  {
    repository: "justinfrankel/reaper-sdk",
    branch: "main",
    directory: "sdk",
  },
  {
    repository: "ReaTeam/Doc",
    branch: "master",
    directory: "community/reateam-doc",
  },
  {
    repository: "ReaTeam/ReaScripts",
    branch: "master",
    directory: "examples/reascripts",
  },
] as const;

const ULTRASCHALL =
  "https://raw.githubusercontent.com/Ultraschall/ultraschall-lua-api-for-reaper/master/ultraschall_api/DocsSourcefiles";

/** Ultraschall's documentation of what Cockos leaves undocumented; its ReaGirl and theme docs are its own. */
const ULTRASCHALL_DOCS = [
  { source: "Reaper_Api_Documentation.USDocML", file: "api" },
  { source: "Reaper_Config_Variables.USDocML", file: "config-variables.md" },
  {
    source: "Reaper_StateChunk_Documentation.USDOCML",
    file: "state-chunks.md",
  },
  {
    source: "Reaper_API_Web_Documentation.USDocML",
    file: "web-interface.md",
  },
  {
    source: "Reaper_API_Video_Documentation.USDocML",
    file: "video-processor.md",
  },
] as const;

/** REAPER 7 embeds Lua 5.4. */
const LUA_MANUAL = "https://www.lua.org/manual/5.4/manual.html";

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

const requestText = Effect.fn("ReaperDocs.requestText")(function* (
  url: string,
) {
  const http = yield* client;
  return yield* http.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError(
      (cause) => new ReaperDocsError({ message: `Failed ${url}`, cause }),
    ),
  );
});

const requestBytes = Effect.fn("ReaperDocs.requestBytes")(function* (
  url: string,
) {
  const http = yield* client;
  return yield* http.get(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(
      (cause) => new ReaperDocsError({ message: `Failed ${url}`, cause }),
    ),
  );
});

/** Turndown escapes Markdown syntax in text, which writes `D_VOL` as `D\_VOL`; a reading copy wants it verbatim. */
export const turndown = () => {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  service.escape = (text) => text;
  return service;
};

/** A fragment's body; linkedom leaves `body` empty unless the markup is a whole document. */
const fragment = (html: string) =>
  parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;

/** `\s` also matches the `&nbsp;` the API page pads signatures with. */
const textOf = (html: string) =>
  (fragment(html).body.textContent ?? "").replaceAll(/\s+/gu, " ").trim();

interface Section {
  readonly name: string;
  readonly html: string;
}

/** The API page separates entries with `<a name="…"><hr></a><br>`, flat siblings with no wrapper. */
const sections = (html: string): readonly Section[] => {
  const parts = html.split(/<a name="(?<name>[^"]+)"><hr><\/a><br>/iu);
  return Array.from({ length: (parts.length - 1) / 2 }, (_, index) => ({
    name: parts[index * 2 + 1] ?? "",
    html: parts[index * 2 + 2] ?? "",
  }));
};

const LANGUAGES = [
  { key: "l", label: "Lua" },
  { key: "c", label: "C" },
  { key: "e", label: "EEL2" },
  { key: "p", label: "Python" },
] as const;

export interface ApiFunction {
  readonly name: string;
  readonly signatures: readonly {
    readonly label: string;
    readonly signature: string;
  }[];
  readonly description: string;
}

export interface Api {
  /** The page's `REAPER v7.86` banner, which names the release the page was generated from. */
  readonly version: string | undefined;
  readonly introduction: string;
  readonly functions: readonly ApiFunction[];
  readonly builtins: readonly {
    readonly language: string;
    readonly file: string;
    readonly entries: readonly Section[];
  }[];
}

const region = (html: string, start: string, end: string) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  return from === -1 || to === -1 ? "" : html.slice(from, to);
};

/**
 * Split REAPER's generated API page. Its language introductions (`e_doc`, `l_doc`, `p_doc`)
 * come first, then every API function with one `<div class="?_func">` signature per language
 * followed by its description, then each language's built-in functions (`?_funcs`).
 */
export const parseApi = (html: string): Api => {
  const version = /REAPER v(?<version>\d+\.\d+[^\s<]*)/u.exec(html)?.groups
    ?.version;
  const functionsStart = html.indexOf('<a name="function_list">');
  const bodyStart = /<body[^>]*>/u.exec(html);
  const introduction = html.slice(
    bodyStart === null ? 0 : bodyStart.index + bodyStart[0].length,
    functionsStart === -1 ? 0 : functionsStart,
  );
  const functions = sections(
    region(html, '<a name="function_list">', '<div class="e_funcs">'),
  ).map(({ name, html: entry }) => {
    const signatures = LANGUAGES.flatMap(({ key, label }) => {
      const match = new RegExp(
        `<div class="${key}_func">[\\s\\S]*?<code>(?<code>[\\s\\S]*?)</code>`,
        "u",
      ).exec(entry);
      return match?.groups?.code === undefined
        ? []
        : [{ label, signature: textOf(match.groups.code) }];
    });
    const description = entry
      .replaceAll(/<div class="[celp]_func">[\s\S]*?<\/div>/gu, "")
      .trim();
    return { name, signatures, description };
  });
  const builtins = [
    { language: "Lua", key: "l", file: "lua-builtins.md" },
    { language: "EEL2", key: "e", file: "eel2-builtins.md" },
    { language: "Python", key: "p", file: "python-builtins.md" },
  ].map(({ language, key, file }) => {
    const start = html.indexOf(`<div class="${key}_funcs">`);
    const rest = start === -1 ? "" : html.slice(start);
    const next = rest.search(/<\/div><div class="[elp]_funcs">|<\/div>View:/u);
    return {
      language,
      file,
      entries: sections(next === -1 ? rest : rest.slice(0, next)),
    };
  });
  return { version, introduction, functions, builtins };
};

/** API cross-links are `#Name` anchors; point them at the function files or the built-in lists. */
const rewriteAnchors = (
  html: string,
  target: (anchor: string) => string | undefined,
) =>
  html.replaceAll(
    /<a href="#(?<anchor>[^"]+)">(?<text>[\s\S]*?)<\/a>/gu,
    (_, anchor: string, text: string) => {
      const href = target(anchor);
      return href === undefined ? text : `<a href="${href}">${text}</a>`;
    },
  );

const builtinFile = (anchor: string) =>
  anchor.startsWith("lua_")
    ? "lua-builtins.md"
    : anchor.startsWith("eel_")
      ? "eel2-builtins.md"
      : anchor.startsWith("python_")
        ? "python-builtins.md"
        : undefined;

/** One entry name per file; `{reaper.array}.get` and the like are not valid file names. */
const fileName = (name: string) => name.replaceAll(/[^\w.-]/gu, "_");

export const renderApi = (api: Api, service: TurndownService) => {
  const names = new Set(api.functions.map((entry) => entry.name));
  const link = (prefix: string) => (anchor: string) =>
    names.has(anchor)
      ? `${prefix}functions/${fileName(anchor)}.md`
      : builtinFile(anchor) === undefined
        ? undefined
        : `${prefix}${builtinFile(anchor) ?? ""}#${anchor}`;
  const files = new Map<string, string>();
  for (const entry of api.functions)
    files.set(
      `functions/${fileName(entry.name)}.md`,
      [
        `# ${entry.name}`,
        "",
        ...entry.signatures.map(
          ({ label, signature }) => `${label}: \`${signature}\`  `,
        ),
        "",
        service.turndown(rewriteAnchors(entry.description, link("../"))),
        "",
      ].join("\n"),
    );
  for (const { language, file, entries } of api.builtins)
    files.set(
      file,
      [
        `# ReaScript/${language} built-in functions`,
        "",
        `Functions ${language} ReaScripts have beyond the [API functions](index.md).`,
        "",
        ...entries.flatMap(({ name, html }) => [
          `<a id="${name}"></a>`,
          "",
          `## ${name.replace(/^(?:lua|eel|python)_/u, "")}`,
          "",
          service.turndown(rewriteAnchors(html, link(""))),
          "",
        ]),
      ].join("\n"),
    );
  const introduction = fragment(api.introduction);
  // The per-language function lists are link tables inside `<code>`; the index replaces them.
  for (const table of introduction.querySelectorAll("code > table"))
    table.remove();
  for (const script of introduction.querySelectorAll("script")) script.remove();
  // Examples are `<code>` with `<br>` line breaks, which Markdown inline code collapses.
  for (const code of introduction.querySelectorAll("code")) {
    if (code.querySelector("br") === null) continue;
    for (const br of code.querySelectorAll("br"))
      br.replaceWith(introduction.createTextNode("\n"));
    // Each `<br>` is followed by the source's own line break.
    code.textContent = (code.textContent ?? "").replaceAll("\n\n", "\n").trim();
    const pre = introduction.createElement("pre");
    code.replaceWith(pre);
    pre.append(code);
  }
  files.set(
    "introduction.md",
    `${service.turndown(rewriteAnchors(introduction.body.innerHTML, link("")))}\n`,
  );
  const lua = (entry: ApiFunction) =>
    entry.signatures.find(({ label }) => label === "Lua") ??
    entry.signatures[0];
  files.set(
    "index.md",
    [
      `# REAPER API functions${api.version === undefined ? "" : ` (REAPER v${api.version})`}`,
      "",
      "One file per function in `functions/`, each with its Lua, C, EEL2 and Python signatures. Lua return values come first: `retval, name = reaper.GetTrackName(track)`.",
      "",
      "- [Introduction](introduction.md): calling conventions per language",
      ...api.builtins.map(
        ({ language, file }) => `- [${language} built-ins](${file})`,
      ),
      "- [Original page](reascripthelp.html)",
      "",
      "## Functions",
      "",
      ...api.functions.map((entry) => {
        const signature = lua(entry);
        return `- [${entry.name}](functions/${fileName(entry.name)}.md)${signature === undefined ? "" : `: \`${signature.signature}\``}`;
      }),
      "",
    ].join("\n"),
  );
  return files;
};

/** A REAPER site page's content: the `.light.strip` columns, without the site header and footer. */
export const pageMarkdown = (
  html: string,
  pathname: string,
  service: TurndownService,
) => {
  const { document } = parseHTML(
    html
      // Each page opens with a contents list of links to its own sections.
      .replaceAll(/^<li><a href="[^"]*#[^"]*">[^<]*<\/a>\s*$/gmu, "")
      // Section titles are a `top` link and bold text after a rule.
      .replaceAll(
        /<hr>\s*<font size=-2><a href="#">top<\/a><\/font>(?:&nbsp;|\s)*<font size=3><b><a name="[^"]*">(?<title>[\s\S]*?)<\/a><\/b><\/font>/gu,
        "<h2>$<title></h2>",
      )
      // Lists are bare `<li>`s with no closing tags or `<ul>`, so each would swallow the rest
      // of the page; make each item its own line.
      .replaceAll(/<\/?(?:ul|ol)>|<\/li>/giu, "")
      .replaceAll(/<li>/giu, "<br>- "),
  );
  const strips = [...document.querySelectorAll("div.strip")].filter(
    (strip) => strip.querySelector(".footitem") === null,
  );
  const content = strips.at(-1) ?? document.body;
  for (const anchor of content.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    if (!href.startsWith("#"))
      anchor.setAttribute("href", new URL(href, `${ORIGIN}${pathname}`).href);
  }
  for (const image of content.querySelectorAll("img[src]"))
    image.setAttribute(
      "src",
      new URL(image.getAttribute("src") ?? "", `${ORIGIN}${pathname}`).href,
    );
  return `<!-- Source: ${ORIGIN}${pathname} -->\n\n${service.turndown(content.innerHTML)}\n`;
};

export interface UsDocBloc {
  readonly fields: ReadonlyMap<string, string>;
  readonly functioncalls: readonly {
    readonly language: string;
    readonly code: string;
  }[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** USDocML indents its text to the XML's depth, in tabs and spaces mixed; strip the common indent. */
const dedent = (text: string) => {
  const lines = text.replaceAll("\t", "    ").replaceAll("\r", "").split("\n");
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.length - line.trimStart().length);
  const indent = Math.min(...indents, Number.MAX_SAFE_INTEGER);
  return lines
    .map((line) => line.slice(indent).trimEnd())
    .join("\n")
    .trim()
    .replaceAll(
      /&(?<entity>lt|gt|amp|quot|apos);/gu,
      (_, entity: string) => ENTITIES[entity] ?? "",
    );
};

/**
 * Ultraschall's USDocML: `<US_DocBloc>` elements whose children hold text, with Markdown in
 * descriptions. Descriptions contain stray HTML, so this matches each child to its own
 * closing tag rather than parsing XML.
 */
export const parseUsDoc = (xml: string): readonly UsDocBloc[] =>
  [...xml.matchAll(/<US_DocBloc\b[^>]*>(?<body>[\s\S]*?)<\/US_DocBloc>/gu)].map(
    (bloc) => {
      const fields = new Map<string, string>();
      const functioncalls: { language: string; code: string }[] = [];
      for (const match of (bloc.groups?.body ?? "").matchAll(
        /<(?<tag>\w+)(?<attributes>\s[^>]*)?>(?<text>[\s\S]*?)<\/\k<tag>>/gu,
      )) {
        const { tag = "", attributes = "", text = "" } = match.groups ?? {};
        if (tag === "functioncall")
          functioncalls.push({
            language:
              /prog_lang="(?<language>[^"]+)"/u.exec(attributes)?.groups
                ?.language ?? "",
            code: dedent(text),
          });
        else if (!fields.has(tag)) fields.set(tag, dedent(text));
      }
      return { fields, functioncalls };
    },
  );

const FENCES: Readonly<Record<string, string>> = {
  lua: "lua",
  cpp: "c",
  eel: "eel2",
  python: "python",
};

const listLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => `- ${line.trim()}`);

export const renderUsDocBloc = (bloc: UsDocBloc, level: number) => {
  const field = (name: string) => bloc.fields.get(name) ?? "";
  const slug = field("slug");
  const title = field("title") || slug;
  const chapter = field("chapter_context")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" > ");
  const requires = field("requires")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
  const facts = [
    title === slug ? "" : `Slug: \`${slug}\``,
    requires === "" ? "" : `Requires: ${requires}`,
    chapter === "" ? "" : `Chapter: ${chapter}`,
    field("tags") === "" ? "" : `Tags: ${field("tags")}`,
  ].filter(Boolean);
  const calls = bloc.functioncalls.toSorted(
    (left, right) =>
      Object.keys(FENCES).indexOf(left.language) -
      Object.keys(FENCES).indexOf(right.language),
  );
  return [
    `${"#".repeat(level)} ${title}`,
    "",
    ...(facts.length === 0
      ? []
      : [facts.map((fact) => `${fact}  `).join("\n"), ""]),
    ...calls.flatMap(({ language, code }) => [
      `\`\`\`${FENCES[language] ?? ""}`,
      code,
      "```",
      "",
    ]),
    ...(field("description") === "" ? [] : [field("description"), ""]),
    ...(field("retvals") === ""
      ? []
      : ["Returns:", "", ...listLines(field("retvals")), ""]),
    ...(field("parameters") === ""
      ? []
      : ["Parameters:", "", ...listLines(field("parameters")), ""]),
  ].join("\n");
};

const UltraschallTitles: Readonly<Record<string, string>> = {
  "config-variables.md": "REAPER config variables",
  "state-chunks.md": "REAPER state chunks",
  "web-interface.md": "REAPER web interface API",
  "video-processor.md": "REAPER video processor API",
};

/** The API documentation becomes one file per entry, like `api/`; every other document one file. */
export const renderUltraschall = (
  file: string,
  blocs: readonly UsDocBloc[],
) => {
  const files = new Map<string, string>();
  if (file !== "api") {
    files.set(
      file,
      [
        `# ${UltraschallTitles[file] ?? file}`,
        "",
        ...blocs.map((bloc) => renderUsDocBloc(bloc, 2)),
      ].join("\n"),
    );
    return files;
  }
  const index: string[] = [];
  // macOS file systems ignore case, so `GetTrack` and `getTrack` would share a file.
  const taken = new Set<string>();
  for (const bloc of blocs) {
    const slug = bloc.fields.get("slug") ?? "";
    if (slug === "") continue;
    let name = fileName(slug);
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1)
      name = `${fileName(slug)}-${String(suffix)}`;
    taken.add(name.toLowerCase());
    files.set(`api/${name}.md`, renderUsDocBloc(bloc, 1));
    const lua = bloc.functioncalls.find(({ language }) => language === "lua");
    const tags = bloc.fields.get("tags") ?? "";
    index.push(
      `- [${slug}](api/${name}.md)${tags === "" ? "" : ` (${tags})`}${lua === undefined ? "" : `: \`${lua.code.replaceAll("\n", " ")}\``}`,
    );
  }
  files.set(
    "api.md",
    [
      "# Ultraschall's REAPER API documentation",
      "",
      "Includes SWS, js_ReaScriptAPI, ReaImGui and other extension functions; each entry's `Requires:` names them.",
      "",
      ...index,
      "",
    ].join("\n"),
  );
  return files;
};

const writeFiles = Effect.fnUntraced(function* (
  directory: string,
  files: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [file, content] of files) {
    const target = path.join(directory, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
  }
});

const extractArchive = Effect.fn("ReaperDocs.extractArchive")(function* (
  staging: string,
  repository: string,
  branch: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(staging, directory);
  yield* fs.makeDirectory(target, { recursive: true });
  const archive = yield* fs.makeTempFileScoped();
  yield* Process.run(staging, "curl", [
    "-fsSL",
    `https://codeload.github.com/${repository}/tar.gz/refs/heads/${branch}`,
    "-o",
    archive,
  ]);
  yield* Process.run(staging, "tar", [
    "-xzf",
    archive,
    "-C",
    target,
    "--strip-components=1",
  ]);
  yield* Console.log(`reaper-docs: ${repository} → ${directory}/`);
}, Effect.scoped);

/** all2md links saved images by absolute path; the snapshot moves, so link them relatively. */
export const relativeImages = (markdown: string) =>
  markdown.replaceAll(/\]\([^)\s]*\/images\//gu, "](images/");

/**
 * The Cockos guides number their chapters, and all2md renders a chapter title as a bold
 * heading: `## **1** **Setting Up and Getting Started**` in the user guide,
 * `#### **2. ReaComp**` in the effects guide. Section headings (`**1.1**`) do not match, and
 * contents entries are dotted leaders to a page number. A number no greater than the last is a
 * repeat, not a new chapter.
 */
export const splitChapters = (markdown: string) => {
  const lines = markdown.split("\n");
  const starts: { line: number; number: number; title: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const match =
      /^#{1,6} \*\*(?<number>\d+)(?:\*\* \*\*|\.\s+)(?<title>[^*]+?)\s*\*\*\s*$/u.exec(
        line,
      );
    const number = Number(match?.groups?.number);
    const last = starts.at(-1);
    if (
      match?.groups?.title !== undefined &&
      !match.groups.title.includes("....") &&
      number > (last?.number ?? 0)
    ) {
      starts.push({ line: index, number, title: match.groups.title });
      continue;
    }
    // all2md sometimes folds a chapter's title page into a table cell
    // (`| 5 Project Arrangement Basics 5.1 Managing Tracks …`), so the chapter shows first as
    // a section heading (`**5.2**`). It starts on the page holding that cell.
    const section = /^#{1,6} \*\*(?<number>\d+)\.\d+\*\*/u.exec(line);
    const missed = Number(section?.groups?.number);
    if (last === undefined || missed !== last.number + 1) continue;
    const title = new RegExp(
      `(?:^|[|\\s])${String(missed)} (?<title>[A-Z][^|*]*?) ${String(missed)}\\.1\\b`,
      "u",
    );
    let chapterStart = index;
    let found = "";
    for (let back = index - 1; back > last.line; back -= 1) {
      const cell = title.exec(lines[back] ?? "");
      if (cell?.groups?.title === undefined) continue;
      found = cell.groups.title;
      chapterStart = back;
      while (
        chapterStart > last.line + 1 &&
        !(lines[chapterStart - 1] ?? "").startsWith("<!-- PDF page")
      )
        chapterStart -= 1;
      break;
    }
    starts.push({
      line: chapterStart,
      number: missed,
      title: found === "" ? `chapter ${String(missed)}` : found,
    });
  }
  const files = new Map<string, string>();
  if (starts.length < 2) return files;
  const slug = (title: string) =>
    title
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "");
  const pad = (number: number) => String(number).padStart(2, "0");
  const chapter = (from: number, to: number | undefined) =>
    `${lines
      .slice(from, to)
      .join("\n")
      .replaceAll("](images/", "](../images/")
      .trim()}\n`;
  files.set("00-front-matter.md", chapter(0, starts[0]?.line));
  for (const [index, start] of starts.entries())
    files.set(
      `${pad(start.number)}-${slug(start.title)}.md`,
      chapter(start.line, starts[index + 1]?.line),
    );
  return files;
};

/**
 * all2md writes the whole PDF as one Markdown file with its images in `images/`, dropping
 * each page's running header and footer and marking each page with `<!-- PDF page N -->`.
 * Numbered chapters are split into `chapters/`; the whole conversion is kept too, for
 * searches that cross chapters.
 */
const convertGuide = Effect.fn("ReaperDocs.convertGuide")(function* (
  staging: string,
  name: string,
  url: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(staging, "guides", name);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFile(
    path.join(directory, "original.pdf"),
    yield* requestBytes(url),
  );
  yield* Console.log(`reaper-docs: converting ${path.basename(url)}`);
  const file = path.join(directory, `${name}.md`);
  yield* Process.run(directory, "all2md", [
    "original.pdf",
    "-o",
    file,
    "--attachment-mode",
    "save",
    "--attachment-output-dir",
    "images",
    "--pdf-auto-trim-headers-footers",
    "--pdf-include-page-numbers",
    "--pdf-page-separator-template",
    "PDF page {page_num}",
  ]).pipe(
    Effect.mapError(
      (cause) =>
        new ReaperDocsError({
          message: `all2md could not convert ${path.basename(url)}; install it with \`uv tool install 'all2md[pdf]'\``,
          cause,
        }),
    ),
  );
  const markdown = relativeImages(yield* fs.readFileString(file));
  yield* fs.writeFileString(file, markdown);
  const chapters = splitChapters(markdown);
  yield* writeFiles(path.join(directory, "chapters"), chapters);
  yield* Console.log(
    `reaper-docs: ${name} converted, ${String(chapters.size)} chapter files`,
  );
  return { name, source: url, chapters: chapters.size };
});

const readme = (
  version: string | undefined,
  fetchedAt: string,
  guides: readonly {
    readonly name: string;
    readonly source: string;
    readonly chapters: number;
  }[],
) =>
  [
    "# REAPER documentation",
    "",
    `Fetched ${fetchedAt}${version === undefined ? "" : ` for REAPER v${version}`} by \`vpx ~/Projects/tools/refs.ts sync reaper-docs\`. A sync replaces this directory; keep no edits here.`,
    "",
    "## Official (Cockos)",
    "",
    "- `api/`: the ReaScript API reference, split from https://www.reaper.fm/sdk/reascript/reascripthelp.html. Start at `api/index.md`; one file per function in `api/functions/`, with Lua, C, EEL2 and Python signatures. `api/lua-builtins.md` holds `reaper.defer`, `gfx.*` and the other Lua-only functions; `api/eel2-builtins.md` the EEL2 ones, including its `tcp_*` sockets. REAPER's Help > ReaScript documentation writes the same page locally, plus the functions installed extensions add.",
    "- `sdk/`: https://github.com/justinfrankel/reaper-sdk. `sdk/sdk/reaper_plugin_functions.h` declares every API function with C types and doc comments; `reaper_plugin.h` the extension interfaces; `reaper-plugins/reaper_csurf/` the control surface and OSC examples.",
    "- `pages/`: the ReaScript, extension SDK, OSC and VST extension pages of reaper.fm.",
    "- `pages/jsfx/`: JSFX (REAPER's scripted audio and MIDI effects) programming reference.",
    ...guides.map(
      ({ name, source, chapters }) =>
        `- \`guides/${name}/\`: ${source}, converted with all2md: \`${name}.md\` whole${chapters === 0 ? "" : ", `chapters/` one file per numbered chapter"}, \`images/\`, and \`original.pdf\`. \`<!-- PDF page N -->\` marks each PDF page. PDF text extraction misdecodes some characters; check the PDF for exact wording.`,
    ),
    "",
    "## Community",
    "",
    "- `community/reateam-doc/`: https://github.com/ReaTeam/Doc. State chunk definitions (`State Chunk Definitions`), REAPER's command line, web interface modding, video processor API. Its `reascripthelp.html` is a REAPER 6.09 copy; use `api/`.",
    "- `community/ultraschall/`: Ultraschall's documentation of REAPER (https://github.com/Ultraschall/ultraschall-lua-api-for-reaper), as of its API 5.3 release (May 2025): `api.md` and `api/` cover the REAPER API with SWS, js_ReaScriptAPI and ReaImGui functions, named parameters and return values; `config-variables.md` the `reaper.ini` and project config variables `get_config_var_string` reads; `state-chunks.md` the track, item and envelope state chunk formats; `web-interface.md` REAPER's built-in HTTP web remote. Unofficial, and older than `api/`. `source/` keeps the USDocML.",
    "- `examples/reascripts/`: https://github.com/ReaTeam/ReaScripts, the ReaPack community script repository. Grep it for working calls.",
    "",
    "## Lua",
    "",
    "- `lua/manual.md`: the Lua 5.4 reference manual, the version REAPER 7 embeds.",
    "",
  ].join("\n");

/**
 * Collect REAPER's scripting documentation: Cockos's API reference, SDK, developer pages and
 * PDF guides; the ReaTeam and Ultraschall community documentation; ReaTeam's script
 * repository; and the Lua manual. Every source is required; any failure rejects the snapshot.
 * @see https://www.reaper.fm/sdk/reascript/reascript.php
 */
export const downloadInto = Effect.fn("ReaperDocs.downloadInto")(function* (
  staging: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = turndown();

  const apiHtml = yield* requestText(`${ORIGIN}${API_PAGE}`);
  const api = parseApi(apiHtml);
  if (api.functions.length === 0)
    return yield* new ReaperDocsError({
      message: `No API functions found in ${ORIGIN}${API_PAGE}`,
    });
  const apiDirectory = path.join(staging, "api");
  yield* writeFiles(apiDirectory, renderApi(api, service));
  yield* fs.writeFileString(
    path.join(apiDirectory, "reascripthelp.html"),
    apiHtml,
  );
  yield* Console.log(
    `reaper-docs: ${String(api.functions.length)} API functions (REAPER v${api.version ?? "unknown"})`,
  );

  const jsfxIndex = yield* requestText(`${ORIGIN}${JSFX_INDEX}`);
  const jsfx = [
    ...new Set(
      [...jsfxIndex.matchAll(/href=['"](?<page>[a-z_]+\.php)/gu)].map(
        (match) => match.groups?.page ?? "",
      ),
    ),
  ].map((page) => ({
    pathname: `/sdk/js/${page}`,
    file: `pages/jsfx/${page.replace(/\.php$/u, ".md")}`,
  }));
  const pages = yield* Effect.forEach(
    [...PAGES, ...jsfx],
    ({ pathname, file }) =>
      requestText(`${ORIGIN}${pathname}`).pipe(
        Effect.map(
          (html) => [file, pageMarkdown(html, pathname, service)] as const,
        ),
      ),
    { concurrency: CONCURRENCY },
  );
  yield* writeFiles(staging, new Map(pages));
  yield* Console.log(`reaper-docs: ${String(pages.length)} site pages`);

  const lua = parseHTML(yield* requestText(LUA_MANUAL)).document;
  yield* writeFiles(
    staging,
    new Map([
      [
        "lua/manual.md",
        `<!-- Source: ${LUA_MANUAL} -->\n\n${service.turndown(lua.body?.innerHTML ?? "")}\n`,
      ],
    ]),
  );

  const ultraschall = path.join(staging, "community", "ultraschall");
  yield* Effect.forEach(
    ULTRASCHALL_DOCS,
    ({ source, file }) =>
      Effect.gen(function* () {
        const xml = yield* requestText(`${ULTRASCHALL}/${source}`);
        yield* writeFiles(
          ultraschall,
          new Map([
            [`source/${source}`, xml],
            ...renderUltraschall(file, parseUsDoc(xml)),
          ]),
        );
      }),
    { concurrency: CONCURRENCY },
  );
  yield* Console.log("reaper-docs: Ultraschall documentation");

  yield* Effect.forEach(ARCHIVES, ({ repository, branch, directory }) =>
    extractArchive(staging, repository, branch, directory),
  );

  const guidesPage = yield* requestText(`${ORIGIN}${USER_GUIDES_PAGE}`);
  const guides = yield* Effect.forEach(
    GUIDES,
    ({ pattern, name }) => {
      const href = pattern.exec(guidesPage)?.[0];
      return href === undefined
        ? Effect.fail(
            new ReaperDocsError({
              message: `No ${name} PDF linked from ${ORIGIN}${USER_GUIDES_PAGE}`,
            }),
          )
        : convertGuide(staging, name, `${ORIGIN}/${href}`);
    },
    { concurrency: GUIDES.length },
  );

  const fetchedAt = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
  yield* fs.writeFileString(
    path.join(staging, "README.md"),
    readme(api.version, fetchedAt, guides),
  );
}, Effect.provide(FetchHttpClient.layer));
