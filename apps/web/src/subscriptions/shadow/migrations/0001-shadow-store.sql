-- Apply ONLY to the dedicated subscription-shadow PlanetScale database/branch.
-- Never run through the main application's schema migration/deployment pipeline.
-- No customer table, foreign key, trigger, upsert or expiry policy is introduced.
CREATE TABLE ShadowEventClaim (
  stripeEventId VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimOwner VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimedUntil DATETIME(6) NOT NULL,
  completedAt DATETIME(6) NULL,
  PRIMARY KEY (stripeEventId)
) ENGINE=InnoDB;

CREATE TABLE ShadowRecord (
  stripeEventId VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observedAt BIGINT UNSIGNED NOT NULL,
  record JSON NOT NULL,
  PRIMARY KEY (stripeEventId),
  KEY shadow_record_observed_at (observedAt)
) ENGINE=InnoDB;
