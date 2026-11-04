import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import * as Array from "effect/Array";
import * as Console from "effect/Console";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";

import { runCommand } from "#devkit/core/command.ts";

export class AgentChromeError extends Schema.TaggedError<AgentChromeError>()(
  "AgentChromeError",
  {
    message: Schema.String,
  },
) {}

/**
 * The agent Chrome: one Chrome per machine that agents drive, with its own profile, logged in to
 * Shopify once by a person. It is not the person's own Chrome, which listens on 9222 for the
 * chrome-devtools MCP's `--autoConnect` and asks before every new connection. A debugging port on
 * a separate profile never asks, so an agent can drive it with nobody at the laptop. Every project
 * and checkout on the machine shares it, so one Shopify login covers every store.
 */
export const AGENT_CDP = "http://127.0.0.1:9333";
/** @see https://specifications.freedesktop.org/basedir-spec/latest/ */
const AGENT_PROFILE = path.join(
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- the XDG spec reads an empty XDG_DATA_HOME as unset
  process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
  "agent-chrome-for-testing",
);
/**
 * Chrome for Testing (`vp exec playwright install chromium`), not Google Chrome: macOS routes a
 * Dock click or a link from another app by bundle id, so an agent Chrome sharing Google Chrome's
 * bundle takes them, windowless, whenever the person's own Chrome is closed.
 */
const CHROME_BINARY = chromium.executablePath();
const CHROME_APP = CHROME_BINARY.slice(
  0,
  CHROME_BINARY.indexOf(".app/") + ".app".length,
);

/**
 * Both modes share the profile, so the login a person makes headed is the one agents use headless.
 * `--user-data-dir` comes first because {@link agentChromePids} matches the command line by its
 * prefix. Agents mostly work in background tabs, where Chrome otherwise slows timers and rendering.
 */
const AGENT_FLAGS = [
  `--user-data-dir=${AGENT_PROFILE}`,
  "--remote-debugging-port=9333",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  // Chrome for Testing has no keychain item of its own; the profile's cookies are keyed in it.
  "--use-mock-keychain",
];

/**
 * How the agent Chrome runs. Headless is the default, so agents never put a window in front of the
 * person at the laptop. Headed is only for a person logging in ({@link loginAgentChrome}). Chrome
 * locks a profile to one process, so changing mode means quitting and relaunching, which closes
 * every agent's tabs.
 */
type AgentChromeMode = "headless" | "headed";

const ChromeVersion = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.TemplateLiteralParser([
      Schema.Int,
      ".",
      Schema.Int,
      ".",
      Schema.Int,
      ".",
      Schema.Int,
    ]),
  ),
);

/**
 * Shopify's Cloudflare check answers a `HeadlessChrome` user agent with its "Just a moment..." page
 * instead of the admin. Chrome's reduced user agent freezes the macOS version and every part of
 * the version but the major, so this is the string the installed Chrome sends when headed.
 */
const headedUserAgent = runCommand("defaults", [
  "read",
  `${CHROME_APP}/Contents/Info`,
  "CFBundleShortVersionString",
]).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(ChromeVersion)),
  Effect.map(
    ([major]) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(major)}.0.0.0 Safari/537.36`,
  ),
  Effect.mapError(
    () =>
      new AgentChromeError({
        message: `Could not read Chrome's version from ${CHROME_APP}.`,
      }),
  ),
);

/**
 * Headless runs Chrome's binary directly, detached: `open` would register it with Launch Services,
 * which puts it in the Dock and the app switcher. Headed goes through `open -na` so its window
 * comes to the front for the person who has to log in.
 */
const launchAgentChrome = Effect.fn("AgentChrome.launch")(function* (
  mode: AgentChromeMode,
  url?: string,
) {
  const urls = url === undefined ? [] : [url];
  yield* Match.value(mode)
    .pipe(
      Match.when("headless", () =>
        Effect.gen(function* () {
          const userAgent = yield* headedUserAgent;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              CHROME_BINARY,
              [
                ...AGENT_FLAGS,
                "--headless=new",
                "--window-size=1440,900",
                `--user-agent=${userAgent}`,
                ...urls,
              ],
              {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
              },
            ),
          );
          // Unreferenced, Chrome outlives this command's scope.
          yield* handle.unref;
        }).pipe(Effect.scoped),
      ),
      Match.when("headed", () =>
        runCommand("open", [
          "-na",
          CHROME_APP,
          "--args",
          ...AGENT_FLAGS,
          ...urls,
        ]),
      ),
      Match.exhaustive,
    )
    .pipe(
      Effect.mapError(
        () =>
          new AgentChromeError({
            message: `Could not launch the agent Chrome ${mode}.`,
          }),
      ),
    );
  yield* cdp("/json/version").pipe(
    Effect.retry(
      Schedule.max([
        Schedule.spaced("500 millis"),
        Schedule.during("20 seconds"),
      ]),
    ),
  );
});

/**
 * Only the main process's command line carries the debugging port. Never quit Chrome by app name:
 * the person's own Chrome is "Google Chrome".
 */
const agentChromePids = runCommand("pgrep", [
  "-f",
  "remote-debugging-port=9333",
]).pipe(
  Effect.map((stdout) => stdout.split("\n").filter((line) => line !== "")),
  // pgrep exits 1 when nothing matches.
  Effect.orElseSucceed(() => []),
);

/** `Browser.close` writes the cookie store out before Chrome exits. */
const closeOverCdp = Effect.acquireUseRelease(
  Effect.tryPromise(() => chromium.connectOverCDP(AGENT_CDP)),
  (browser) =>
    Effect.tryPromise(async () => {
      const session = await browser.newBrowserCDPSession();
      // The connection drops as Chrome exits, so the reply may never come.
      await session.send("Browser.close").catch(() => undefined);
    }),
  (browser) => Effect.promise(() => browser.close().catch(() => undefined)),
).pipe(Effect.ignore);

const exitedWithin = (within: Duration.Input) =>
  agentChromePids.pipe(
    Effect.repeat({
      until: (left) => left.length === 0,
      schedule: Schedule.max([
        Schedule.spaced("250 millis"),
        Schedule.during(within),
      ]),
    }),
    Effect.map((left) => left.length === 0),
  );

/** SIGTERM exits without writing out cookies set since Chrome's last periodic write, so it is only the fallback. */
const stopAgentChrome = Effect.gen(function* () {
  if ((yield* agentChromePids).length === 0) return;
  yield* closeOverCdp;
  if (yield* exitedWithin("10 seconds")) return;
  yield* runCommand("kill", ["-TERM", ...(yield* agentChromePids)]).pipe(
    Effect.ignore,
  );
  if (yield* exitedWithin("20 seconds")) return;
  return yield* new AgentChromeError({
    message: "The agent Chrome did not quit within 30 seconds.",
  });
});

const SHOPIFY_URLS = [
  "https://admin.shopify.com",
  "https://accounts.shopify.com",
];

const CdpTarget = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  title: Schema.String,
});
const decodeTarget = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CdpTarget),
);
const decodeTargets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CdpTarget)),
);

const cdp = (route: string, method: "GET" | "PUT" = "GET") =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${AGENT_CDP}${route}`, {
        method,
        signal: AbortSignal.timeout(5000),
      });
      return response.ok
        ? await response.text()
        : Promise.reject(new Error(response.statusText));
    },
    catch: () =>
      new AgentChromeError({
        message: `The agent Chrome is not answering on ${AGENT_CDP}.`,
      }),
  });

/**
 * A running one is left in whatever mode it is in: switching would close other agents' tabs.
 * Returns whether it was started, because a chrome-devtools server attached to the previous Chrome
 * has to be restarted.
 */
export const ensureAgentChrome = Effect.gen(function* () {
  if (
    yield* cdp("/json/version").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  ) {
    return false;
  }
  yield* launchAgentChrome("headless");
  return true;
});

export const isStoreAdmin = (
  store: string,
  target: { readonly url: string; readonly title: string },
) => {
  if (!URL.canParse(target.url)) return false;
  const { hostname, pathname } = new URL(target.url);
  return (
    hostname === "admin.shopify.com" &&
    (pathname === `/store/${store}` ||
      pathname.startsWith(`/store/${store}/`)) &&
    target.title.includes(" · ") &&
    target.title.endsWith(" · Shopify")
  );
};

/** Never fails: it only adds detail to a failure already on its way. */
const tabShows = (targetId: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => chromium.connectOverCDP(AGENT_CDP)),
    (browser) =>
      Effect.tryPromise(async () => {
        for (const page of browser
          .contexts()
          .flatMap((context) => context.pages())) {
          const session = await page.context().newCDPSession(page);
          const { targetInfo } = await session.send("Target.getTargetInfo");
          await session.detach();
          if (targetInfo.targetId !== targetId) continue;
          const text = await page.evaluate(() => document.body.textContent);
          return `title "${await page.title()}", text "${text.replaceAll(/\s+/gu, " ").trim().slice(0, 500)}"`;
        }
        throw new Error("tab not found");
      }),
    // Closing a browser connected over CDP only disconnects; the agent Chrome keeps running.
    (browser) => Effect.promise(() => browser.close()),
  ).pipe(Effect.option);

/**
 * Logged in, the admin titles
 * the page `<store name> · <page> · Shopify` at `admin.shopify.com/store/<store>` (the name is the
 * handle for the `mw10013` stores and a display name, "Sandbox Shop 01", for the Partner
 * organization's, so the URL names the store); a lapsed login lands on accounts.shopify.com, titled
 * "Log in — Shopify". Neither the first URL nor an early title tells them apart: Chrome titles a
 * loading tab with its URL, and a lapsed login passes through `admin.shopify.com/login` first.
 * Only a person may sign in, so a lapse fails for them to fix.
 */
export const checkShopifyLogin = Effect.fn("AgentChrome.checkShopifyLogin")(
  function* (store: string) {
    const unreadable = () =>
      new AgentChromeError({
        message: `The agent Chrome on ${AGENT_CDP} gave an unreadable tab list.`,
      });
    const loggedIn = (target: typeof CdpTarget.Type) =>
      isStoreAdmin(store, target);
    // A tab Chrome has just opened can list an empty URL until its first navigation commits.
    const loggedOut = (target: typeof CdpTarget.Type) =>
      URL.canParse(target.url) &&
      new URL(target.url).hostname === "accounts.shopify.com";
    const opened = yield* cdp(
      `/json/new?${encodeURI(`https://admin.shopify.com/store/${store}`)}`,
      "PUT",
    ).pipe(
      Effect.flatMap((text) =>
        decodeTarget(text).pipe(Effect.mapError(unreadable)),
      ),
    );
    const { landed, shows } = yield* Effect.gen(function* () {
      const landed = yield* cdp("/json/list").pipe(
        Effect.flatMap((text) =>
          decodeTargets(text).pipe(Effect.mapError(unreadable)),
        ),
        Effect.map(Array.findFirst((target) => target.id === opened.id)),
        Effect.repeat({
          until: Option.exists(
            (target) => loggedIn(target) || loggedOut(target),
          ),
          schedule: Schedule.max([
            Schedule.spaced("500 millis"),
            Schedule.during("20 seconds"),
          ]),
        }),
      );
      // A tab still loading is read before it closes, so the failure says what held it.
      const shows = Option.exists(
        landed,
        (target) => loggedIn(target) || loggedOut(target),
      )
        ? Option.none<string>()
        : yield* tabShows(opened.id);
      return { landed, shows };
    }).pipe(
      Effect.ensuring(cdp(`/json/close/${opened.id}`).pipe(Effect.ignore)),
    );
    if (Option.exists(landed, loggedIn)) return;
    return yield* new AgentChromeError({
      message: Option.exists(landed, loggedOut)
        ? "The agent Chrome is not logged in to Shopify. A person runs vp run browser login and logs in at the window it opens."
        : `The Shopify admin did not finish loading in the agent Chrome within 20 seconds (${Option.match(landed, { onNone: () => "tab gone", onSome: (target) => target.url })}). The tab showed ${Option.getOrElse(shows, () => "nothing readable")}.`,
    });
  },
);

/**
 * Run by a person, never an agent: the relaunches close every agent's tabs. The wait watches the
 * window's own tab rather than opening check tabs in front of someone typing a password.
 */
export const loginAgentChrome = Effect.fn("AgentChrome.login")(function* (
  store: string,
) {
  yield* ensureAgentChrome;
  if (
    yield* checkShopifyLogin(store).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  ) {
    yield* Console.log("The agent Chrome is already logged in to Shopify.");
    return;
  }
  yield* stopAgentChrome;
  yield* launchAgentChrome(
    "headed",
    `https://admin.shopify.com/store/${store}`,
  );
  yield* Console.log(
    "Log in to Shopify in the agent Chrome's window. Waiting up to 10 minutes.",
  );
  const loggedIn = yield* cdp("/json/list").pipe(
    Effect.flatMap(decodeTargets),
    Effect.map(Array.some((target) => isStoreAdmin(store, target))),
    Effect.orElseSucceed(() => false),
    Effect.repeat({
      until: (done) => done,
      schedule: Schedule.max([
        Schedule.spaced("1 second"),
        Schedule.during("10 minutes"),
      ]),
    }),
  );
  if (!loggedIn) {
    return yield* new AgentChromeError({
      message:
        "No Shopify login within 10 minutes. The agent Chrome stays headed until it is quit; run vp run browser login again.",
    });
  }
  yield* stopAgentChrome;
  yield* launchAgentChrome("headless");
  yield* checkShopifyLogin(store);
  yield* Console.log("Logged in. The agent Chrome runs headless again.");
});

/** Where the agent Chrome's exported Shopify login lives; it holds a login, so it stays under `playwright/.auth/`. */
export const storageStatePath = "playwright/.auth/shopify-admin.json";

/**
 * Reads the live browser, which renews the session itself, so the copy is as fresh as the agent
 * Chrome.
 */
export const exportShopifyAdminAuth = Effect.fn(
  "AgentChrome.exportShopifyAdminAuth",
)(function* ({
  output,
  store,
}: {
  readonly output: string;
  readonly store: string;
}) {
  yield* ensureAgentChrome;
  yield* checkShopifyLogin(store);
  const cookies = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => chromium.connectOverCDP(AGENT_CDP),
      catch: () =>
        new AgentChromeError({
          message: `Playwright could not connect to ${AGENT_CDP}.`,
        }),
    }),
    (browser) =>
      Effect.tryPromise({
        try: () =>
          Option.match(Array.head(browser.contexts()), {
            onNone: () => Promise.reject(new Error("no default context")),
            onSome: (context) => context.cookies(SHOPIFY_URLS),
          }),
        catch: () =>
          new AgentChromeError({
            message: "Could not read the agent Chrome's Shopify cookies.",
          }),
      }),
    // Closing a browser connected over CDP only disconnects; the agent Chrome keeps running.
    (browser) => Effect.promise(() => browser.close()),
  );
  const fs = yield* FileSystem.FileSystem;
  const parent = path.dirname(output);
  yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
  const staged = path.join(
    parent,
    `.${path.basename(output)}.${String(process.pid)}`,
  );
  yield* fs.writeFileString(
    staged,
    JSON.stringify({ cookies, origins: [] }, null, 2),
    {
      mode: 0o600,
    },
  );
  yield* fs.rename(staged, output);
  return cookies.length;
});
