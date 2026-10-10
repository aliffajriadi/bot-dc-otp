-- CreateTable
CREATE TABLE `Order` (
    `id` VARCHAR(191) NOT NULL,
    `discordId` VARCHAR(191) NOT NULL,
    `countryId` VARCHAR(191) NOT NULL,
    `countryName` VARCHAR(191) NOT NULL,
    `operatorId` VARCHAR(191) NOT NULL,
    `operatorName` VARCHAR(191) NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `serviceName` VARCHAR(191) NOT NULL,
    `providerPrice` INTEGER NOT NULL,
    `markup` INTEGER NOT NULL,
    `paidAmount` INTEGER NOT NULL,
    `providerOrderId` VARCHAR(191) NULL,
    `phoneNumber` VARCHAR(191) NULL,
    `smsText` TEXT NULL,
    `status` ENUM('PENDING_PAYMENT', 'PAID', 'WAITING_SMS', 'COMPLETED', 'CANCEL_PENDING', 'REFUNDED', 'REFUND_FAILED', 'FAILED', 'FAILED_REFUNDED', 'NEEDS_REVIEW') NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `refundedAt` DATETIME(3) NULL,
    `failReason` VARCHAR(191) NULL,
    `dmChannelId` VARCHAR(191) NULL,
    `dmMessageId` VARCHAR(191) NULL,
    `cancelAttempts` INTEGER NOT NULL DEFAULT 0,
    `refundAttempts` INTEGER NOT NULL DEFAULT 0,
    `nextRetryAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_providerOrderId_key`(`providerOrderId`),
    INDEX `Order_discordId_idx`(`discordId`),
    INDEX `Order_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` VARCHAR(191) NOT NULL,
    `fromState` VARCHAR(191) NULL,
    `toState` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderEvent_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Setting` (
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ServiceMarkup` (
    `serviceId` VARCHAR(191) NOT NULL,
    `markup` INTEGER NOT NULL,

    PRIMARY KEY (`serviceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrderEvent` ADD CONSTRAINT `OrderEvent_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

