import { randomUUID } from 'node:crypto';
import { Notification, PrismaClient } from '@prisma/client';

export interface QuoteNotifier {
  send(message: { notificationId: string; recipient: string; quoteId: string; osId: string }): Promise<void>;
}

/** SMTP delivery is at least once; stable IDs do not guarantee recipient deduplication. */
export class NotificationDispatcher {
  constructor(private readonly prisma: PrismaClient, private readonly notifier: QuoteNotifier) {}

  async dispatchOne(now = new Date()): Promise<'EMPTY' | 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'CLAIM_LOST'> {
    const owner = randomUUID();
    const until = new Date(now.getTime() + 30000);
    const rows = await this.prisma.$queryRaw<Notification[]>`
      WITH candidate AS (
        SELECT "id" FROM "Notification"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
          AND ("claimUntil" IS NULL OR "claimUntil" <= ${now})
        ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "Notification" AS item SET "claimOwner" = ${owner}, "claimUntil" = ${until}
      FROM candidate WHERE item."id" = candidate."id" RETURNING item.*`;
    const item = rows[0];
    if (!item) return 'EMPTY';
    try {
      const quote = await this.prisma.quote.findUnique({ where: { id: item.quoteId }, select: { id: true, osId: true, status: true, expiresAt: true } });
      if (!quote) throw new Error('Orçamento ausente');
      if (quote.status !== 'ISSUED' || quote.expiresAt <= now) {
        const result = await this.prisma.notification.updateMany({ where: { id: item.id, status: 'PENDING', claimOwner: owner }, data: { status: 'SKIPPED', claimOwner: null, claimUntil: null } });
        return result.count === 1 ? 'SKIPPED' : 'CLAIM_LOST';
      }
      await this.notifier.send({ notificationId: item.id, recipient: item.recipient, quoteId: quote.id, osId: quote.osId });
    } catch {
      const attempts = item.attemptCount + 1;
      const failed = attempts >= 5;
      const nextAttemptAt = new Date(now.getTime() + Math.min(60000, 1000 * 2 ** (attempts - 1)));
      const result = await this.prisma.notification.updateMany({ where: { id: item.id, status: 'PENDING', claimOwner: owner }, data: { status: failed ? 'FAILED' : 'PENDING', attemptCount: attempts, nextAttemptAt, claimOwner: null, claimUntil: null } });
      return result.count === 1 ? (failed ? 'FAILED' : 'RETRY') : 'CLAIM_LOST';
    }
    const result = await this.prisma.notification.updateMany({ where: { id: item.id, status: 'PENDING', claimOwner: owner }, data: { status: 'SENT', sentAt: new Date(), claimOwner: null, claimUntil: null } });
    return result.count === 1 ? 'SENT' : 'CLAIM_LOST';
  }
}
