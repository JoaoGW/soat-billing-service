import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class BillingDatabase extends PrismaClient implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> { await this.$disconnect(); }
}
