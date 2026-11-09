import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { observability } from './instrumentation';

@Injectable()
export class ObservabilityShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> { await observability?.shutdown(); }
}
