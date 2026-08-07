# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Working software developers use egghead when they need to learn practical modern web and AI-development skills without wasting time. Anonymous visitors browse and search the public catalog. Signed-in learners watch lessons, understand their learning access, track published completions, and manage their account identity.

A learner may also share a public learning profile with peers, colleagues, or prospective collaborators without exposing private account or provider details.

## Product Purpose

egghead helps developers build useful skills through concise, practitioner-taught learning content. The web app brings discovery, playback, access, progress, and account management into one focused experience while preserving valuable egghead routes and paid customer promises during the Rails-exit migration.

Success means a learner can quickly find relevant material, understand whether they can access it, complete it, return to their progress, and trust what is private or publicly shareable.

## Positioning

egghead delivers concise lessons from working engineers who respect the learner's time: no fluff, immediately useful, and grounded in practical modern web and AI-development work.

## Operating Context

Learners arrive through the home page, search, catalog indexes, or established content URLs. They move among courses, lessons, articles, talks, podcasts, campaigns, case studies, and success stories. Lesson and course experiences combine published content, video playback, access evaluation, and completion state.

Signed-in learners use a private profile to review access and recent progress, edit their public display name, and inspect supported sign-in connections. A separate public profile projects only approved identity fields and published learning activity.

## Capabilities and Constraints

- Public discovery includes browsing and search across courses, lessons, articles, talks, podcasts, and related published resources.
- Course and lesson routes preserve valuable established URLs, including canonical and compatibility routes where customer value still depends on them.
- Access decisions use explicit granting entitlements. A bare legacy `pro` value must not grant broad access.
- Progress records published resource completions for signed-in learners; anonymous use must not fabricate completion state.
- Private profile data and connected-provider details remain private. Public profiles expose only an allowlisted projection.
- A learner may disconnect only an exact provider account owned by the current session and only when another configured sign-in method remains.
- The current migration phase is local/development bounded. It does not own production imports, production read flips, commerce, Stripe/Inngest writers, or production database writes.
- The app consumes published `@coursebuilder/*` packages and keeps app behavior behind explicit, agent-readable contract seams.
- Long-tail parity, comments, ratings, bookmarks, social widgets, and unsupported one-off layouts are not current product commitments without evidence of customer need.

## Brand Commitments

The product name is written as lowercase **egghead**. Its voice is direct, warm, confident, and respectful of the learner's time. Existing identity assets include the Eggo mascot at `apps/web/public/eggo-watering.png`.

The product should not invent achievement theater or present itself as a social network. Learning activity should remain the substance of the learner record.

## Evidence on Hand

- The implemented route surface under `apps/web/src/app` demonstrates public discovery, search, content playback, authentication, and private/public profile workflows.
- The retained content catalog and completion data provide real course, lesson, resource, access, and progress states; future work must not replace these with fabricated proof.
- `scripts/profile-contract.ts`, the routing/search/sitemap contracts, and the Phase 1 access/progress probes provide agent-readable evidence for privacy, route, access, and completion behavior.
- `apps/web/public/eggo-watering.png` is the available app-owned mascot asset.
- No testimonials, customer logos, press claims, or externally validated outcome metrics are established here; future interfaces must not fabricate them.

## Product Principles

- Respect the learner's time with concise content and direct paths to useful material.
- Make access, progress, and account state immediately legible and trustworthy.
- Preserve customer value and established routes without rebuilding legacy baggage.
- Let real learning activity demonstrate progress instead of manufacturing status.
- Keep private account truth clearly separated from public learning identity.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Preserve full keyboard operation, visible focus, semantic headings and landmarks, sufficient contrast in both color schemes, and status communication that does not rely on color alone. Respect reduced-motion preferences and keep responsive reading order logical at narrow widths.
