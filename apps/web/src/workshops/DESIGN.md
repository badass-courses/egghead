---
name: egghead Workshop landing page
description: Native Workshop landing pages inside the existing egghead app shell.
colors:
  surface: "var(--color-surface)"
  foreground: "var(--color-foreground)"
  muted-foreground: "var(--color-muted-foreground)"
  border-strong: "var(--color-border-strong)"
  marker: "var(--color-rust)"
  ring: "var(--color-ring)"
---

# Design System: egghead Workshop landing page

## Overview

This covers `landing-page.tsx` and `landing-page.module.css` only. The egghead nav, footer, Nunito type, theme tokens and light/dark themes remain authoritative. This is a layout and behavior extension within that world.

The opening establishes the real workshop, instructor, schedule, price and registration state. Content comes from native Workshop `fields` and optional `landingPage` fields; claims about recordings, format, scarcity or guarantees require authored evidence.

## Colors

Use the inherited foreground, muted foreground, surface, strong border, rust and focus-ring tokens. Rust marks narrative bullets. The purchase action uses the existing yolk treatment from `@egghead/ui/button`; it introduces no local accent palette.

## Typography

- Headline: `clamp(2.5rem, 1.6rem + 3.6vw, 4.25rem)`, weight 850, line-height 1.04, tracking -0.03em, maximum 15ch, balanced.
- Section headings use `--text-3xl`; the schedule title uses `--text-2xl`. Desktop price uses `--text-4xl`; mobile checkout price uses `--text-xl`. Prices and schedule facts use tabular numerals.
- Narrative paragraphs and lists use `--text-lg` at 1.7 leading. The introduction uses foreground `--text-xl` at 1.6 leading; other paragraphs use muted foreground. Bullets and takeaways retain foreground contrast.
- No eyebrows, kickers or decorative monospace.

## Layout

- Container maximum: 72rem. Side gutters: `clamp(1.25rem, 4vw, 2rem)`. Narrative maximum: 42rem.
- At 60rem and wider, use a two-column grid: headline and byline above the narrative, with a 22rem registration column spanning both rows at right. The column wrapper owns the surface, border, padding and radius; the inner schedule section has none of those desktop treatments.
- Only at widths of at least 60rem and heights of at least 46rem does the registration column become sticky (`top: 7rem`). Short desktop viewports keep it in normal flow.
- Through 59.9375rem, the layout is a column flex container and the registration wrapper uses `display: contents`. The headline/byline and schedule panel precede the narrative. For purchasable workshops, price and purchase live in the bottom bar, outside the schedule panel.
- The same checkout form becomes a flex item at the layout end (`order: 1`) with `position: sticky; bottom: 0; z-index: 10`. It reaches across the page gutters and uses bottom padding `calc(0.75rem + env(safe-area-inset-bottom))`. A purchasable mobile page removes its usual bottom padding.
- Keep the form's reserved final flow slot. While reading it stays at the viewport bottom; when that slot arrives, it settles above the footer, allowing the closing content and footer to remain reachable. Do not replace this with a fixed overlay or duplicate form.
- Through 22rem, the bar stacks price above a full-width button with a 0.625rem gap. Through 30rem, the instructor portrait stacks above the biography and shrinks from 6rem to 5rem.
- Narrative order: introduction, authored sections, takeaways, instructor, attendee instructions, questions, then the mobile schedule-return link.

## Elevation & Depth

Use flat theme surfaces and strong borders, without panel shadows. On desktop the registration wrapper forms one outlined surface; on mobile the schedule panel and purchase bar are separate surfaces. The sticky bar has a top border and opaque surface background.

## Shapes

The schedule panel on mobile and registration wrapper on desktop use a 1rem radius and a 1px strong border. The mobile checkout bar is full-bleed with square corners. Instructor images are circular. Preserve the inherited purchase button's tactile shape and treatment.

## Components

- **Schedule:** `#workshop-details` shows the Workshop title; without `landingPage`, the title becomes the H1 and this heading reads “Schedule and registration.” Show full date, start–end time and long timezone name, formatted in `fields.timezone`.
- **Purchase:** render exactly one server form only when `published && checkoutAvailable && offer`. It posts to `startWorkshopCheckout` with hidden `workshopId` and a fresh `randomUUID()` request ID. The server owns checkout and payment checks.
- **Price and button:** the form contains the offer price, “One-time workshop ticket,” and the yolk, large “Buy your seat” button. Price omits cents for whole amounts. Desktop shows a full-width button and Stripe payment caption; mobile hides that caption and places price beside the button until the narrow-phone stacking breakpoint. It remains the only filled control.
- **Draft or unavailable:** keep the plain status message inside the schedule panel, with price when an offer exists. Render no checkout form, sticky purchase bar, filled button or disabled purchase button.
- **Links:** the instructor byline links to `#instructor`. Below 60rem, a closing “Schedule and registration” link returns to `#workshop-details`. Underlines use 40% current color, becoming full strength on hover. The closing link and preview navigation have at least 2.75rem hit height.
- **Questions:** native `details`/`summary`, with padding on the summary and a minimum height of 2.75rem. A CSS chevron rotates when open using inherited fast duration and easing; global reduced-motion rules apply.
- **Focus:** links and summaries use a 2px ring-token outline with a 4px offset.
- **Preview:** draft/published label and an “All workshop drafts” link; render only when preview is enabled.

## Do's and Don'ts

- Do preserve the single checkout form across desktop and mobile, including its reserved final slot and safe-area padding.
- Do keep the schedule and registration state readable when checkout is unavailable.
- Don't turn a scroll link into a purchase-looking control, or add decorative banners, coral accents, icon-card grids or terminal styling to this surface.
- Don't add marketing filler. Functional headings remain “What you’ll leave with,” “Before the workshop,” and “Questions” outside authored sections.
- Don't fabricate proof, urgency, seat counts or logistics.
