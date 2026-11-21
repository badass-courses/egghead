-- Rails paid-access export for scripts/access-delta.ts (format egghead-rails-access-export/v3).
--
-- Read-only. Run against the Rails Postgres database (a read replica is fine):
--
--   psql "$RAILS_DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
--     -f scripts/sql/rails-access-export.sql > rails-access-export.jsonl
--
-- Output: one JSON object per line. Every line has a "kind":
--   user          a Rails user referenced by any line below (identity + email)
--   role_grant    a global special role (lifetime_subscriber, VIP, staff roles)
--   basic_grant   the global legacy `basic` role (ADR-0007 default grant)
--   subscription  an active/trialing/past_due/unpaid account subscription and members
--   purchase      a viewable sellable purchase
--   pro_holder    a user holding the global `pro` role: Rails' own access decision
--                 (Ability#lesson_permissions checks is_pro?). Cross-check only
--   backing_grant live legacy backing for `pro`: an active gift, an active managed
--                 subscription or an active legacy subscription (grants access)
--   manifest      always the LAST line: row counts computed in the same snapshot
--
-- The delta script refuses any file whose manifest is missing, is not the last
-- line, or whose counts disagree with the lines it read, so a truncated export
-- can never be mistaken for "these users lost access".
--
-- Subscription access follows ADR-0008; non-subscription promises remain separate:
--   * Only active inside current_period_end grants. The boundary (integer epoch
--     seconds in Rails) is exported as UTC ISO for entitlement expiresAt.
--     trialing/past_due/unpaid remain visible for denied-access loss reporting;
--     their scoped seats do not become bare-pro fallback grants.
--   * Rails `datetime` columns are UTC `timestamp without time zone`; they
--     serialize without an offset and the delta script reads them as UTC.
--   * Team access flows through the scoped `account_member` role, not raw
--     account_users rows. Members without that role are exported with
--     hasMemberRole=false (org structure, no grant).
--   * Purchases grant while expires_at is NULL or in the future and the
--     purchase_state is not access_revoked. Bulk and country flags are exported;
--     the delta script applies the bulk/country rules.
--   * pro_holder lines carry each `pro` holder's latest sign-in date
--     (GREATEST(current_sign_in_at, last_sign_in_at)). Bare `pro` (no special
--     role, basic, seat, membership purchase or live backing) is granted only
--     when the delta's --bare-pro-active-days window covers that date; the rest
--     is held (quarantine rows stay as the July projection wrote them). Pro
--     holders get user lines so a recently active one can be resolved.
--   * Backed `pro`: grants follow Rails `is_pro?` today, and backing only
--     explains the grant and sets its expiry. Backing is exported only for
--     users holding `pro`, `basic` or a special role (Ability#lesson_permissions
--     unlocks pro content for is_basic?, is_pro? and is_instructor?). Backing
--     for anyone else is counted in manifest.backedWithoutPro and never exported.
--     ProStatusChecker ignores these paths; Subscription#hard_cancel! keeps
--     `pro` for them:
--       gift                  gifts.user_id while claimed_at +
--                             COALESCE(duration_months, 12) months is in the
--                             future (Gift.active, app/models/gift.rb). expiresAt
--                             is that end.
--       managed_subscription  users.managed_subscription_id -> is_active + paid-through subscription
--                             (User#belongs_to_active_managed_subscription?)
--       legacy_subscription   subscriptions.user_id with cancelled_on IS NULL and
--                             "willCancelAfterPeriod" = false (Subscription.active,
--                             app/models/subscription.rb). currentPeriodEnd is
--                             exported as metadata only (separate legacy backing law).
--
-- It never selects passwords, tokens, IP addresses, Stripe ids or billing info.

\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset footer off

-- NOW() compares with zoneless UTC timestamps (expires_at); pin the session zone.
SET TIME ZONE 'UTC';

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH
reportable_status(status) AS (
  VALUES ('trialing'), ('active'), ('past_due'), ('unpaid')
),
special_role_name(name) AS (
  VALUES ('admin'), ('analyst'), ('content_tester'), ('editor'), ('instructor'),
         ('publisher'), ('VIP'), ('lifetime_subscriber')
),
special_roles AS (
  SELECT DISTINCT ur.user_id, r.name AS role_name
  FROM users_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.resource_type IS NULL
    AND r.name IN (SELECT name FROM special_role_name)
),
basic_roles AS (
  SELECT DISTINCT ur.user_id
  FROM users_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.resource_type IS NULL AND r.name = 'basic'
),
subscription_facts AS (
  SELECT
    s.id,
    s.account_id,
    s.status,
    s.quantity,
    s.current_period_start,
    s.current_period_end,
    s.cancel_at_period_end,
    s.created_at,
    a.name AS account_name,
    a.slug AS account_slug,
    a.guid AS account_guid,
    a.stripe_customer_id IS NOT NULL AS stripe_customer_id_present,
    s.stripe_subscription_id IS NOT NULL AS stripe_subscription_id_present
  FROM account_subscriptions s
  LEFT JOIN accounts a ON a.id = s.account_id
  WHERE s.status IN (SELECT status FROM reportable_status)
),
role_members AS (
  SELECT
    ur.user_id,
    r.resource_id AS account_id,
    BOOL_OR(r.name = 'account_member') AS has_member_role,
    BOOL_OR(r.name = 'account_owner') AS has_owner_role
  FROM users_roles ur
  JOIN roles r
    ON r.id = ur.role_id
   AND r.resource_type = 'Account'
   AND r.name IN ('account_owner', 'account_member')
  WHERE r.resource_id IN (SELECT account_id FROM subscription_facts)
  GROUP BY ur.user_id, r.resource_id
),
sub_members AS (
  SELECT
    au.id AS account_user_id,
    COALESCE(au.account_id, rm.account_id) AS account_id,
    COALESCE(au.user_id, rm.user_id) AS user_id,
    au.created_at,
    COALESCE(rm.has_member_role, FALSE) AS has_member_role,
    COALESCE(rm.has_owner_role, FALSE) AS has_owner_role
  FROM account_users au
  FULL OUTER JOIN role_members rm
    ON rm.account_id = au.account_id AND rm.user_id = au.user_id
  WHERE COALESCE(au.account_id, rm.account_id) IN (SELECT account_id FROM subscription_facts)
),
viewable_purchases AS (
  SELECT
    sp.id,
    sp.user_id,
    sp.sellable_type,
    sp.sellable_id,
    sp.purchase_state,
    sp.bulk,
    sp.expires_at,
    sp.created_at,
    sp.application_id,
    NULLIF(BTRIM(cp.conditions ->> 'restricted_to_country'), '') AS restricted_to_country
  FROM sellable_purchases sp
  LEFT JOIN coupons cp ON cp.id = sp.coupon_id
  -- Rails is multi-tenant: Just JavaScript, Epic React, Testing JavaScript,
  -- Technical Interviews and Pure React sell through this same table. Only
  -- egghead's own applications grant egghead access: 10 (egghead.io course
  -- purchases) and 111 (egghead lifetime memberships). NULL is the pre-application
  -- egghead era. The delta script re-checks this list (EGGHEAD_RAILS_APPLICATION_IDS).
  WHERE (sp.application_id IS NULL OR sp.application_id IN (10, 111))
    AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
    AND (sp.purchase_state IS NULL OR sp.purchase_state <> 'access_revoked')
),
pro_holders AS (
  SELECT DISTINCT ur.user_id
  FROM users_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.resource_type IS NULL AND r.name = 'pro'
),
-- Live legacy backing. Gifts: Gift.active (claimed_at within COALESCE(duration_months, 12)
-- months; NULL claimed_at never matches, 0 months is already over). Managed: is_active
-- plus an uncancelled subscriptions row paid through current_date (a Rails date).
-- Invalid managed backing stays in the export as a reasoned hold, never a grant.
-- Legacy subscriptions: Subscription.active (cancelled_on IS NULL and
-- willCancelAfterPeriod = FALSE; NULL is not false, as in Rails' where(... false)).
all_backing AS (
  SELECT 'gift' AS source, g.id AS source_id, g.user_id,
         g.claimed_at + (COALESCE(g.duration_months, 12) || ' months')::interval AS expires_at,
         NULL::date AS current_period_end, NULL::text AS held_reason
  FROM gifts g
  WHERE g.user_id IS NOT NULL
    AND g.claimed_at >= NOW() - (COALESCE(g.duration_months, 12) || ' months')::interval
  UNION ALL
  SELECT 'managed_subscription', ms.id, u.id, NULL::timestamp, ls."currentPeriodEnd",
         CASE WHEN ls.id IS NULL THEN 'no_subscription'
              WHEN ls.cancelled_on IS NOT NULL THEN 'cancelled'
              WHEN ls."currentPeriodEnd" IS NULL THEN 'no_period_end'
              WHEN ls."currentPeriodEnd" < current_date THEN 'period_end_stale'
              ELSE NULL END
  FROM users u
  JOIN managed_subscriptions ms ON ms.id = u.managed_subscription_id
  LEFT JOIN subscriptions ls ON ls.id = ms.subscription_id
  WHERE ms.is_active
  UNION ALL
  SELECT 'legacy_subscription', ls.id, ls.user_id, NULL::timestamp, ls."currentPeriodEnd", NULL::text
  FROM subscriptions ls
  WHERE ls.user_id IS NOT NULL
    AND ls.cancelled_on IS NULL
    AND ls."willCancelAfterPeriod" = FALSE
),
-- Backing grants only users Rails grants as pro today (is_pro?, or the basic and
-- special roles Ability#lesson_permissions treats the same). Everyone else is
-- counted in the manifest and never exported.
pro_eligible AS (
  SELECT user_id FROM pro_holders
  UNION SELECT user_id FROM special_roles
  UNION SELECT user_id FROM basic_roles
),
backing AS (
  SELECT * FROM all_backing WHERE user_id IN (SELECT user_id FROM pro_eligible)
),
referenced_users AS (
  SELECT user_id FROM special_roles
  UNION SELECT user_id FROM basic_roles
  UNION SELECT user_id FROM sub_members WHERE user_id IS NOT NULL
  UNION SELECT user_id FROM viewable_purchases WHERE user_id IS NOT NULL
  UNION SELECT user_id FROM backing
  -- Bare pro holders may be granted when recently active; the delta ignores the
  -- dormant ones (no create, no email sync).
  UNION SELECT user_id FROM pro_holders
),
user_lines AS (
  SELECT 1 AS ord, u.id AS sort_id, json_build_object(
    'kind', 'user',
    'railsUserId', u.id::text,
    'email', u.email,
    'firstName', u.first_name,
    'lastName', u.last_name,
    'avatarUrl', u.avatar_url,
    'confirmedAt', u.confirmed_at,
    'createdAt', u.created_at,
    'isBanned', COALESCE(u.is_banned, FALSE),
    'signInCount', COALESCE(u.sign_in_count, 0),
    'hasAuthenticationToken', u.authentication_token IS NOT NULL
  )::text AS line
  FROM users u
  JOIN referenced_users ru ON ru.user_id = u.id
),
role_lines AS (
  SELECT 2 AS ord, sr.user_id AS sort_id, json_build_object(
    'kind', 'role_grant',
    'railsUserId', sr.user_id::text,
    'roleName', sr.role_name
  )::text AS line
  FROM special_roles sr
),
basic_lines AS (
  SELECT 3 AS ord, br.user_id AS sort_id, json_build_object(
    'kind', 'basic_grant',
    'railsUserId', br.user_id::text
  )::text AS line
  FROM basic_roles br
),
subscription_lines AS (
  SELECT 4 AS ord, s.id AS sort_id, json_build_object(
    'kind', 'subscription',
    'railsAccountSubscriptionId', s.id::text,
    'railsAccountId', s.account_id::text,
    'accountName', s.account_name,
    'accountSlug', s.account_slug,
    'accountGuid', s.account_guid,
    'status', s.status,
    'quantity', COALESCE(s.quantity, 0),
    -- account_subscriptions stores Stripe periods as integer epoch seconds.
    'currentPeriodStart', to_char(to_timestamp(s.current_period_start) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'currentPeriodEnd', to_char(to_timestamp(s.current_period_end) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'cancelAtPeriodEnd', COALESCE(s.cancel_at_period_end, FALSE),
    'createdAt', s.created_at,
    'stripeCustomerIdPresent', s.stripe_customer_id_present,
    'stripeSubscriptionIdPresent', s.stripe_subscription_id_present,
    'members', COALESCE((
      SELECT json_agg(json_build_object(
        'railsAccountUserId', m.account_user_id::text,
        'railsUserId', m.user_id::text,
        'hasMemberRole', m.has_member_role,
        'hasOwnerRole', m.has_owner_role,
        'createdAt', m.created_at
      ) ORDER BY m.user_id, m.account_user_id)
      FROM sub_members m
      WHERE m.account_id = s.account_id AND m.user_id IS NOT NULL
    ), '[]'::json)
  )::text AS line
  FROM subscription_facts s
),
purchase_lines AS (
  SELECT 5 AS ord, p.id AS sort_id, json_build_object(
    'kind', 'purchase',
    'railsSellablePurchaseId', p.id::text,
    'railsUserId', p.user_id::text,
    'railsApplicationId', p.application_id::text,
    'sellableType', p.sellable_type,
    'sellableId', p.sellable_id::text,
    'purchaseState', p.purchase_state,
    'bulk', COALESCE(p.bulk, FALSE),
    'restrictedToCountry', p.restricted_to_country,
    'expiresAt', p.expires_at,
    'createdAt', p.created_at
  )::text AS line
  FROM viewable_purchases p
  WHERE p.user_id IS NOT NULL
),
pro_holder_lines AS (
  SELECT 6 AS ord, ph.user_id AS sort_id, json_build_object(
    'kind', 'pro_holder',
    'railsUserId', ph.user_id::text,
    -- Date only. GREATEST ignores NULLs; null means never signed in.
    'lastSignInOn', to_char(GREATEST(u.current_sign_in_at, u.last_sign_in_at), 'YYYY-MM-DD')
  )::text AS line
  FROM pro_holders ph
  LEFT JOIN users u ON u.id = ph.user_id
),
backing_lines AS (
  SELECT 7 AS ord, b.user_id AS sort_id, json_build_object(
    'kind', 'backing_grant',
    'source', b.source,
    'railsSourceId', b.source_id::text,
    'railsUserId', b.user_id::text,
    'expiresAt', b.expires_at,
    'currentPeriodEnd', b.current_period_end,
    'heldReason', b.held_reason
  )::text AS line
  FROM backing b
),
manifest_line AS (
  SELECT 9 AS ord, 0::bigint AS sort_id, json_build_object(
    'kind', 'manifest',
    'format', 'egghead-rails-access-export/v3',
    'exportedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'counts', json_build_object(
      'user', (SELECT COUNT(*) FROM user_lines),
      'role_grant', (SELECT COUNT(*) FROM role_lines),
      'basic_grant', (SELECT COUNT(*) FROM basic_lines),
      'subscription', (SELECT COUNT(*) FROM subscription_lines),
      'purchase', (SELECT COUNT(*) FROM purchase_lines),
      'pro_holder', (SELECT COUNT(*) FROM pro_holder_lines),
      'backing_grant', (SELECT COUNT(*) FROM backing_lines)
    ),
    'backedWithoutPro', json_build_object(
      'gift', (SELECT COUNT(*) FROM all_backing b WHERE b.source = 'gift'
               AND b.user_id NOT IN (SELECT user_id FROM pro_eligible)),
      'managed_subscription', (SELECT COUNT(*) FROM all_backing b WHERE b.source = 'managed_subscription'
               AND b.user_id NOT IN (SELECT user_id FROM pro_eligible)),
      'legacy_subscription', (SELECT COUNT(*) FROM all_backing b WHERE b.source = 'legacy_subscription'
               AND b.user_id NOT IN (SELECT user_id FROM pro_eligible))
    )
  )::text AS line
)
SELECT line FROM (
  SELECT ord, sort_id, line FROM user_lines
  UNION ALL SELECT ord, sort_id, line FROM role_lines
  UNION ALL SELECT ord, sort_id, line FROM basic_lines
  UNION ALL SELECT ord, sort_id, line FROM subscription_lines
  UNION ALL SELECT ord, sort_id, line FROM purchase_lines
  UNION ALL SELECT ord, sort_id, line FROM pro_holder_lines
  UNION ALL SELECT ord, sort_id, line FROM backing_lines
  UNION ALL SELECT ord, sort_id, line FROM manifest_line
) export_lines
ORDER BY ord, sort_id, line;

COMMIT;
