-- Postgres-backed state that lived in Redis before the move to Cloudflare:
-- the escalating lockout of the rate-limited tRPC procedures, and the
-- per-slot dispatch record that keeps cron triggers idempotent.

-- CreateTable
CREATE TABLE "rate_limit_blocks" (
    "path" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "strikes" INTEGER NOT NULL DEFAULT 1,
    "blockedUntil" TIMESTAMP(3) NOT NULL,
    "strikeExpiresAt" TIMESTAMP(3) NOT NULL,
    "cooldownUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_blocks_pkey" PRIMARY KEY ("path","fingerprint")
);

-- CreateTable
CREATE TABLE "cron_runs" (
    "name" TEXT NOT NULL,
    "slot" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("name","slot")
);

-- CreateIndex
CREATE INDEX "rate_limit_blocks_strikeExpiresAt_idx" ON "rate_limit_blocks"("strikeExpiresAt");

-- CreateIndex
CREATE INDEX "cron_runs_createdAt_idx" ON "cron_runs"("createdAt");
