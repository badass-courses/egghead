CREATE TABLE `egghead_Account` (
  `userId` varchar(255) NOT NULL,
  `type` varchar(255) NOT NULL,
  `provider` varchar(255) NOT NULL,
  `providerAccountId` varchar(255) NOT NULL,
  `refresh_token` text,
  `access_token` text,
  `oauth_token` text,
  `oauth_token_secret` text,
  `expires_at` int DEFAULT NULL,
  `token_type` varchar(255) DEFAULT NULL,
  `scope` varchar(255) DEFAULT NULL,
  `id_token` text,
  `session_state` varchar(255) DEFAULT NULL,
  `refresh_token_expires_in` int DEFAULT NULL,
  PRIMARY KEY (`provider`,`providerAccountId`),
  KEY `userId_idx` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_CommunicationChannel` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `name_idx` (`name`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_CommunicationPreference` (
  `id` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `channelId` varchar(255) NOT NULL,
  `preferenceLevel` enum('low','medium','high') NOT NULL DEFAULT 'medium',
  `preferenceTypeId` varchar(255) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `optInAt` timestamp(3) NULL DEFAULT NULL,
  `optOutAt` timestamp(3) NULL DEFAULT NULL,
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `organizationMembershipId` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `userId_idx` (`userId`),
  KEY `preferenceTypeId_idx` (`preferenceTypeId`),
  KEY `channelId_idx` (`channelId`),
  KEY `organizationMembershipId_idx` (`organizationMembershipId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_CommunicationPreferenceType` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT NULL,
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContentContribution` (
  `id` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `contentId` varchar(255) NOT NULL,
  `contributionTypeId` varchar(255) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `organizationMembershipId` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `userId_idx` (`userId`),
  KEY `contentId_idx` (`contentId`),
  KEY `contributionTypeId_idx` (`contributionTypeId`),
  KEY `organizationMembershipId_idx` (`organizationMembershipId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContentResource` (
  `id` varchar(255) NOT NULL,
  `type` varchar(255) NOT NULL,
  `createdById` varchar(255) NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `currentVersionId` varchar(255) DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `createdByOrganizationMembershipId` varchar(191) DEFAULT NULL,
  `slug` varchar(255) GENERATED ALWAYS AS (json_unquote(json_extract(`fields`,_utf8mb4'$.slug'))) STORED,
  PRIMARY KEY (`id`),
  KEY `type_idx` (`type`),
  KEY `createdById_idx` (`createdById`),
  KEY `createdAt_idx` (`createdAt`),
  KEY `currentVersionId_idx` (`currentVersionId`),
  KEY `createdByOrganizationMembershipId_idx` (`createdByOrganizationMembershipId`),
  KEY `slug_idx` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContentResourceProduct` (
  `productId` varchar(255) NOT NULL,
  `resourceId` varchar(255) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `position` double NOT NULL DEFAULT '0',
  `metadata` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`productId`,`resourceId`),
  KEY `contentResourceId_idx` (`productId`),
  KEY `resourceId_idx` (`resourceId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContentResourceResource` (
  `resourceOfId` varchar(255) NOT NULL,
  `resourceId` varchar(255) NOT NULL,
  `position` double NOT NULL DEFAULT '0',
  `metadata` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`resourceOfId`,`resourceId`),
  KEY `contentResourceId_idx` (`resourceOfId`),
  KEY `resourceId_idx` (`resourceId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContentResourceTag` (
  `contentResourceId` varchar(255) NOT NULL,
  `tagId` varchar(255) NOT NULL,
  `position` double NOT NULL DEFAULT '0',
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`contentResourceId`,`tagId`),
  KEY `contentResourceId_idx` (`contentResourceId`),
  KEY `tagId_idx` (`tagId`),
  KEY `position_idx` (`position`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContentResourceVersion` (
  `id` varchar(255) NOT NULL,
  `resourceId` varchar(255) NOT NULL,
  `parentVersionId` varchar(255) DEFAULT NULL,
  `versionNumber` int NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdById` varchar(255) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_resource_version_number` (`resourceId`,`versionNumber`),
  KEY `resourceId_idx` (`resourceId`),
  KEY `parentVersionId_idx` (`parentVersionId`),
  KEY `resourceId_versionNumber_idx` (`resourceId`,`versionNumber`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ContributionType` (
  `id` varchar(255) NOT NULL,
  `slug` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `egghead_ContributionType_slug_unique` (`slug`),
  KEY `name_idx` (`name`),
  KEY `slug_idx` (`slug`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Coupon` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `code` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires` timestamp(3) NULL DEFAULT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `maxUses` int NOT NULL DEFAULT '-1',
  `default` tinyint(1) NOT NULL DEFAULT '0',
  `merchantCouponId` varchar(191) DEFAULT NULL,
  `status` int NOT NULL DEFAULT '0',
  `usedCount` int NOT NULL DEFAULT '0',
  `percentageDiscount` decimal(3,2) NOT NULL,
  `restrictedToProductId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `Coupon_code_key` (`code`),
  KEY `Coupon_id_code_index` (`id`,`code`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_DeviceAccessToken` (
  `scope` varchar(191) DEFAULT NULL,
  `expiresAt` timestamp(3) NULL DEFAULT NULL,
  `revokedAt` timestamp(3) NULL DEFAULT NULL,
  `token` varchar(191) NOT NULL,
  `userId` varchar(191) NOT NULL,
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `organizationMembershipId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`token`),
  KEY `userId_idx` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_DeviceVerification` (
  `verifiedByUserId` varchar(255) DEFAULT NULL,
  `deviceCode` varchar(191) NOT NULL,
  `userCode` text NOT NULL,
  `expires` timestamp(3) NOT NULL,
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `verifiedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`deviceCode`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Entitlement` (
  `id` varchar(191) NOT NULL,
  `entitlementType` varchar(255) NOT NULL,
  `userId` varchar(191) DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `organizationMembershipId` varchar(191) DEFAULT NULL,
  `sourceType` varchar(255) NOT NULL,
  `sourceId` varchar(191) NOT NULL,
  `metadata` json DEFAULT (_utf8mb4'{}'),
  `expiresAt` timestamp(3) NULL DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `userId_idx` (`userId`),
  KEY `orgId_idx` (`organizationId`),
  KEY `source_idx` (`sourceType`,`sourceId`),
  KEY `type_idx` (`entitlementType`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_EntitlementType` (
  `id` varchar(191) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_name_idx` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Invite` (
  `id` varchar(191) NOT NULL,
  `inviteState` enum('INITIATED','VERIFIED','CANCELED','EXPIRED','COMPLETED') NOT NULL DEFAULT 'INITIATED',
  `inviteEmail` varchar(191) NOT NULL,
  `acceptedEmail` varchar(191) DEFAULT NULL,
  `userId` varchar(255) DEFAULT NULL,
  `createdAt` timestamp NULL DEFAULT (now()),
  `expiresAt` timestamp NULL DEFAULT ((now() + interval 7 day)),
  `canceledAt` timestamp NULL DEFAULT NULL,
  `confirmedAt` timestamp NULL DEFAULT NULL,
  `completedAt` timestamp NULL DEFAULT NULL,
  `invitedById` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantAccount` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `status` int NOT NULL DEFAULT '0',
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `label` varchar(191) DEFAULT NULL,
  `identifier` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantCharge` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `status` int NOT NULL DEFAULT '0',
  `identifier` varchar(191) NOT NULL,
  `userId` varchar(191) NOT NULL,
  `merchantAccountId` varchar(191) NOT NULL,
  `merchantProductId` varchar(191) NOT NULL,
  `merchantSubscriptionId` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `merchantCustomerId` varchar(191) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `MerchantCharge_identifier_key` (`identifier`),
  KEY `merchantSubscriptionId_idx` (`merchantSubscriptionId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantCoupon` (
  `id` varchar(191) NOT NULL,
  `identifier` varchar(191) DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `status` int NOT NULL DEFAULT '0',
  `merchantAccountId` varchar(191) NOT NULL,
  `percentageDiscount` decimal(3,2) NOT NULL,
  `type` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `MerchantCoupon_identifier_key` (`identifier`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantCustomer` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `userId` varchar(191) NOT NULL,
  `merchantAccountId` varchar(191) NOT NULL,
  `identifier` varchar(191) NOT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `status` int DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `MerchantCustomer_identifier_key` (`identifier`),
  KEY `idx_MerchantCustomer_on_userId` (`userId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantPrice` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `merchantAccountId` varchar(191) NOT NULL,
  `merchantProductId` varchar(191) NOT NULL,
  `status` int DEFAULT '0',
  `identifier` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `priceId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `MerchantPrice_identifier_key` (`identifier`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantProduct` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `merchantAccountId` varchar(191) NOT NULL,
  `productId` varchar(191) NOT NULL,
  `status` int NOT NULL DEFAULT '0',
  `identifier` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `MerchantProduct_identifier_key` (`identifier`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_MerchantSession` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `identifier` varchar(191) NOT NULL,
  `merchantAccountId` varchar(191) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Organization` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `image` varchar(255) DEFAULT NULL,
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `personalOrganizationUserId` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `personalOrganizationUserId_idx` (`personalOrganizationUserId`),
  KEY `created_at_idx` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_OrganizationMembership` (
  `id` varchar(255) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `role` varchar(191) NOT NULL DEFAULT 'user',
  `invitedById` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `personalOrganizationUserId` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `personalOrganizationUserId_idx` (`personalOrganizationUserId`),
  KEY `role_idx` (`role`),
  KEY `created_at_idx` (`createdAt`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_OrganizationMembershipRole` (
  `organizationMembershipId` varchar(255) NOT NULL,
  `roleId` varchar(255) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `organizationId` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`organizationMembershipId`,`roleId`),
  KEY `orgMemberId_idx` (`organizationMembershipId`),
  KEY `roleId_idx` (`roleId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Permission` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `egghead_Permission_name_unique` (`name`),
  KEY `name_idx` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Price` (
  `id` varchar(191) NOT NULL,
  `productId` varchar(191) DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `nickname` varchar(191) DEFAULT NULL,
  `status` int NOT NULL DEFAULT '0',
  `unitAmount` decimal(10,2) NOT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `fields` json DEFAULT (_utf8mb4'{}'),
  PRIMARY KEY (`id`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Product` (
  `id` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `name` varchar(191) NOT NULL,
  `key` varchar(191) DEFAULT NULL,
  `type` varchar(191) DEFAULT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `status` int NOT NULL DEFAULT '0',
  `quantityAvailable` int NOT NULL DEFAULT '-1',
  PRIMARY KEY (`id`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Profile` (
  `id` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `type` varchar(255) NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_type_idx` (`userId`,`type`),
  KEY `userId_idx` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Purchase` (
  `id` varchar(191) NOT NULL,
  `userId` varchar(191) DEFAULT NULL,
  `organizationMembershipId` varchar(191) DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `totalAmount` decimal(65,30) NOT NULL,
  `ip_address` varchar(191) DEFAULT NULL,
  `city` varchar(191) DEFAULT NULL,
  `state` varchar(191) DEFAULT NULL,
  `country` varchar(191) DEFAULT NULL,
  `couponId` varchar(191) DEFAULT NULL,
  `productId` varchar(191) NOT NULL,
  `merchantChargeId` varchar(191) DEFAULT NULL,
  `upgradedFromId` varchar(191) DEFAULT NULL,
  `status` varchar(191) NOT NULL DEFAULT 'Valid',
  `bulkCouponId` varchar(191) DEFAULT NULL,
  `merchantSessionId` varchar(191) DEFAULT NULL,
  `redeemedBulkCouponId` varchar(191) DEFAULT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  PRIMARY KEY (`id`),
  UNIQUE KEY `Purchase_upgradedFromId_key` (`upgradedFromId`),
  KEY `idx_Purchase_on_merchantChargeId` (`merchantChargeId`),
  KEY `organizationId_idx` (`organizationId`),
  KEY `organizationMembershipId_idx` (`organizationMembershipId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_PurchaseUserTransfer` (
  `id` varchar(191) NOT NULL,
  `transferState` enum('AVAILABLE','INITIATED','VERIFIED','CANCELED','EXPIRED','CONFIRMED','COMPLETED') NOT NULL DEFAULT 'AVAILABLE',
  `purchaseId` varchar(191) NOT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  `sourceUserId` varchar(191) NOT NULL,
  `targetUserId` varchar(191) DEFAULT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` timestamp(3) NULL DEFAULT NULL,
  `canceledAt` timestamp(3) NULL DEFAULT NULL,
  `confirmedAt` timestamp(3) NULL DEFAULT NULL,
  `completedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_ResourceProgress` (
  `userId` varchar(255) NOT NULL,
  `resourceId` varchar(255) NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `completedAt` datetime(3) DEFAULT NULL,
  `updatedAt` datetime(3) DEFAULT NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `organizationId` varchar(191) DEFAULT NULL,
  `organizationMembershipId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`userId`,`resourceId`),
  KEY `crp_userId_contentResourceId_idx` (`userId`,`resourceId`),
  KEY `contentResourceId_idx` (`resourceId`),
  KEY `resourceId_idx` (`userId`),
  KEY `organizationMembershipId_idx` (`organizationMembershipId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Role` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_name_per_org` (`organizationId`,`name`),
  KEY `name_idx` (`name`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_RolePermission` (
  `roleId` varchar(255) NOT NULL,
  `permissionId` varchar(255) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  PRIMARY KEY (`roleId`,`permissionId`),
  KEY `roleId_idx` (`roleId`),
  KEY `permissionId_idx` (`permissionId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Session` (
  `sessionToken` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `expires` timestamp NOT NULL,
  PRIMARY KEY (`sessionToken`),
  KEY `userId_idx` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_Tag` (
  `id` varchar(255) NOT NULL,
  `type` varchar(255) NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `type_idx` (`type`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_TagTag` (
  `parentTagId` varchar(255) NOT NULL,
  `childTagId` varchar(255) NOT NULL,
  `position` double NOT NULL DEFAULT '0',
  `metadata` json DEFAULT (_utf8mb4'{}'),
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`parentTagId`,`childTagId`),
  KEY `parentTagId_idx` (`parentTagId`),
  KEY `childTagId_idx` (`childTagId`),
  KEY `position_idx` (`position`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_User` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `role` varchar(191) NOT NULL DEFAULT 'user',
  `email` varchar(255) NOT NULL,
  `fields` json DEFAULT (_utf8mb4'{}'),
  `emailVerified` timestamp(3) NULL DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL,
  `createdAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
  `legacyRailsUserId` varchar(255) GENERATED ALWAYS AS (json_unquote(json_extract(`fields`,_utf8mb4'$.legacyRailsUserId'))) STORED,
  `legacyContactId` varchar(255) GENERATED ALWAYS AS (json_unquote(json_extract(`fields`,_utf8mb4'$.legacyContactId'))) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `egghead_User_email_unique` (`email`),
  UNIQUE KEY `legacyRailsUserId_idx` (`legacyRailsUserId`),
  KEY `email_idx` (`email`),
  KEY `role_idx` (`role`),
  KEY `created_at_idx` (`createdAt`),
  KEY `legacyContactId_idx` (`legacyContactId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_UserPermission` (
  `userId` varchar(255) NOT NULL,
  `permissionId` varchar(255) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`userId`,`permissionId`),
  KEY `userId_idx` (`userId`),
  KEY `permissionId_idx` (`permissionId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_UserRole` (
  `userId` varchar(255) NOT NULL,
  `roleId` varchar(255) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  `updatedAt` timestamp(3) NULL DEFAULT (now()),
  `deletedAt` timestamp(3) NULL DEFAULT NULL,
  `organizationId` varchar(191) DEFAULT NULL,
  PRIMARY KEY (`userId`,`roleId`),
  KEY `userId_idx` (`userId`),
  KEY `roleId_idx` (`roleId`),
  KEY `organizationId_idx` (`organizationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `egghead_VerificationToken` (
  `identifier` varchar(255) NOT NULL,
  `token` varchar(255) NOT NULL,
  `expires` timestamp NOT NULL,
  `createdAt` timestamp(3) NULL DEFAULT (now()),
  PRIMARY KEY (`identifier`,`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
