---
target: course lesson watched controls
total_score: 35
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
timestamp: 2026-08-07T14-38-17Z
slug: pps-web-src-content-course-progress-experience-tsx
---

⚠️ DEGRADED: single-context (no sub-agent/Task tool is exposed in this session)

## Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                                   |
| --------- | ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     | 4         | Optimistic state, disabled saving state, rollback, and live feedback are present.                           |
| 2         | Match System / Real World       | 4         | The empty/completed circle follows a familiar completion convention.                                        |
| 3         | User Control and Freedom        | 4         | The completed check is a reversible control, not a dead status mark.                                        |
| 4         | Consistency and Standards       | 4         | Title and curriculum now communicate completion with coordinated treatments.                                |
| 5         | Error Prevention                | 3         | In-flight toggles are disabled; anonymous users can still begin an action that cannot persist.              |
| 6         | Recognition Rather Than Recall  | 4         | The completion control sits directly beside the lesson title.                                               |
| 7         | Flexibility and Efficiency      | 3         | One-click toggling is efficient; no keyboard accelerator is necessary for this frequency.                   |
| 8         | Aesthetic and Minimalist Design | 4         | The detached watched pill is gone; completion is now a quiet state change.                                  |
| 9         | Error Recovery                  | 3         | Failures roll back correctly, but the sign-in recovery message is not itself a link.                        |
| 10        | Help and Documentation          | 2         | Accessible labels and native titles exist, but the icon-only affordance has no persistent explanatory copy. |
| **Total** |                                 | **35/40** | **Good**                                                                                                    |

## Design Specificity Verdict

**LLM assessment:** The result feels authored for egghead rather than pasted from a generic course app. The warm, tactile curriculum remains intact, while completion now behaves like quiet learning state instead of achievement theater. The dark/yolk completed indicator on the active lesson belongs to the active key instead of fighting it with unrelated sage-on-gold color.

**Deterministic scan:** The Impeccable CLI returned zero findings across the changed source targets. Browser visualization reported four `gpt-thin-border-wide-shadow` instances on incumbent nav/player/card/footer surfaces. These are false positives for this narrow feature: the existing tactile depth language deliberately combines borders and broad shadows, and none originated in the completion control.

**Visual overlays:** Browser injection succeeded in a headless review session. No user-visible Human tab was opened. The live scan found no low-contrast or undersized-text issue after the curriculum eyebrow fix.

## Overall Impression

The completion state is now attached to the thing it describes, is directly actionable, and remains reachable before the long curriculum on mobile. The biggest remaining opportunity is making anonymous recovery actionable rather than merely informative.

## What's Working

- The empty 44px hit target beside the title is discoverable without adding another pill or label to the page.
- Completed state collapses to a plain sage check, while the active curriculum row uses a dark knob with a yolk check that belongs on the gold key.
- Mobile reading order now places the lesson title and completion control immediately after the player, before the full curriculum.

## Priority Issues

### [P2] Anonymous recovery stops at a message

- **Why it matters:** Clicking completion while signed out says “Sign in to save progress,” but makes the learner hunt for the sign-in action.
- **Fix:** Turn “Sign in” in the inline feedback into a direct `/login` link while preserving the live-region announcement.
- **Suggested command:** `$impeccable harden`

### [P3] The incomplete control is intentionally quiet

- **Why it matters:** First-time users may not immediately infer that the empty circle is clickable, even though its position and hover/focus states help.
- **Fix:** Validate with real learners before adding persistent copy; if needed, add a concise tooltip rather than restoring a badge.
- **Suggested command:** `$impeccable clarify`

### [P3] Long curricula still dominate the mobile page after the title

- **Why it matters:** The primary lesson identity and completion action are fixed, but lesson facts and transcript remain below all curriculum rows.
- **Fix:** Consider collapsing or height-capping the mobile curriculum in a separate navigation pass.
- **Suggested command:** `$impeccable adapt`

## Persona Red Flags

**Jordan (First-Timer):** The empty circle has an accessible name and native title, but no persistent visible label. After an anonymous click, Jordan gets a clear message but not a direct sign-in action.

**Sam (Accessibility-Dependent):** The control is a semantic 44×44 button with a changing accessible label, visible focus, disabled saving state, and polite status announcements. No color-only state remains because the check shape changes as well.

**Casey (Distracted Mobile User):** The title and toggle now appear directly after the player instead of below fourteen curriculum rows. The remaining curriculum is still long, but it no longer blocks the core completion action.

## Minor Observations

- The course eyebrow was increased from 10px and switches to sky in dark mode, resolving the browser detector’s contrast and undersized-text findings.
- The completion and removal writes are optimistic and roll back on server failure.
- Automatic video-ended completion is recorded separately from manual progress-control completion.

## Questions to Consider

- Should anonymous completion clicks open sign-in immediately, or is preserving page context with inline feedback more important?
- Would a collapsed mobile curriculum improve lesson focus, or would it hide navigation learners use heavily?
