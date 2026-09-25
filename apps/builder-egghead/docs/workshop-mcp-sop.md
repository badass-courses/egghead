# SOP: Scheduling an egghead live workshop with the Builder MCP

This is the step-by-step operating procedure for putting a live workshop on
sale on egghead.io from a Claude Code conversation. For how the pieces fit
together, see `workshop-mcp.md` in this folder.

## What this is, in one paragraph

The Builder app exposes an MCP (Model Context Protocol) server at
`/api/mcp`. MCP is a standard way for Claude to call functions on a server
you control. The server publishes twelve "tools" with names, descriptions,
and input schemas. When you ask for something in plain English, Claude picks
the tool, fills in the arguments, and sends the request. The Builder runs the
real code (Builder database, Stripe, Vercel Edge Config) and returns the
result. Claude never touches Stripe or Vercel itself.

## The rules

1. **Every write tool is a dry run by default.** It returns a plan and changes
   nothing until it is called again with `confirm: true`. Claude is instructed
   to show you the plan and wait for your yes.
2. **`go_live` and `end_sale` refuse to run without `confirm: true`.** Say
   "yes, go live" explicitly. Claude will not confirm on its own.
3. **Trust the re-read state, not the request.** After every write, the tool
   re-reads the event and reports the real Stripe ids. If a Stripe id is
   missing, the write partly failed. Use the repair tools.
4. **Never paste the device token into a chat message.** It lives only in
   `.mcp.json`, which must not be committed.
5. **Check which database you are pointed at.** There is no runtime guard on
   `DATABASE_URL`. Dry runs are always safe. Confirmed writes against a
   production `.env` create real events, real Stripe products, and real
   Payment Links.

## One-time setup

### 1. Get a device token

Open `<builder url>/activate` while signed in as an admin and complete the
device flow. The token must belong to a user who can create Content. A token
already saved by the `cb` CLI also works.

### 2. Point Claude Code at the server

In the repo you run Claude Code from, create or edit `.mcp.json`:

```json
{
	"mcpServers": {
		"egghead-builder": {
			"type": "http",
			"url": "https://<builder url>/api/mcp",
			"headers": { "Authorization": "Bearer <device token>" }
		}
	}
}
```

For local development use `http://localhost:3000/api/mcp` and run the
Builder with `pnpm dev`.

### 3. Confirm the connection

Start Claude Code and ask:

> List the upcoming workshops.

Claude calls `list_workshops`. A list, even an empty one, means you are
connected. A 401 means the token is wrong or the user cannot create Content.

### 4. Builder environment (once per deployment)

The Builder needs these in Vercel and in your local `.env`:

| Variable                 | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `STRIPE_SECRET_TOKEN`    | Already present. Must be the same Stripe account egghead-next uses. |
| `VERCEL_API_TOKEN`       | Write access to the egghead-next Edge Config store.           |
| `VERCEL_TEAM_ID`         | The team that owns the store.                                 |
| `EGGHEAD_EDGE_CONFIG_ID` | The `ecfg_...` id of the store.                               |

Without the three Vercel variables the Builder and Stripe tools still work.
The Edge Config tools refuse with a clear message and you fall back to the
paste procedure at the end of this document.

## Before you start: what you need to know

Collect these before opening the conversation. Claude will ask for anything
missing.

- Title, and a short description (under 500 characters)
- Start and end date-time, and the IANA timezone to display (default
  `America/Los_Angeles`)
- Full price in USD and seat cap (`-1` for unlimited)
- The egghead-next feature flag key, for example
  `featureFlagClaudeCodeWorkshopSale`. A brand-new workshop needs its landing
  page and flag added in egghead-next first. The MCP only handles workshops
  that already have a page.
- The coupon name prefix used on previous runs of this workshop, for example
  `CC` for Claude Code or `asfw` for Software Factory
- Discounts in USD: member, early bird, early-bird member
- Early-bird end date (`YYYY-MM-DD`), if any
- Whether it is EU friendly, and any banner copy

## The full procedure

Each step is one tool. Claude calls it as a dry run, shows you the plan, and
calls again with `confirm: true` after you say yes.

### Step 1: Create the workshop

Say:

> Create a workshop called "Claude Code for Teams" on October 15 2026 from
> 9am to 2pm Pacific, $450, 40 seats. Description: "A hands-on day building
> real workflows with Claude Code."

Claude calls `create_workshop` with:

```json
{
	"title": "Claude Code for Teams",
	"description": "A hands-on day building real workflows with Claude Code.",
	"startsAt": "2026-10-15T09:00:00-07:00",
	"endsAt": "2026-10-15T14:00:00-07:00",
	"timezone": "America/Los_Angeles",
	"price": 450,
	"seats": 40
}
```

The dry run shows the event, product, and price it would create. Say yes.
Claude calls again with `"confirm": true`. The Builder creates the draft
event, the Product and Price, the Stripe product and price, and starts
Google Calendar sync.

**Check the result:** the reply must show a `stripeProductId` and a
`stripePriceId`. If either is `null`, go to Repairs below before continuing.
Note the event `slug`. Every later step uses it.

### Step 2: Create the sale in Stripe

Say:

> Create the sale for claude-code-for-teams. Flag is
> featureFlagClaudeCodeWorkshopSale, coupon prefix CC. $100 off for members,
> $75 early bird until October 8, $150 early-bird member.

Claude calls `create_sale` with:

```json
{
	"slug": "claude-code-for-teams",
	"flagKey": "featureFlagClaudeCodeWorkshopSale",
	"couponNamePrefix": "CC",
	"memberDiscount": 100,
	"earlyBirdDiscount": 75,
	"earlyBirdMemberDiscount": 150,
	"earlyBirdEndDate": "2026-10-08",
	"isEuFriendly": false
}
```

The dry run lists the most recent coupons in Stripe so you can see the
proposed names follow the same pattern
(`CC-10-15-yearly-member-discount`, `CC-10-15-non-member-early-bird`,
`CC-10-15-member-early-bird`). Stripe generates the promo codes unless you
pass `memberCode`, `earlyBirdCode`, or `earlyBirdMemberCode`.

Say yes. Claude confirms. The Builder creates the Payment Link and three
coupons with promo codes, then records all of it on the event under
`eggheadSale`.

Optional arguments: `expireEarlyBirdCodes: true` makes the early-bird codes
expire in Stripe at 23:59 on the end date in the event timezone (previous
workshops did not do this; the page stops offering them anyway).
`afterCompletionUrl` sets a checkout redirect. `bannerMessage` and
`earlyBirdBannerMessage` set the site banner copy.

### Step 3: Write the config egghead.io reads

Say:

> Write the egghead config for claude-code-for-teams.

Claude calls `write_egghead_config` with `{ "slug": "claude-code-for-teams" }`.
The dry run shows the exact JSON that will go into Edge Config under
`featureFlagClaudeCodeWorkshopSale_workshop`, with `isSaleLive: false`. Check
the date, times, price, and coupon codes. Say yes. Claude confirms and the
Builder writes it through the Vercel API.

Nothing is on sale yet. The banner flag is still off.

### Step 4: Check drift

Say:

> Check drift for claude-code-for-teams.

Claude calls `check_drift`. It reads Builder, Stripe, and Edge Config live
and lists every disagreement in price, dates, product id, and coupon codes.
You want `ok: true`. If it is not, fix the cause (usually by re-running the
step that owns the mismatched value) and check again.

### Step 5: Go live

Say:

> Yes, go live on claude-code-for-teams.

Claude calls `go_live` with `{ "slug": "claude-code-for-teams", "confirm": true }`.
The Builder sets `isSaleLive: true` in the workshop JSON and
`featureFlagClaudeCodeWorkshopSale_saleBanner: true` in the same Edge Config
write, and records your name and the time on the event.

**Wait about a minute** before checking egghead.io. Edge Config is cached
for 60 seconds on the live site.

You can also do this step from the browser at
`/admin/events/claude-code-for-teams/egghead-sale`. That page reads all
three systems live, shows drift, and has Go live and End sale buttons. Go
live is disabled while drift exists.

### Step 6: End the sale

When seats are gone or the date has passed:

> Yes, end the sale on claude-code-for-teams.

Claude calls `end_sale` with `confirm: true`. Both flags go false in one
write.

## Everyday tasks

**See what exists**

> List upcoming workshops.

> Show me everything about claude-code-for-teams.

`list_workshops` (add "including past ones" for `includePast: true`) and
`get_workshop`, which returns the event, Stripe ids, the recorded sale, and
the current Edge Config state.

**Change the schedule or copy**

> Move claude-code-for-teams to start at 10am and end at 3pm.

`update_workshop` with only the fields you name. Dry run, then confirm. If
the workshop is already in Edge Config, re-run Step 3 and Step 4 afterwards
so the live site matches.

**Change the price**

There is no price-update tool. Reset the product, attach a new one, and
create the sale again (see Repairs).

## Repairs

The Builder's adapter creates the Stripe product and price inside a
try/catch that only logs. So an event can end up with no product, or with a
product whose Stripe side was later deleted by hand.

**Event has no product** (`stripeProductId` is `null` after create):

> Attach a product to claude-code-for-teams at $450 with 40 seats.

`attach_product` creates the Product, Price, and Stripe objects, and surfaces
the real Stripe error if it refuses. Common cause: the Stripe key lacks Write
on Prices. It needs Write on Products, Prices, Payment Links, Coupons, and
Promotion Codes.

**Product exists but Stripe side is dead:**

> Reset the product on claude-code-for-teams.

`reset_product` unlinks the product from the event and retires its rows. It
touches nothing in Stripe. Then run `attach_product`, then `create_sale`
again.

## Without Vercel credentials: the paste procedure

If the Builder has no `VERCEL_API_TOKEN`, replace Steps 3 through 6 with:

1. After `create_sale`, say "Export the egghead config for
   claude-code-for-teams." Claude calls `export_egghead_config` with
   `isSaleLive: false`. It returns two key names and their exact values.
   Paste both into the Edge Config store in the Vercel dashboard.
2. When ready to sell, ask for the export again "with the sale live". That
   is `isSaleLive: true`. Paste both values again. That is your go-live.
3. `check_drift` still compares Builder and Stripe and notes that it skipped
   Edge Config. Check egghead.io directly after a minute.

## Troubleshooting

| Symptom                                                | Likely cause                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| 401 on any tool                                        | Wrong token, or the user cannot create Content                 |
| `stripeProductId` is `null` after `create_workshop`    | Stripe key permissions. Run `attach_product` for the real error |
| `create_sale` says the event has no price              | Run `attach_product` first                                     |
| Edge Config tools say "not configured"                 | Missing Vercel env vars. Use the paste procedure               |
| `check_drift` shows a coupon mismatch                  | Codes edited by hand in Stripe. Re-run `create_sale` or fix Stripe |
| Site still shows old state after `go_live`             | 60 second cache. Wait and reload                               |
| Purchases not matching on egghead.io                   | Builder and egghead-next are on different Stripe accounts      |

## Quick reference

| Tool                    | Say something like                                 | Writes to             | Confirm    |
| ----------------------- | -------------------------------------------------- | --------------------- | ---------- |
| `list_workshops`        | "List upcoming workshops"                          | nothing               |            |
| `get_workshop`          | "Show me claude-code-for-teams"                    | nothing               |            |
| `create_workshop`       | "Create a workshop called X on ... at $..."        | Builder, Stripe       | dry run    |
| `update_workshop`       | "Move X to start at ..."                           | Builder               | dry run    |
| `attach_product`        | "Attach a product to X at $..."                    | Builder, Stripe       | dry run    |
| `reset_product`         | "Reset the product on X"                           | Builder               | dry run    |
| `create_sale`           | "Create the sale for X, flag ..., prefix ..."      | Stripe, Builder       | dry run    |
| `export_egghead_config` | "Export the egghead config for X"                  | nothing               |            |
| `write_egghead_config`  | "Write the egghead config for X"                   | Edge Config           | dry run    |
| `check_drift`           | "Check drift for X"                                | nothing               |            |
| `go_live`               | "Yes, go live on X"                                | Edge Config, event    | required   |
| `end_sale`              | "Yes, end the sale on X"                           | Edge Config, event    | required   |
