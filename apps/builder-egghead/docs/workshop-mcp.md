# Scheduling an egghead workshop from Claude Code

The Builder exposes an MCP server at `/api/mcp`. With it connected, you can
create a live workshop, price it, create the Stripe Payment Link and promo
codes, write the JSON egghead.io reads, and put it on sale, all from a
conversation. Plan: `docs/plans/2026-09-02-001-feat-workshop-scheduling-mcp-plan.md`.

## Connect once

1. Get a device token. Open `<builder url>/activate` while signed in as an
   admin and follow the device flow, or use an existing token from the `cb` CLI
   config. The token must belong to a user who can create Content.
2. Add the server to Claude Code. In the repo you work from, create or edit
   `.mcp.json`:

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

   For local development use `http://localhost:3000/api/mcp`.
3. In Claude Code, ask for `list_workshops`. If you get a 401, the token is
   wrong or the user cannot create Content.

Never paste the token into a chat message or commit `.mcp.json` with it.

## The tools

| Tool                   | Writes             | Needs confirm |
| ---------------------- | ------------------ | ------------- |
| `list_workshops`       | no                 |               |
| `get_workshop`         | no                 |               |
| `create_workshop`      | Builder, Stripe    | dry run first |
| `update_workshop`      | Builder            | dry run first |
| `attach_product`       | Builder, Stripe    | dry run first |
| `reset_product`        | Builder            | dry run first |
| `create_sale`          | Stripe, Builder    | dry run first |
| `export_egghead_config` | no                | |
| `write_egghead_config` | Edge Config        | dry run first |
| `go_live`              | Edge Config, event | always        |
| `end_sale`             | Edge Config, event | always        |
| `check_drift`          | no                 |               |

Every write tool returns a plan and changes nothing unless it is called with
`confirm: true`. Claude is instructed to show you the plan and ask. `go_live`
and `end_sale` refuse outright without `confirm: true`.

## A full run

Say something like:

> Schedule the Claude Code workshop for Sept 18, 9am to 2pm Pacific, $450, 40
> seats. Early bird until Sept 11: $75 off, $100 off for members, $150 off for
> early-bird members. Flag is featureFlagClaudeCodeWorkshopSale.

Claude will walk through, pausing for a yes at each step:

1. `create_workshop` — draft event, Stripe product and price, calendar event.
2. `create_sale` — Payment Link and three promo codes. The dry run lists the
   most recent codes in Stripe so you can see the proposed names follow the
   same pattern.
3. `write_egghead_config` — the workshop JSON, with `isSaleLive: false`.
4. `check_drift` — should come back `ok: true`.
5. `go_live` — flips `isSaleLive` and the banner flag together and records
   your name and the time on the event.

The review page at `/admin/events/<slug>/egghead-sale` shows the same thing
in a browser, reads live from all three systems every time, and has its own
Go live and End sale buttons. Go live there is disabled while drift exists.

## Repair tools

The Course Builder adapter creates the Stripe product and price inside a
try/catch that only logs, so an event can end up with no product, or with a
product whose Stripe side was later deleted by hand.

- `attach_product` creates the product, price, and Stripe objects for an event
  that has none, and surfaces the real error if Stripe refuses.
- `reset_product` unlinks a dead product from the event and retires its rows
  (status 0) so `attach_product` can run again. It touches nothing in Stripe.

## Stripe key permissions

The Builder's `STRIPE_SECRET_TOKEN` can be a restricted key. It needs Write on
Products, Prices, Payment Links, Coupons, and Promotion Codes. Prices is a
separate permission from Products; without it product creation fails at the
price step.

## Without Vercel credentials: the paste step

If the Builder has no `VERCEL_API_TOKEN`, the Edge Config tools refuse and
point you to `export_egghead_config` instead. It returns the two key names
and the exact values, and touches nothing:

1. `export_egghead_config` with `isSaleLive: false` after `create_sale`, and
   paste both items into the Edge Config store in Vercel.
2. When you are ready to sell, `export_egghead_config` with
   `isSaleLive: true` and paste again. That is the go-live.
3. `check_drift` still compares Builder and Stripe; it notes that it skipped
   Edge Config, so check egghead.io directly after about a minute.

The review page shows "Edge Config not configured" and disables its Go live
button in this mode.

## What still needs a human

- A brand-new workshop needs a landing page in `egghead-next` and its flag
  added to `WORKSHOP_FLAG_KEYS`, the header banners, and the homepage. The
  MCP handles workshops that already have a page.
- Edge Config is cached for up to 60 seconds on egghead.io. Wait a minute
  before checking the page after `go_live`.

## Environment

The Builder needs, in Vercel and in your local `.env`:

- `STRIPE_SECRET_TOKEN` — already present. Must be the same Stripe account
  as `egghead-next`'s `STRIPE_SECRET_KEY`, or the live site will never match
  purchases to the product.
- `VERCEL_API_TOKEN` — a token with write access to the egghead-next Edge
  Config store.
- `VERCEL_TEAM_ID` — the team that owns the store.
- `EGGHEAD_EDGE_CONFIG_ID` — the `ecfg_...` id of that store.

Without the Vercel variables the Stripe and Builder tools still work; the
Edge Config tools fail with a clear message and `check_drift` notes that it
skipped Edge Config.

## Production warning

The Builder has no runtime guard on `DATABASE_URL`. If your local `.env`
points at production, a confirmed `create_workshop` creates a real event and
a real Stripe product. Dry runs are always safe. For development, point
`DATABASE_URL` at a local MySQL and `STRIPE_SECRET_TOKEN` at a test key.
