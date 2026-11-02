# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: embedded/workflows.spec.ts >> the editor counts instructions down from 300 and refuses 501 on save
- Location: test/e2e/embedded/workflows.spec.ts:534:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('iframe[src*="embedded=1"]:not([src*="chrome=window"])').contentFrame().locator('s-page[heading="E2E Ring 31b437a80"]')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" locator('iframe[src*="embedded=1"]:not([src*="chrome=window"])').contentFrame().locator('s-page[heading="E2E Ring 31b437a80"]') with timeout 10000ms
  - waiting for locator('iframe[src*="embedded=1"]:not([src*="chrome=window"])').contentFrame().locator('s-page[heading="E2E Ring 31b437a80"]')

```

```yaml
- status
- status
- link "Skip to content":
  - /url: "#AppFrameMain"
  - strong: Skip to content
- img "Shopify"
- button "Collapse navigation" [expanded]
- button "Search"
- navigation:
  - list:
    - listitem:
      - link "Home":
        - /url: /store/mw10013-pool-07
    - listitem:
      - link "Orders":
        - /url: /store/mw10013-pool-07/orders
    - listitem:
      - link "Products":
        - /url: /store/mw10013-pool-07/products
    - listitem:
      - link "Customers":
        - /url: /store/mw10013-pool-07/customers
    - listitem:
      - link "Growth":
        - /url: /store/mw10013-pool-07/growth
    - listitem:
      - link "Discounts":
        - /url: /store/mw10013-pool-07/discounts
    - listitem:
      - link "Content":
        - /url: /store/mw10013-pool-07/content/metaobjects
    - listitem:
      - link "Markets":
        - /url: /store/mw10013-pool-07/markets
    - listitem:
      - link "Finance":
        - /url: /store/mw10013-pool-07/finance
    - listitem:
      - link "Analytics":
        - /url: /store/mw10013-pool-07/analytics
  - list:
    - listitem:
      - button "Sales channels"
      - list:
        - button "Online Store":
          - list:
            - listitem:
              - link "Online Store":
                - /url: /store/mw10013-pool-07/themes?appLoadId=75c4a687-0f6f-475e-9d6f-76d896913d2d
        - button "Agentic":
          - list:
            - listitem:
              - link "Agentic":
                - /url: /store/mw10013-pool-07/apps/agentic?appLoadId=86a7d3a7-53aa-4d52-8fd7-5e7f6ae8ad20
      - status
    - listitem:
      - button "Apps"
      - list:
        - listitem:
          - list:
            - listitem:
              - link "Baton Dev" [expanded]:
                - /url: /store/mw10013-pool-07/apps/baton-local?appLoadId=95b860c2-2f04-4601-9eaa-594662d47a03
              - button "Pin to your navigation": •
              - list:
                - listitem:
                  - link "Orders":
                    - /url: /store/mw10013-pool-07/apps/baton-local/app/orders
                - listitem:
                  - link "Workflows":
                    - /url: /store/mw10013-pool-07/apps/baton-local/app/workflows
                - listitem:
                  - link "Teams":
                    - /url: /store/mw10013-pool-07/apps/baton-local/app/teams
                - listitem:
                  - link "Members":
                    - /url: /store/mw10013-pool-07/apps/baton-local/app/members
      - status
  - list:
    - listitem:
      - link "Settings":
        - /url: /store/mw10013-pool-07/settings
    - listitem:
      - button "Michael Wu":
        - paragraph: mw10013-pool-07
        - text: dev
      - button "Alerts Feed - 0 unread alerts"
- main:
  - button "Create workflow"
  - button "More actions"
  - iframe
  - status
- status
- region "Sidekick":
  - status
  - paragraph
  - button "Close" [disabled]
  - img
  - textbox "Work with Sidekick"
  - button "Add files and more"
  - button "Dictate"
  - button "Open Sidekick"
  - status
- button "Maximize Dev Console":
  - img "Developer Console Logo"
  - text: dev previews (1)
- img "Custom icon"
- heading "Dev Console" [level=2]
- button "open"
- 'button "Baton Dev mw10013@gmail.com Connected updated: 13 minutes ago Clean dev preview ···"':
  - paragraph: Baton Dev
  - paragraph: mw10013@gmail.com
  - img "Connected"
  - paragraph: "updated: 13 minutes ago"
  - button "Clean dev preview"
  - button "···"
- table:
  - rowgroup:
    - row "Handle Type Previews":
      - columnheader "Handle"
      - columnheader "Type"
      - columnheader "Previews"
      - columnheader
  - rowgroup:
    - row "Baton Dev -- Web Mobile":
      - cell "Baton Dev"
      - cell "--"
      - cell "Web Mobile":
        - link "Web":
          - /url: /store/mw10013-pool-07/apps/baton-local
        - button "Mobile"
      - cell
    - row "baton-order-link Admin Link --":
      - cell "baton-order-link"
      - cell "Admin Link"
      - cell "--"
      - cell
    - row "privacy_compliance_webhooks Privacy Compliance Webhooks --":
      - cell "privacy_compliance_webhooks"
      - cell "Privacy Compliance Webhooks"
      - cell "--"
      - cell
- separator "Resize sidebar"
- complementary "Sidekick"
- status
- alert
```

# Test source

```ts
  1   | import type { BrowserContext, FrameLocator, Page } from "playwright/test";
  2   | 
  3   | import * as Schema from "effect/Schema";
  4   | import { ShopFixtureData } from "#contract/fixture.ts";
  5   | import {
  6   |   noteCountFrom,
  7   |   TASK_INSTRUCTIONS_MAX_LENGTH,
  8   |   WORKFLOW_STATE_LABEL,
  9   | } from "#domain/shop-work.ts";
  10  | import { control, expect, type Run, test, testEmail } from "#test/e2e/fixtures.ts";
  11  | import { E2E_SHOP as shop } from "#test/e2e/shop-fixture.ts";
  12  | import {
  13  |   awaitHydration,
  14  |   clickHoisted,
  15  |   closeEditor,
  16  |   editorFrame,
  17  |   gotoApp,
  18  |   hoistedEnabled,
  19  |   openApp,
  20  |   openEditor,
  21  | } from "./app.ts";
  22  | 
  23  | /**
  24  |  * The workflows index, the workflow page and the editor on the e2e store. The specs run in
  25  |  * parallel on one store, so each test names its workflows, tags and teams from its test id, adds them with `AddToFixture`, and
  26  |  * asserts on nothing it did not add.
  27  |  */
  28  | test.describe.configure({ mode: "serial" });
  29  | 
  30  | let context: BrowserContext;
  31  | let page: Page;
  32  | let frame: FrameLocator;
  33  | 
  34  | test.beforeAll(async ({ browser }) => {
  35  |   ({ context, page } = await openApp(browser));
  36  | });
  37  | 
  38  | test.afterAll(async () => {
  39  |   await context.close();
  40  | });
  41  | 
  42  | /** The test's own tail for names and tags: its id and its retry, so a retry adds afresh. */
  43  | const own = () => {
  44  |   const { testId, retry } = test.info();
  45  |   return `${testId.slice(-8)}${String(retry)}`;
  46  | };
  47  | 
  48  | /**
  49  |  * Adds `parts` beside the store's data, decoded as the fixture decodes them; a clash fails the
  50  |  * test, the names being its own.
  51  |  */
  52  | const add = (backend: Run, parts: Record<string, unknown>) =>
  53  |   backend(
  54  |     control((c) =>
  55  |       c.AddToFixture({
  56  |         shop,
  57  |         fixture: Schema.decodeUnknownSync(ShopFixtureData)({
  58  |           members: [],
  59  |           teams: [],
  60  |           workflows: [],
  61  |           orders: [],
  62  |           ...parts,
  63  |         }),
  64  |       }),
  65  |     ),
  66  |   );
  67  | 
  68  | /** A team with one member of the test's own, for tasks that need a team someone is on. */
  69  | const benchOf = (name: string) => ({
  70  |   members: [testEmail("workflows")],
  71  |   teams: [{ name, members: [testEmail("workflows")] }],
  72  | });
  73  | 
  74  | /**
  75  |  * A More actions menu item. The title-bar button is hoisted into the admin chrome, and the menu
  76  |  * it opens is not reachable from either document (see `teams.spec.ts`), so the in-frame
  77  |  * `s-button` inside the `s-menu` is clicked natively, which fires its `commandFor` as the host's
  78  |  * menu would.
  79  |  */
  80  | const clickMenuItem = (name: string) =>
  81  |   frame.locator("s-menu#workflow-actions s-button", { hasText: name }).evaluate((el) => {
  82  |     (el as HTMLElement).click();
  83  |   });
  84  | 
  85  | /** Searches the workflows index for `q`, submitted on Enter. */
  86  | const searchWorkflows = async (q: string) => {
  87  |   const search = frame.getByRole("searchbox", { name: "Search" });
  88  |   await search.fill(q);
  89  |   await search.press("Enter");
  90  | };
  91  | 
  92  | /** Opens the workflow called `name` from the workflows index, through its search. */
  93  | const openWorkflow = async (name: string, q: string) => {
  94  |   await searchWorkflows(q);
  95  |   await frame.getByRole("link", { name, exact: true }).click();
> 96  |   await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();
      |                                                            ^ Error: expect(locator).toBeVisible() failed
  97  | };
  98  | 
  99  | test("creating a workflow with a taken tag is refused under the field and names the holder", async ({
  100 |   backend,
  101 | }) => {
  102 |   const id = own();
  103 |   const team = `E2E Bench ${id}`;
  104 |   const holder = `E2E Ring ${id}`;
  105 |   await add(backend, {
  106 |     ...benchOf(team),
  107 |     workflows: [
  108 |       { name: holder, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
  109 |     ],
  110 |   });
  111 | 
  112 |   frame = await gotoApp(page, "app/workflows");
  113 |   await expect(frame.locator('s-page[heading="Workflows"]')).toBeVisible();
  114 | 
  115 |   await page.getByRole("button", { name: "Create workflow" }).click();
  116 |   const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  117 |   const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  118 |   await nameField.fill(`E2E Ring Rush ${id}`);
  119 |   await tagField.fill(`e2e-ring-${id}`);
  120 |   await frame.getByRole("button", { name: "Create", exact: true }).click();
  121 |   await expect(frame.getByText(`is already ${holder}'s tag`, { exact: false })).toBeVisible();
  122 | 
  123 |   // A free tag, and the same dialog goes through.
  124 |   await tagField.fill(`e2e-ring-rush-${id}`);
  125 |   await frame.getByRole("button", { name: "Create", exact: true }).click();
  126 |   await expect(editorFrame(page).locator(`s-page[heading="E2E Ring Rush ${id}"]`)).toBeVisible();
  127 |   // Create left the editor open; the shared page needs it closed for the next test.
  128 |   await closeEditor(page);
  129 | });
  130 | 
  131 | /**
  132 |  * Duplicate asks for the new workflow's name and tag, both prefilled, and the new workflow lands
  133 |  * off with the tag the merchant chose.
  134 |  */
  135 | test("duplicate asks for a name and a tag, and the new workflow is inactive with the given tag", async ({
  136 |   backend,
  137 | }) => {
  138 |   const id = own();
  139 |   const team = `E2E Bench ${id}`;
  140 |   const source = `E2E Ring ${id}`;
  141 |   await add(backend, {
  142 |     ...benchOf(team),
  143 |     workflows: [
  144 |       { name: source, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
  145 |     ],
  146 |   });
  147 | 
  148 |   frame = await gotoApp(page, "app/workflows");
  149 |   await openWorkflow(source, id);
  150 | 
  151 |   await clickMenuItem("Duplicate");
  152 |   const nameField = frame.getByRole("textbox", { name: "Name", exact: true });
  153 |   const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  154 |   await expect(nameField).toHaveValue(`${source} copy`);
  155 |   await expect(tagField).toHaveValue(`${source.toLowerCase()} copy`);
  156 | 
  157 |   // The source's own tag is taken, and the refusal lands under the field.
  158 |   await tagField.fill(`e2e-ring-${id}`);
  159 |   await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  160 |   await expect(frame.getByText(`is already ${source}'s tag`, { exact: false })).toBeVisible();
  161 | 
  162 |   await tagField.fill(`e2e-ring-copy-${id}`);
  163 |   await frame.getByRole("button", { name: "Duplicate", exact: true }).click();
  164 |   await expect(frame.locator(`s-page[heading="${source} copy"]`)).toBeVisible();
  165 | 
  166 |   // The copy carries the tag the dialog collected, and is inactive.
  167 |   frame = await gotoApp(page, "app/workflows");
  168 |   await searchWorkflows(id);
  169 |   const copyRow = frame.locator("s-table-row").filter({ hasText: `${source} copy` });
  170 |   await expect(copyRow.getByText(`e2e-ring-copy-${id}`, { exact: true })).toBeVisible();
  171 |   await expect(copyRow.getByText(WORKFLOW_STATE_LABEL.inactive, { exact: true })).toBeVisible();
  172 | });
  173 | 
  174 | /** Edit tag: on the workflow page, immediate, and it makes no draft. */
  175 | test("editing the tag from the detail page writes immediately and starts no draft", async ({
  176 |   backend,
  177 | }) => {
  178 |   const id = own();
  179 |   const team = `E2E Bench ${id}`;
  180 |   const source = `E2E Ring ${id}`;
  181 |   const rival = `E2E Rush ${id}`;
  182 |   await add(backend, {
  183 |     ...benchOf(team),
  184 |     workflows: [
  185 |       { name: source, state: "active", tag: `e2e-ring-${id}`, tasks: [{ name: "Cut", team }] },
  186 |       { name: rival, state: "active", tag: `e2e-rush-${id}`, tasks: [{ name: "Cut", team }] },
  187 |     ],
  188 |   });
  189 | 
  190 |   frame = await gotoApp(page, "app/workflows");
  191 |   await openWorkflow(source, `ring ${id}`);
  192 | 
  193 |   await frame.getByRole("button", { name: "Edit tag" }).click();
  194 |   const tagField = frame.getByRole("textbox", { name: "Tag", exact: true });
  195 |   await expect(tagField).toHaveValue(`e2e-ring-${id}`);
  196 | 
```