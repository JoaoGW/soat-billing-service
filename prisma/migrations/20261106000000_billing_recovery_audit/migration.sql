CREATE TABLE "BillingRecoveryAudit" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingRecoveryAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillingRecoveryAudit_messageId_occurredAt_idx" ON "BillingRecoveryAudit"("messageId", "occurredAt");
