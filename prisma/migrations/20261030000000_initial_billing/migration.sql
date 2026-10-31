-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "osId" TEXT NOT NULL,
    "sagaId" TEXT NOT NULL,
    "filialId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "totalInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "status" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteItem" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceInCents" INTEGER NOT NULL,

    CONSTRAINT "QuoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteDecision" (
    "quoteId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteDecision_pkey" PRIMARY KEY ("quoteId")
);

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "osId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "externalReference" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeAttempt" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "status" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivedWebhook" (
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivedWebhook_pkey" PRIMARY KEY ("provider","eventId")
);

-- CreateTable
CREATE TABLE "Inbox" (
    "consumer" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "Inbox_pkey" PRIMARY KEY ("consumer","messageId")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimUntil" TIMESTAMP(3),
    "claimOwner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "IdempotencyRequest" (
    "actorId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRequest_pkey" PRIMARY KEY ("actorId","route","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quote_osId_version_key" ON "Quote"("osId", "version");

-- CreateIndex
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_externalReference_key" ON "Charge"("externalReference");

-- CreateIndex
CREATE UNIQUE INDEX "Charge_providerOrderId_key" ON "Charge"("providerOrderId");

-- CreateIndex
CREATE INDEX "Charge_osId_idx" ON "Charge"("osId");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeAttempt_operationId_key" ON "ChargeAttempt"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeAttempt_providerKey_key" ON "ChargeAttempt"("providerKey");

-- CreateIndex
CREATE INDEX "ChargeAttempt_chargeId_idx" ON "ChargeAttempt"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "Payment_chargeId_idx" ON "Payment"("chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_operationId_key" ON "Refund"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Inbox_operationId_idx" ON "Inbox"("operationId");

-- CreateIndex
CREATE INDEX "Inbox_status_receivedAt_idx" ON "Inbox"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "Outbox_status_nextAttemptAt_idx" ON "Outbox"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteDecision" ADD CONSTRAINT "QuoteDecision_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeAttempt" ADD CONSTRAINT "ChargeAttempt_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_amount_check" CHECK ("totalInCents" >= 0 AND "currency" = 'BRL' AND "version" > 0 AND "revision" >= 0);
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_amount_check" CHECK ("quantity" > 0 AND "unitPriceInCents" >= 0);
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_amount_check" CHECK ("amountInCents" > 0 AND "currency" = 'BRL');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_check" CHECK ("amountInCents" > 0 AND "currency" = 'BRL');
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amountInCents" > 0);
ALTER TABLE "QuoteDecision" ADD CONSTRAINT "QuoteDecision_value_check" CHECK ("decision" IN ('APPROVED', 'REJECTED'));

