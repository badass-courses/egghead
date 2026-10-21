---
target: Workshop page and orange details link
total_score: 16
max_score: 24
na_heuristics: 5,7,9,10
p0_count: 0
p1_count: 2
timestamp: 2026-10-20T14-31-05Z
slug: apps-web-src-workshops-landing-page-tsx
---

Method: dual-agent (A: workshop-design-reviewer, Opus via Claude CLI · B: workshop_evidence_review)

# Workshop page critique

**Target:** `apps/web/src/workshops/landing-page.tsx` + `landing-page.module.css`
**Evidence used:** source, `DESIGN.md`, `PRODUCT.md`, `packages/ui` tokens and `button.tsx`, and two screenshots (`/private/tmp/workshop-opus-desktop.jpg` at 1280×4590 and `/private/tmp/workshop-opus-mobile.jpg` at 390×5995). I had no live browser control. Anything I say about the published/checkout state comes from source only, because the screenshots show the draft.

---

## Design Specificity Verdict

**Partly specific, mostly generic.** The page sits correctly inside the egghead shell: nav, yolk "Sign in", Nunito headings, dark navy theme, footer with the "learn by doing" handwriting. But the workshop surface itself is the standard SaaS-course long-form template: centered hero, a pill CTA, three H2+paragraph+bullet sections, an instructor card, a takeaways list, a boxed price, an FAQ. With a different headline it could sell any cohort course on any platform.

It uses none of egghead's own devices. `tokens.css` defines a `--color-marker` "marker swipe behind headline words" and a tactile `press`/`shadow-btn` button family, and the page uses neither. Instead it adds a third accent colour: coral `#d8836b` (`landing-page.module.css:2`). That colour isn't in the palette (yolk / sky / sage / rust), it's hardcoded, and it doesn't switch with the theme. So the most "designed" element on the page is the one that belongs least to egghead.

## Independent detector and browser evidence

Assessment B independently returned a clean detector result (`[]`, zero findings for the target TSX). This does not establish good visual hierarchy. Desktop/mobile measurements found no horizontal overflow; the details anchor landed correctly, FAQ expansion worked, and queried console warnings/errors were empty. The solid CTA text/background pair measured 6.65:1 contrast: the concern is hierarchy and brand fit, not a measured contrast failure. Mobile FAQ summaries measured about 28px high despite large surrounding spacing; moving padding onto summary would improve the actual hit area. The visible draft correctly has no buy button.

No overlay was injected: browser evaluate supports read-only inspection. Published checkout, light mode, zoom, full keyboard traversal and screen-reader announcements were not exercised. Assessment A received its own fresh-tab desktop/mobile screenshots via the parent relay; Assessment B used a separate fresh tab and never saw A’s assessment. Both completed before synthesis.

## Overall Impression

**What I see in the screenshots.** Desktop: the hero headline "Build your own software factory." in heavy cream type. Under it, a muted 4-line intro, a small avatar with "With John Lindquist", a muted date line "Sunday, November 1, 2026 · 9:00 AM PST–3:00 PM PST", and then a salmon/coral filled block "See workshop details ↓" with dark text. That block is the most saturated thing on the screen. It outshouts the headline and fights the yolk "Sign in" in the top-right. About 4,000px of mostly muted-grey 18px prose follows. The outlined "Make a day of it." panel holds the price, "$375.00 USD", and directly under it, with no space between them, "One-time workshop ticket" and "Registration opens when published". The page ends on three collapsed FAQ rows.

**Gut reaction.** Calm, readable and competent, but the loudest element makes a promise that leads nowhere. In this draft, the user follows the coral button down roughly 2,800px and finds a box saying registration isn't open. The user is right that the button is ugly. It's also badly ranked. It's a navigation link dressed as the purchase.

**Biggest opportunity:** rebuild the hierarchy so that:

- the real facts (who, when, $375) sit in the hero;
- the only filled, high-emphasis control on the page is the actual purchase button, in egghead's own yolk button language;
- drafts show no filled control at all.

---

## Nielsen Heuristics

| #         | Heuristic                       | Score           | Key Issue                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     | 3               | The "Draft preview · Unlisted" bar and the registration state are explicit (`tsx:45-50, 158-167`). But the hero CTA gives no hint that registration is closed, and the preview bar is tiny (13px, and 11px on mobile, `css:13, 208`).                                         |
| 2         | Match System / Real World       | 3               | The language is plain and direct. "Software factory" is never defined in a sentence. Time reads "9:00 AM PST–3:00 PM PST" (zone repeated twice), and the price reads "$375.00 USD" instead of "$375".                                                                         |
| 3         | User Control and Freedom        | 3               | Anchor links, the "All workshop drafts" escape and native `<details>` all work. Nothing traps the user.                                                                                                                                                                       |
| 4         | Consistency and Standards       | 2               | The bespoke `.cta` ignores the `Button` component (`packages/ui/src/components/button.tsx`). Coral is off-palette. A scroll anchor and a payment submit share one class (`tsx:69, 151`). 8px radius vs the app's `rounded-xl`. Hardcoded px type instead of the fluid tokens. |
| 5         | Error Prevention                | n/a             | Checkout isn't visible in the evidence. Source looks sound: the price is in the button label, there's a Stripe note, and the server owns validation. Not scored.                                                                                                              |
| 6         | Recognition Rather Than Recall  | 3               | When/time/price are restated in the details panel. But the key "who is this for?" answer is hidden in a collapsed FAQ at the very bottom.                                                                                                                                     |
| 7         | Flexibility and Efficiency      | n/a             | Persuade surface.                                                                                                                                                                                                                                                             |
| 8         | Aesthetic and Minimalist Design | 2               | The coral CTA dominates. Body copy is uniformly muted at 1.85 leading, so the sections read as grey walls. The price/ticket/status stack is cramped (`css:177-180` sets `margin:0` on every `.registration p`).                                                               |
| 9         | Error Recovery                  | n/a             | No error states on this surface. Checkout errors live outside these files.                                                                                                                                                                                                    |
| 10        | Help and Documentation          | n/a             | Persuade surface (the FAQ is counted under 6).                                                                                                                                                                                                                                |
| **Total** |                                 | **16/24 (67%)** | **Acceptable**. Heuristics 5, 7, 9 and 10 were n/a.                                                                                                                                                                                                                           |

## Cognitive Load

Checklist failures:

- **Visual hierarchy:** the most important-looking thing is a scroll link, not the content or the purchase.
- **Single focus:** coral CTA vs yolk "Sign in" gives two competing saturated targets above the fold.
- **Progressive disclosure inverted:** the fit-determining question "Who is this workshop for?" is collapsed at the end, while three long narrative sections are fully expanded.

That's 3 failures, so **moderate load**. No decision point inside the workshop surface has more than 4 options. The shell nav has six controls, but that belongs to the shell and isn't in scope.

The working-memory problem: the price is invisible until roughly 75% of the way down the page. To judge value while reading, a visitor has to scroll down and back.

## Emotional Journey

- **Opening (strong):** the headline is confident and the intro is concrete and warm.
- **Valley (long):** three consecutive muted H2/paragraph/bullet blocks with similar rhythm. There are no breaks between them, and no visual or structural change until the instructor rule.
- **Intended peak, the registration panel, falls flat.** In the draft it's a quiet bordered box where price and status run together. In the published state it repeats the same coral button already used for navigation, so the real moment of commitment looks exactly like the casual one above it.
- **End:** three closed disclosure rows. Under the peak-end rule the last impression is "more questions", not "I know what I'm getting and when."

---

## What's Working

1. **Honest states.** Draft vs published vs closed registration are written out in plain sentences (`tsx:158-167`), and the page invents no urgency or proof. This fits `PRODUCT.md`'s "no fabricated proof" commitment.
2. **Readable measure and type.** The 720px column, balanced Nunito headings and 17–18px body text read comfortably on both viewports. The mobile layout stacks the instructor and schedule labels sensibly (`css:229-246`).
3. **Shell integration.** The workshop sits inside the real egghead nav and footer without fighting them, apart from the CTA. The instructor block with a portrait between hairline rules is a calm, credible trust moment.

---

## Priority Issues

### [P1] The coral "See workshop details" anchor is styled as the primary purchase, and in drafts it leads to a dead end

- **Where:** `landing-page.tsx:69-71`; `landing-page.module.css:2, 59-75`; documented as intent in `DESIGN.md` ("Components").
- **What I see:** a filled salmon block with near-black text. It is the highest-chroma element on the page, and it competes with the yolk "Sign in".
- **Why it matters:**
  - A filled button signals "this is the commitment." This one only scrolls, and on this draft the scroll ends at "Registration opens when published."
  - On published pages the same `.cta` class is reused for the Stripe submit (`tsx:151`). The purchase therefore has no more visual weight than a link that has already been ignored once.
  - The colour is off-system, hardcoded and not theme-aware, and the text colour `#10110f` is hardcoded too.
- **Does an anchor deserve filled primary styling?** No. A same-page scroll link is navigation. It should look like navigation.
- **Fix:**
  1. **Delete the hero button.** Replace it with a fact row that holds the decision data, for example "Sunday, Nov 1 · 9am–3pm PT · $375". Put a quiet text link after it: "Schedule & registration ↓", in `--color-foreground`, underlined with `text-underline-offset: 4px` like the `.preview a` rule, at least 44px tall, using the existing focus ring.
  2. **Published state only:** make the real `<form action={startWorkshopCheckout}>` submit the only filled control on the page. Render it with the incumbent `Button` (`variant="yolk"`, `size="lg"`) instead of `.cta`, so it gets egghead's tactile bevel and matches "Sign in". If a hero-level purchase is wanted, render the same server form in the hero too. Do that instead of an anchor pretending to be the purchase.
  3. **Draft state:** no filled control anywhere. The status line takes its place.
  4. **Palette:** remove `--workshop-accent` and `.cta:hover #eaa28d`. Move the list markers (`css:109-111`) to `--color-rust` or `--color-border-strong`. Update `DESIGN.md` so it no longer documents coral as intent.
- **Suggested command:** `$impeccable quieter` for the hero link, then `$impeccable polish` to adopt `Button` for the purchase and remove the coral.

### [P1] Decision facts are buried, and the actual title barely appears

- **Where:** `tsx:54, 66-68, 124-125, 141-146`.
- **The problem:**
  - The H1 is the marketing headline. The real product name, "Software Factory with John Lindquist", appears once, as small muted body text under "Make a day of it." (`tsx:125`).
  - The price appears only in that panel, around 3,200px down on desktop.
  - "Unlimited seats" is a supplied fact, but the page never states it. I'm not asking for scarcity copy. Saying that seats aren't limited is honest and helpful.
- **Why it matters:** this is a sales-clarity gap, not a visual one. A developer deciding "is this worth a Sunday and $375?" needs the name, date and price together in the first viewport. `PRODUCT.md` calls for respecting the learner's time.
- **Fix:**
  - Add a small eyebrow above the H1 with the title, "Software Factory · Live workshop", so the hero carries the product name.
  - Put the price into the hero fact row from Issue 1.
  - Format the price as "$375" by setting `minimumFractionDigits: 0` when the amount is whole (`tsx:24-28`), and drop the trailing literal " USD" unless currency is ambiguous.
  - Show the time once with a zone: "9am–3pm PT", not "9:00 AM PST–3:00 PM PST".
- **Suggested command:** `$impeccable clarify`.

### [P2] Registration panel is cramped and has no internal hierarchy

- **Where:** `tsx:140-170`; `css:167-180, 254-266`.
- **What I see:** "$375.00 USD", then "One-time workshop ticket", then the bold "Registration opens when published" stacked directly against it, then the draft sentence. `.registration p { margin: 0 }` and `.price span { margin-top: 12px }` give the ticket label room above it but none below, so the status heading sits right against it.
- **Fix:**
  - Lay the panel out as two clear rows: price block (amount + "One-time ticket"), then the action/status block with a 24px gap.
  - In draft, give the status a quiet badge-like line ("Registration not yet open"), and make sure the meaning doesn't depend on colour alone.
  - In published, the yolk `Button` plus a "Secure payment through Stripe." caption at `--text-sm`.
  - Consider promoting this panel's visual weight, for example `--color-surface`/`well` with `--radius-xl2`, since it is the page's commitment point.
- **Suggested command:** `$impeccable layout`.

### [P2] The long, same-weight narrative creates a grey valley

- **Where:** `tsx:75-87, 108-119`; `css:91-96` (all `p`/`li` use `--color-muted-foreground`, 18px, line-height 1.85).
- **What I see:** four sections in a row with the same H2 → muted paragraph → 3–4 bullets rhythm. The bullets are also muted, so they don't read as payoffs.
  - Sections 1 and 2 both end in "process/workflow" bullets, and "Leave with a workflow you can keep building on" says it a third time.
  - The hardcoded copy at `tsx:109-112` ("A day of building is useful…") is filler that isn't editable through the MCP fields.
- **Fix:**
  - Render bullets and takeaways in `--color-foreground` and keep paragraphs muted. That alone restores scanning.
  - Tighten line-height to about 1.65.
  - Cut or merge the hardcoded takeaways intro so the takeaways list stands alone, or move it into `landingPage` fields.
  - Optionally use the egghead `--color-marker` swipe on one key word in the H1. That's an authentic egghead device and would replace the coral as the page's single "signature" mark.
- **Suggested command:** `$impeccable distill` (content), then `$impeccable typeset`.

### [P2] The FAQ’s actual mobile hit area is smaller than its apparent row

- **Evidence:** independent browser measurements put each mobile summary at about 350×28px. The 24px vertical padding belongs to `details`, leaving much of the apparent row outside the click target (`landing-page.module.css:184–191`).
- **Why it matters:** mobile readers can tap visible row whitespace and fail to expand an answer.
- **Fix:** move row padding onto `summary`, giving the whole visible row a generous target of at least 44px. Native disclosure semantics should remain. This is a usability improvement; no WCAG AA failure was demonstrated.
- **Suggested command:** `$impeccable adapt`.

Audience-fit information remains worth moving above the long narrative, using existing approved copy. The preparation FAQ overlaps with the expanded preparation section.

---

## Persona Red Flags

**Jordan (first-timer):**

- Clicks the big coral button expecting to sign up. It scrolls 2,800px and says registration isn't open.
- "Software factory" is never defined in one sentence.
- Can't find the price without scrolling to the bottom third of the page.
- "With John Lindquist" (`tsx:57-64`) is a link with no underline or affordance, so a literal reader won't know it jumps to the bio.

**Casey (mobile):**

- In the 390px capture the hero date wraps across three ragged lines ("Sunday, November 1, 2026 · 9:00 / AM PST–3:00 PM PST"). The cause is `max-width: 240px` (`css:217-221`).
- The price and registration panel sit at about 72% of a 6,000px page.
- The draft bar is 11px (`css:208`), below comfortable reading size, and the "All workshop drafts" link is a small tap target.
- A dark circular "N" badge sits over the "No" of "Now connect the work." This looks like the Next.js dev indicator captured in the full-page screenshot, not product UI. I'm not counting it as a defect.

**Riley (stress tester):**

- The same `.cta` class is used for a scroll link and a payment submit (`tsx:69, 151`), so restyling one silently changes the other.
- Coral and `#10110f` are hardcoded, so the light theme isn't checked against the cream background (source-level risk only; light mode wasn't captured).
- `key={section.heading}`, `key={bullet}` and `key={question}` will collide if the MCP authors two identical headings or bullets (`tsx:76, 82, 185`).

**Project persona — "Working developer weighing a Sunday" (from `PRODUCT.md`):** wants who/what/when/cost in about 10 seconds. Today they get who and when in the hero, have to dig for cost, and the "what" is spread across four similar sections.

---

## Minor Observations

- `.presenter` has no hover or underline state (`css:41-47`). Either make it read as a link or make it non-interactive.
- Two content blocks are hardcoded in the component rather than coming from MCP-editable fields: "Make a day of it." / "Leave with a workflow…" (`tsx:109-112, 124`).
- The `scroll-margin-top: 110px` values are magic numbers tied to the shell header height (`css:119, 143`).
- The instructor and details panels use negative `-40px` margins to break out of the column (`css:116, 139`). This is visually fine on desktop, but it's an extra layout trick to maintain.
- `<details>` summaries use the default disclosure triangle, which works but looks unstyled next to the polished shell footer.
- The hero is 960px wide but the intro is capped at 660px and the H1 at 17ch. That's fine, but the 960px container does nothing visible.
- Visual polish vs content clarity, kept separate:
  - **Polish issues:** coral CTA, cramped registration panel, muted bullets, mobile date wrap, tiny preview bar.
  - **Content/sales-clarity issues:** title missing from the hero, price buried, "unlimited seats" never stated, "software factory" never defined, fit question collapsed, repeated workflow messaging.

## Questions to Consider

1. In the published state, should the hero carry a real yolk "Buy your seat · $375" form submit, so there are two identical real purchase points? Or should the hero stay informational, with only a text link down to a single purchase in the panel?
2. Should the H1 stay the marketing headline ("Build your own software factory."), or become the actual product name with the headline as the deck? Today the name only appears as muted body text.
3. Is coral meant to brand Workshops as a distinct sub-product inside egghead? If not, should `DESIGN.md` drop `workshop-accent` entirely in favour of yolk/rust and the existing marker swipe?

## Additional buyer context

The decision panel does not establish online/in-person format or recording availability. Confirm those facts with the workshop owner before adding claims. Never invent logistics, scarcity or guarantees. The actual workshop remains draft/unlisted; the observed closed registration is intentional, not a checkout defect.

No application code changed during this review.
