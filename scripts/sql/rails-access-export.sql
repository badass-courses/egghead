-- Rails paid-access export for scripts/access-delta.ts (format egghead-rails-access-export/v2).
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
--   subscription  an account subscription in an enabled status, with its members
--   purchase      a viewable sellable purchase
--   pro_holder    a user holding the global `pro` role: Rails' own access decision
--                 (Ability#lesson_permissions checks is_pro?), with flags for the
--                 legacy paths outside this export that keep `pro` alive
--   manifest      always the LAST line: row counts computed in the same snapshot
--
-- The delta script refuses any file whose manifest is missing, is not the last
-- line, or whose counts disagree with the lines it read, so a truncated export
-- can never be mistaken for "these users lost access".
--
-- Access law mirrors the July 2026 projection (migrate-egghead tools/me.ts):
--   * ADR-0006 lenient status law: trialing/active/past_due subscriptions grant;
--     current_period_end (integer epoch seconds in Rails) is exported as UTC ISO
--     text for observability only.
--   * Rails `datetime` columns are UTC `timestamp without time zone`; they
--     serialize without an offset and the delta script reads them as UTC.
--   * Team access flows through the scoped `account_member` role, not raw
--     account_users rows. Members without that role are exported with
--     hasMemberRole=false (org structure, no grant).
--   * Purchases grant while expires_at is NULL or in the future and the
--     purchase_state is not access_revoked. Bulk and country flags are exported;
--     the delta script applies the bulk/country rules.
--   * Bare legacy `pro` never grants (quarantine rows stay as the July
--     projection wrote them). The pro_holder lines exist only so the delta can
--     cross-check the export against Rails' decision; they grant nothing.
--   * pro_holder flags (app/models/gift.rb, managed_subscription.rb,
--     subscription.rb; Subscription#hard_cancel! keeps `pro` for these):
--       activeGift                 gifts.user_id, claimed_at within
--                                  COALESCE(duration_months, 12) months (Gift.active)
--       activeManagedSubscription  users.managed_subscription_id -> is_active
--       activeLegacySubscription   subscriptions.user_id, cancelled_on IS NULL and
--                                  "willCancelAfterPeriod" = false (Subscription.active)
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
enabled_status(status) AS (
  VALUES ('trialing'), ('active'), ('past_due')
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
enabled_subs AS (
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
  WHERE s.status IN (SELECT status FROM enabled_status)
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
  WHERE r.resource_id IN (SELECT account_id FROM enabled_subs)
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
  WHERE COALESCE(au.account_id, rm.account_id) IN (SELECT account_id FROM enabled_subs)
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
    NULLIF(BTRIM(cp.conditions ->> 'restricted_to_country'), '') AS restricted_to_country
  FROM sellable_purchases sp
  LEFT JOIN coupons cp ON cp.id = sp.coupon_id
  WHERE (sp.expires_at IS NULL OR sp.expires_at > NOW())
    AND (sp.purchase_state IS NULL OR sp.purchase_state <> 'access_revoked')
),
pro_holders AS (
  SELECT DISTINCT ur.user_id
  FROM users_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.resource_type IS NULL AND r.name = 'pro'
),
referenced_users AS (
  SELECT user_id FROM special_roles
  UNION SELECT user_id FROM basic_roles
  UNION SELECT user_id FROM sub_members WHERE user_id IS NOT NULL
  UNION SELECT user_id FROM viewable_purchases WHERE user_id IS NOT NULL
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
  FROM enabled_subs s
),
purchase_lines AS (
  SELECT 5 AS ord, p.id AS sort_id, json_build_object(
    'kind', 'purchase',
    'railsSellablePurchaseId', p.id::text,
    'railsUserId', p.user_id::text,
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
    'activeGift', EXISTS (
      SELECT 1 FROM gifts g
      WHERE g.user_id = ph.user_id
        AND g.claimed_at >= NOW() - (COALESCE(g.duration_months, 12) || ' months')::interval
    ),
    'activeManagedSubscription', EXISTS (
      SELECT 1 FROM users u
      JOIN managed_subscriptions ms ON ms.id = u.managed_subscription_id
      WHERE u.id = ph.user_id AND ms.is_active
    ),
    'activeLegacySubscription', EXISTS (
      SELECT 1 FROM subscriptions ls
      WHERE ls.user_id = ph.user_id
        AND ls.cancelled_on IS NULL
        AND ls."willCancelAfterPeriod" = FALSE
    )
  )::text AS line
  FROM pro_holders ph
),
manifest_line AS (
  SELECT 9 AS ord, 0::bigint AS sort_id, json_build_object(
    'kind', 'manifest',
    'format', 'egghead-rails-access-export/v2',
    'exportedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'counts', json_build_object(
      'user', (SELECT COUNT(*) FROM user_lines),
      'role_grant', (SELECT COUNT(*) FROM role_lines),
      'basic_grant', (SELECT COUNT(*) FROM basic_lines),
      'subscription', (SELECT COUNT(*) FROM subscription_lines),
      'purchase', (SELECT COUNT(*) FROM purchase_lines),
      'pro_holder', (SELECT COUNT(*) FROM pro_holder_lines)
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
  UNION ALL SELECT ord, sort_id, line FROM manifest_line
) export_lines
ORDER BY ord, sort_id, line;

COMMIT;
