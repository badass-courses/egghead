# Egghead Destination App Vision

## Scope

This is the product-app child of the **migrate-egghead root vision**. It becomes the Egghead app after Rails: a focused CourseBuilder integration that preserves valuable `egghead.io` routes and paid customer promises without inheriting the old system’s baggage.

The root vision and this repository’s `AGENTS.md` win if they conflict with this file.

## What We Build Now

- CourseBuilder commerce: Stripe webhooks, subscription lifecycle, and new purchases before cutover, using CourseBuilder patterns rather than Rails shapes.
- Paid access, active-user progress, and the route slices that block the primary-domain flip.
- Route-for-route behavior where the URL and customer value still matter; intentional redirects or retirement for the rest.
- A sparse app: black and white, strong typography, structural layout, and a small app-owned UI system.
- Vertical slices only. Each slice includes an agent-readable seam: a JSON CLI probe, JSON route, or Brain BDD row.

## Good Enough Is the Bar

Ship the slices that block cutover. Free, anonymous, and non-paid edge cases can be good enough; support handles stragglers and tells us what to migrate next. Polish follows the flip.

## What We Will Not Build For Now

- Legacy dynamic chrome: ratings, social proof, comments, bookmarks, share widgets, page-load side effects, and one-off layouts without demand.
- `egghead-next` parity for its own sake.
- Dormant-user imports, historical progress, long-tail SEO/archive work, or comments without a real support signal.

## Decision Boundaries

Safe work is a bounded, tested vertical slice that follows the root vision, preserves access law, and does not create a new customer promise. Commerce behavior, production data work, read flips, and the domain move need owner approval and the root cutover decision.

## Amendment Policy

This file may specialize the root vision with evidence from destination-app work. It never overrules the root; Joel approves changes.
