---
name: egghead
description: A warm, tactile learning workspace built for concise, practical software education.
colors:
  yolk: "#f7c948"
  yolk-deep: "#e8b229"
  yolk-shadow: "#c28e12"
  yolk-foreground: "#1e2a38"
  sky: "#a8d4e2"
  sage: "#9dbe8d"
  sage-wash: "rgba(157, 190, 141, 0.3)"
  sage-line: "#9dbe8d"
  sage-foreground: "#5c7a4c"
  rust: "#a05040"
  rust-deep: "#7e3c2e"
  background: "#f3e9d2"
  foreground: "#1e2a38"
  muted-foreground: "#43536a"
  cream: "#fdf8ec"
  navy: "#16222f"
  surface: "#fbf3e0"
  well: "#f6edd8"
  border: "#eadfc2"
  border-strong: "#e2d5b4"
typography:
  display:
    fontFamily: "Nunito, ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.6rem + 3.2vw, 3.25rem)"
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Nunito, ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(1.625rem, 1.3rem + 1.6vw, 2.125rem)"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Nunito, ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(1.15rem, 1.05rem + 0.5vw, 1.35rem)"
    fontWeight: 800
    lineHeight: 1.4
  body:
    fontFamily: "Nunito, ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(1rem, 0.96rem + 0.2vw, 1.0625rem)"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Nunito, ui-rounded, system-ui, sans-serif"
    fontSize: "clamp(0.75rem, 0.72rem + 0.15vw, 0.8125rem)"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "0.18em"
  hand-note:
    fontFamily: "Caveat, cursive"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.05
rounded:
  control-sm: "0.5rem"
  control: "0.75rem"
  card: "1rem"
  media: "1.25rem"
  full: "9999px"
spacing:
  gutter: "clamp(1rem, 0.6rem + 2vw, 2rem)"
  flow: "clamp(1.75rem, 1.25rem + 2.5vw, 3rem)"
  section: "clamp(2rem, 1.5rem + 1.5vw, 3rem)"
components:
  button-primary:
    backgroundColor: "{colors.yolk}"
    textColor: "{colors.yolk-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "15px 28px 13px"
  button-navy:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.cream}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "15px 28px 13px"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.control-sm}"
    padding: "8px 16px"
  input-search:
    backgroundColor: "{colors.well}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.full}"
    padding: "6px 6px 6px 20px"
  card-raised:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.card}"
    padding: "20px 22px"
  chip-status:
    backgroundColor: "{colors.sage-wash}"
    textColor: "{colors.sage-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
---

# Design System: egghead

## Overview

**Creative North Star: "The Tactile Learning Desk"**

The Tactile Learning Desk is egghead's incumbent visual world: a warm, slightly imperfect workspace built from paper, trays, wells, and weighty keys. It should feel practical and companionable rather than polished into corporate anonymity—serious enough for working engineers, playful enough to make learning feel human.

Brand expression comes from material relationships more than decoration. Actions rise from the page, inputs and quiet controls sit in wells, cards read as stacked surfaces, and small handwritten notes add a human margin voice. The team-dashboard comparison demonstrates that this world can support dense operational information; its charts, roster patterns, comparison navigation, and management-specific compositions remain local to that surface unless another product flow proves them reusable.

**Key Characteristics:**

- Warm paper and cream surfaces balanced by deep navy ink.
- Yolk yellow used sparingly for action, active learning, and high-value signals.
- Rounded, heavy Nunito typography with brief Caveat annotations.
- Tactile elevation that communicates interaction and hierarchy.
- Dense information organized with generous gutters, short measures, and clear rules.
- Light and dark appearances that preserve the same semantic relationships.

## Colors

The palette behaves like ink and learning tools on warm paper: navy supplies authority, yolk supplies energy, and sky, sage, and rust carry limited semantic accents.

### Primary

- **Sunny Yolk** (`colors.yolk`): The primary action color, active learning signal, and occasional highlight. Deep yolk supplies edge and shadow definition; navy ink remains the readable foreground.

### Secondary

- **Workshop Navy** (`colors.navy`): The dark, grounded counterweight used for alternate actions, media frames, avatars, and high-contrast feature surfaces.

### Tertiary

- **Learning Sage** (`colors.sage`): Completion, healthy status, and positive momentum.
- **Open Sky** (`colors.sky`): Informational emphasis and quiet comparison data.
- **Margin Rust** (`colors.rust`): Eyebrows, warnings, and editorial accents; deep rust supports edges and pressed depth.

### Neutral

- **Warm Paper** (`colors.background`): The light-mode page field.
- **Cream Sheet** (`colors.cream`): High-contrast light content over navy and the lightest raised plane.
- **Raised Surface** (`colors.surface`): Cards, navigation shelves, and resting controls.
- **Inset Well** (`colors.well`): Search fields, subdued panels, tracks, and recessed controls.
- **Navy Ink** (`colors.foreground`): Primary light-mode text and the anchor for outlines and selection.
- **Slate Annotation** (`colors.muted-foreground`): Supporting copy and metadata.
- **Paper Rules** (`colors.border`, `colors.border-strong`): Quiet dividers and more explicit control edges.

Dark appearance keeps the semantic token names and changes their values at the runtime media query: the page becomes near-black navy, surfaces lift into slate navy, wells deepen, text becomes warm cream, and the constant yolk/sky/sage palette remains recognizable. Do not hard-code light neutrals inside components that must adapt.

### Named Rules

**The Yolk Has a Job Rule.** Reserve yolk for the primary action, active learning, or a single high-value signal; its scarcity preserves hierarchy.

**The Semantic Swap Rule.** Components consume semantic variables so light and dark appearances preserve relationships instead of merely inverting colors.

## Typography

**Display Font:** Nunito (with `ui-rounded`, `system-ui`, and `sans-serif` fallbacks)

**Body Font:** Nunito (with `ui-rounded`, `system-ui`, and `sans-serif` fallbacks)
**Handwritten Accent Font:** Caveat (with `cursive` fallback)

**Character:** Nunito makes the interface friendly, blunt, and highly legible at both editorial and operational densities. Caveat is the small human note in the margin, never a replacement for interface type.

### Hierarchy

- **Display** (black, fluid `text-5xl`, 1.05): Page-defining headlines and rare high-impact statements; tighter tracking gives the rounded forms authority.
- **Headline** (extra-bold, fluid `text-3xl`, 1.15): Major section titles and important card headlines.
- **Title** (extra-bold, fluid `text-xl`, 1.4): Repeated card, list, and navigation titles.
- **Body** (regular or semibold, fluid `text-base`, 1.55): Core explanatory copy, generally held near a 65-character reading measure.
- **Label** (extra-bold, fluid `text-xs`, 0.18em tracking, uppercase): Eyebrows, compact metadata headers, and status context.
- **Hand Note** (semibold, Caveat, approximately 1.5rem, 1.05): A short aside, motto, or margin annotation.

### Named Rules

**The Working Voice Rule.** Nunito carries interface and content; Caveat appears only as a short human aside, never for controls, dense data, or body copy.

**The Weight Builds Hierarchy Rule.** Prefer changes in weight, size, and measure over adding extra colors or ornamental type styles.

## Layout

Pages use a named-track content grid: a 65ch reading track, an 85ch breakout track, and a 70rem wide preset inside fluid side gutters. Vertical rhythm comes from three fluid tokens—gutter, flow, and section—rather than isolated viewport-specific margins. Cards and app surfaces use internal grids, but body copy stays on a deliberately shorter measure.

Responsive layouts preserve reading order. Multi-column compositions collapse before their content becomes cramped; dense tables may become stacked records at narrow widths. Navigation compacts from labeled desktop links and search to focused icon controls and a disclosure menu. Sticky rails are reserved for sufficiently wide viewports and must not clip child shadows.

The team dashboard's 640px and 880px adaptations are evidence for this responsive behavior, not new global breakpoints or a required analytics grid. Reuse the shared content-grid, fluid spacing, and collapse principles; re-evaluate data layout per surface.

### Named Rules

**The Reading Track Rule.** Default content lands on the readable track; only media, dense tools, and intentional compositions earn breakout or wide placement.

**The Reflow Before Squeeze Rule.** Change the composition before labels, controls, or records become cramped, truncated beyond recognition, or horizontally dependent.

## Elevation & Depth

Depth is structural and tactile. Raised keys use a highlight, a firm lower edge, and a compact cast shadow; cards use broader ambient shadows; wells reverse the model with inset shadows. Flat dividers organize information inside a surface without turning every row into another card. Light and dark appearances use separate shadow recipes so the same physical roles remain legible.

### Shadow Vocabulary

- **Primary key** (`box-shadow: 0 1px 0 rgba(255, 255, 255, 0.65) inset, 0 3px 0 #c28e12, 0 6px 10px -2px rgba(120, 80, 10, 0.35)`): Yolk actions with a crisp three-dimensional lower edge (`--shadow-btn`).
- **Primary key hover** (`box-shadow: 0 1px 0 rgba(255, 255, 255, 0.7) inset, 0 3px 0 #c28e12, 0 9px 16px -3px rgba(120, 80, 10, 0.4)`): The same key with a slightly longer cast shadow (`--shadow-btn-hover`).
- **Pressed key** (`box-shadow: 0 2px 4px rgba(120, 80, 10, 0.25) inset, 0 1px 0 rgba(255, 255, 255, 0.2)`): An inset state paired with a 2px downward movement (`--shadow-btn-press`).
- **Ghost key** (`box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset, 0 -2px 0 rgba(120, 90, 30, 0.12) inset, 0 2px 6px -1px rgba(120, 90, 30, 0.22), 0 2px 0 rgba(160, 120, 40, 0.25)`): Lightly raised neutral controls, tabs, and compact action keys (`--shadow-btn-ghost`).
- **Card** (`box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset, 0 1px 2px rgba(120, 90, 30, 0.1), 0 8px 24px -8px rgba(120, 90, 30, 0.28), 0 2px 4px -1px rgba(120, 90, 30, 0.12)`): Ordinary raised content surfaces (`--shadow-card`).
- **Deep card** (`box-shadow: 0 1px 0 rgba(255, 255, 255, 0.9) inset, 0 12px 32px -10px rgba(100, 70, 20, 0.35), 0 4px 8px -2px rgba(100, 70, 20, 0.15)`): Large framed surfaces, media, and floating menus (`--shadow-card-deep`).
- **Well** (`box-shadow: inset 0 2px 6px rgba(120, 90, 30, 0.22), inset 0 1px 2px rgba(120, 90, 30, 0.25), 0 1px 0 rgba(255, 255, 255, 0.7)`): Recessed fields, tracks, and quiet status trays (`--shadow-well`).

### Named Rules

**The Physical State Rule.** Raised things invite action, wells receive input or hold quiet data, and flat rules separate information.

**The One Frame Rule.** Prefer one strong containing surface with internal dividers over a field of independently floating mini-cards.

## Shapes

The form language is softly mechanical: compact controls use gently curved 8px or 12px corners, cards use 16px corners, media may reach 20px, and pills are reserved for search, badges, filters, and compact status. Navy avatars and icon keys are squarish with rounded corners rather than circular by default. Borders are thin and tonal; they reinforce edges without becoming outlines around every content group.

Small intentional irregularities—slight rotation, a sticky note, an offset marker swipe—may appear in editorial moments. They are accents against an orderly grid, not a license to make operational layouts crooked.

### Named Rules

**The Useful Curve Rule.** Match radius to function: compact key, card, media frame, or true pill; do not apply maximum rounding indiscriminately.

## Components

Shared components feel friendly, weighty, and pressable. State is communicated through depth, contrast, labels, and icons—not color alone.

### Buttons

- **Shape:** Small controls use an 8px curve; standard and icon controls use a 12px curve; large calls to action may use a full pill.
- **Primary:** Yolk gradient, navy text, strong extra-bold label, and asymmetrical vertical padding that optically compensates for the lower bevel.
- **Navy:** Navy gradient, cream text, and a dark tactile lower edge for a high-contrast alternate action.
- **Ghost:** Raised surface gradient, navy ink, a strong tonal border, and the lighter ghost-key shadow.
- **Rust:** Rust gradient, cream text, and deep-rust edge; use only when its warning or destructive meaning is explicit.
- **Hover / Focus / Active:** Hover brightens and may lengthen the shadow; keyboard focus receives a 2px semantic ring with a 3px offset; active moves down 2px into the pressed shadow. Disabled controls become recessed and visibly muted.

### Chips

- **Style:** Compact pills or softly rounded labels use heavy small type. Status chips use a pale semantic wash with a readable same-family foreground; navigation badges may use a raised neutral surface.
- **State:** Pair color with text and, where useful, a dot or icon. Do not use an unexplained colored dot as the only status signal.

### Cards / Containers

- **Corner Style:** Raised content cards use a 16px curve; media and especially generous frames may use 20px.
- **Background:** A subtle surface gradient over the current theme field.
- **Shadow Strategy:** Ordinary cards use the ambient card shadow; important frames and floating overlays use deep-card elevation.
- **Border:** One tonal border defines the material edge.
- **Internal Padding:** Typically 20–32px, increasing with surface scale and available width.

### Inputs / Fields

- **Style:** Inputs sit in a recessed well with a strong tonal border; search is commonly pill-shaped while compact filters may use 8px corners.
- **Focus:** The containing field receives the same visible 2px semantic ring as other interactive controls.
- **Error / Disabled:** Error uses rust plus explicit copy. Disabled state lowers contrast and keeps its label readable; it does not disappear.

### Navigation

Primary navigation is a floating surface shelf with a clear brand anchor, quiet default links, a raised active key, a recessed search field, and at most one yolk action. At narrow widths it preserves the logo, exposes the most useful icon action, and moves remaining links into a raised disclosure panel. Active state uses both visual elevation and `aria-current`.

### Resource Lists

Curricula and learning lists live in one raised frame. Native disclosure sections divide the frame; the active lesson becomes a yolk key, completed state uses sage, and counts sit in small wells. Scroll fading belongs to the inner viewport so the card border and shadow stay intact.

### Local Dashboard Patterns

The team preview's concept tabs, topic bars, activity chart, management summary, insight panel, and responsive member roster are research prototypes for that route. They inherit global color, type, spacing, shape, depth, and state rules, but they are not canonical components until repeated product use justifies extraction.

## Do's and Don'ts

### Do:

- **Do** build hierarchy with surface role, weight, spacing, and readable measure before adding another accent color.
- **Do** use yolk for the screen's clearest action or learning signal and keep its navy foreground.
- **Do** keep components bound to semantic CSS variables so the dark appearance remains intentional.
- **Do** make focus visible, preserve keyboard operation, respect reduced motion, and pair status color with words or icons.
- **Do** use real egghead content and the Eggo identity asset when product evidence calls for them.
- **Do** treat dense operational data as trustworthy records, with tabular numerals, plain labels, and responsive reflow.

### Don't:

- **Don't** replace the incumbent paper, navy, yolk, rounded-type, and tactile-depth world with a generic dashboard aesthetic.
- **Don't** turn every content group into a floating card or every action into a yolk button.
- **Don't** use Caveat for controls, tables, long copy, or essential instructions.
- **Don't** hard-code light-theme neutrals inside adaptive components.
- **Don't** promote the team prototype's analytics structures into global patterns without evidence of reuse.
- **Don't** invent achievement theater, social proof, rankings, unsupported proficiency scores, or surveillance-style engagement metrics.
