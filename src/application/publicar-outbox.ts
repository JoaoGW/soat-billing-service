import { randomUUID } from 'node:crypto';
import { Outbox, PrismaClient } from '@prisma/client';

export interface MessagePublisher {
  publish(message: { messageId: string; type: string; payload: unknown }): Promise<void>;
}

/** Publishes at least once. The same messageId is reused after an uncertain send. */
export class OutboxDispatcher {
  constructor(private readonly prisma: PrismaClient, private readonly publisher: MessagePublisher) {}

  async dispatchOne(now = new Date()): Promise<'EMPTY' | 'SENT' | 'RETRY' | 'FAILED' | 'CLAIM_LOST'> {
    const owner = randomUUID();
    const until = new Date(now.getTime() + 30000);
    const rows = await this.prisma.$queryRaw<Outbox[]>`
      WITH candidate AS (
        SELECT "messageId" FROM "Outbox"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
          AND ("claimUntil" IS NULL OR "claimUntil" <= ${now})
        ORDER BY "createdAt", "messageId"
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "Outbox" AS item SET "claimOwner" = ${owner}, "claimUntil" = ${until}
      FROM candidate WHERE item."messageId" = candidate."messageId"
      RETURNING item.*`;
    const item = rows[0];
    if (!item) return 'EMPTY';
    try {
      await this.publisher.publish({ messageId: item.messageId, type: item.type, payload: item.payload });
    } catch {
      const attempts = item.attemptCount + 1;
      const failed = attempts >= 5;
      const retryAt = new Date(now.getTime() + Math.min(60000, 1000 * 2 ** (attempts - 1)));
      const updated = await this.prisma.outbox.updateMany({
        where: { messageId: item.messageId, status: 'PENDING', claimOwner: owner },
        data: { status: failed ? 'FAILED' : 'PENDING', attemptCount: attempts, nextAttemptAt: retryAt, claimOwner: null, claimUntil: null },
      });
      return updated.count === 1 ? (failed ? 'FAILED' : 'RETRY') : 'CLAIM_LOST';
    }
    const updated = await this.prisma.outbox.updateMany({
      where: { messageId: item.messageId, status: 'PENDING', claimOwner: owner },
      data: { status: 'SENT', publishedAt: new Date(), claimOwner: null, claimUntil: null },
    });
    return updated.count === 1 ? 'SENT' : 'CLAIM_LOST';
  }
}
