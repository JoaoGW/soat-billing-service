import { observability } from './instrumentation';
import { ObservabilityShutdown } from './shutdown';
jest.mock('./instrumentation', () => ({ observability: { shutdown: jest.fn().mockResolvedValue(undefined) } }));
it('aguarda a liberação dos spans ao encerrar a aplicação', async () => {
  await new ObservabilityShutdown().onApplicationShutdown();
  expect(observability?.shutdown).toHaveBeenCalledTimes(1);
});
