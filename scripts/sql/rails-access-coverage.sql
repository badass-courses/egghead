-- Rails legacy-access coverage counts for the access delta (read-only).
--
--   psql "$RAILS_DATABASE_URL" -X -q -A -v ON_ERROR_STOP=1 \
--     -f scripts/sql/rails-access-coverage.sql
--
-- The access export covers special roles, `basic`, enabled account
-- subscriptions and viewable sellable purchases. Three legacy paths outside it
-- can keep a user's global `pro` role alive (Subscription#hard_cancel! skips
-- removing `pro` for them). Each row counts one path, and how many of its users
-- hold `pro` today. A path with 0 users is dead; any other count is a decision
-- for the desk: carry it over as paid access, or accept it as a pro gap.
--
-- Aggregates only: no ids, emails or names leave Rails.

SET TIME ZONE 'UTC';

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH
pro_holders AS (
  SELECT DISTINCT ur.user_id
  FROM users_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE r.resource_type IS NULL AND r.name = 'pro'
),
active_gift_users AS (
  -- Gift.active: claimed_at within COALESCE(duration_months, 12) months.
  SELECT DISTINCT g.user_id
  FROM gifts g
  WHERE g.user_id IS NOT NULL
    AND g.claimed_at >= NOW() - (COALESCE(g.duration_months, 12) || ' months')::interval
),
legacy_gift_users AS (
  -- Active gifts with no account subscription: the export cannot see them.
  SELECT DISTINCT g.user_id
  FROM gifts g
  WHERE g.user_id IS NOT NULL
    AND g.account_subscription_id IS NULL
    AND g.claimed_at >= NOW() - (COALESCE(g.duration_months, 12) || ' months')::interval
),
managed_users AS (
  -- User#belongs_to_active_managed_subscription?
  SELECT u.id AS user_id
  FROM users u
  JOIN managed_subscriptions ms ON ms.id = u.managed_subscription_id
  WHERE ms.is_active
),
legacy_subscription_users AS (
  -- Subscription.active: cancelled_on IS NULL AND willCancelAfterPeriod = false.
  SELECT DISTINCT ls.user_id
  FROM subscriptions ls
  WHERE ls.user_id IS NOT NULL
    AND ls.cancelled_on IS NULL
    AND ls."willCancelAfterPeriod" = FALSE
),
paths(path, user_id) AS (
  SELECT 'active_gift', user_id FROM active_gift_users
  UNION ALL SELECT 'active_gift_without_account_subscription', user_id FROM legacy_gift_users
  UNION ALL SELECT 'active_managed_subscription_member', user_id FROM managed_users
  UNION ALL SELECT 'active_legacy_subscription', user_id FROM legacy_subscription_users
)
SELECT
  p.path,
  COUNT(*) AS users,
  COUNT(ph.user_id) AS users_holding_pro
FROM paths p
LEFT JOIN pro_holders ph ON ph.user_id = p.user_id
GROUP BY p.path
UNION ALL
SELECT 'pro_holders', COUNT(*), COUNT(*) FROM pro_holders
ORDER BY 1;

COMMIT;
