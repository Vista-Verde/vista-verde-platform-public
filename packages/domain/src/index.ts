import { z } from 'zod';
import { BASELINE, contextSchema, normalize, commandNames, success } from '../../contracts/src/index.ts';
import type { Context, Envelope, ErrorCode, Input, Operation, Success, Command, CommandInput } from '../../contracts/src/index.ts';

export class BusinessError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.code = code; }
}
export function demand(condition: unknown, code: ErrorCode): asserts condition {
  if (!condition) throw new BusinessError(code);
}
export function safeTotal(values: number[]): number {
  return values.reduce((sum, v) => { demand(Number.isSafeInteger(sum + v), 'VALIDATION_FAILED'); return sum + v; }, 0);
}
export function result(state: string, recordIds: Record<string, string>, data: Success['data'] = {},
  revisions: Success['revisions'] = {}, nextActor: string | null = null, nextAction: string | null = null): Success {
  return success.parse({ schemaVersion: BASELINE, ok: true, synthetic: true, state, recordIds,
    revisions, data, nextActor, nextAction });
}
// Domain ports: no SQL driver, transport, SDK or infrastructure import.
export interface Repository {
  command(context: Context, operation: Command, input: CommandInput): Promise<Success>;
  query<O extends Operation>(context: Context, operation: O, input: Input<O>): Promise<Success>;
}
export class Application {
  #repository: Repository;
  constructor(repository: Repository) { this.#repository = repository; }
  async execute(operation: Operation, raw: unknown, trustedContext: Context): Promise<Envelope> {
    try {
      const context = contextSchema.parse(trustedContext);
      const input = normalize(operation, raw);
      const isCommand = (commandNames as readonly string[]).includes(operation);
      return isCommand
        ? await this.#repository.command(context, operation as Command, input as CommandInput)
        : await this.#repository.query(context, operation, input);
    } catch (error) {
      if (error instanceof z.ZodError) return { schemaVersion: BASELINE, ok: false, code: 'VALIDATION_FAILED',
        message: 'Command fields do not match the shared contract.', retryable: false,
        fieldIssues: error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) };
      if (error instanceof BusinessError) return { schemaVersion: BASELINE, ok: false, code: error.code,
        message: error.code === 'FORBIDDEN' ? 'This operation or record is not available to this grant.' : error.code,
        retryable: error.code === 'RETRYABLE_BUSY', fieldIssues: [] };
      // Do not expose SQL, fixture credentials, foreign IDs or driver error messages.
      return { schemaVersion: BASELINE, ok: false, code: 'INTERNAL_ERROR', message: 'The command did not complete.',
        retryable: false, fieldIssues: [] };
    }
  }
}
