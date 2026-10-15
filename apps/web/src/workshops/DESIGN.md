---
name: egghead Workshop landing page
description: Workshop landing pages within the existing egghead app shell.
colors:
  workshop-accent: "#d8836b"
  workshop-accent-hover: "#eaa28d"
---

# Design System: egghead Workshop landing page

## Overview

This documents only `landing-page.tsx` and `landing-page.module.css`, using the requested [Claude Code workshop](https://egghead.io/workshop/claude-code) as reference. Existing egghead navigation, footer, tokens, and themes remain authoritative. Native Workshop `landingPage` fields hold the MCP-editable content. Local previews show publication status. Published pages use the same composition and open registration only when a valid offer and local test payments are available.

## Colors

Coral supplies list markers and the details link. Charcoal supplies the link text. Supporting copy, including the instructor role, uses app `--color-muted-foreground`; dividers use app border roles. Keyboard outlines use `--color-ring`.

## Typography

Inherited Nunito headings are heavy and balanced. The headline scales from 38px to 68px with a 17ch width; section headings scale from 28px to 36px. Narrative copy is 18px with 1.85 leading, reducing to 17px on small screens.

## Layout

A centered opening (960px maximum) and introduction (660px) lead into a 720px narrative. Sections cover the story, John’s portrait and biography, outcomes, schedule, preparation, and native FAQ. At 640px and below, padding tightens, the instructor stacks, and schedule labels move above values.

## Elevation & Depth

The opening and narrative rely on whitespace; instructor and schedule regions use borders.

## Shapes

Corners are 8px on the details link and 16px on the schedule panel. Instructor portraits are circular.

## Components

The coral “See workshop details” anchor leads to the schedule. The details panel shows the native USD price. Draft registration remains a status message; an eligible published Workshop adds a “Buy your seat” form using the same coral treatment. The server owns checkout and all payment checks. FAQ uses native `details`/`summary`; links and summaries receive a 2px focus outline with 6px offset. Reduced motion removes the link’s 0.15s background transition.

## Do's and Don'ts

Keep this composition scoped to Workshops; inherit app text, border, and focus roles. Preserve explicit draft and registration states. Do not turn the coral treatment into global app rules or fabricate customer proof.
