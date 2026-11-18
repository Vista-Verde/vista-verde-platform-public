import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { randomUUID } from 'node:crypto';
import { operations, envelope, BASELINE } from '../../../packages/contracts/src/index.ts';
import type { Operation, Envelope } from '../../../packages/contracts/src/index.ts';
import { BusinessError } from '../../../packages/domain/src/index.ts';
import { compose } from './composition.ts';

const { pool,repository,application } = await compose(process.env.VV_DATABASE_URL ?? '',process.env.VV_FIXTURE_MODE);
const credential = process.env.VV_FIXTURE_CREDENTIAL ?? '';
// Bootstrap requires authentication; identity is never a tool argument.
await repository.authenticate(credential);
const handle = serveStdio(() => {
  const server = new McpServer({ name: 'vista-verde-foundation',version: BASELINE });
  for (const operation of Object.keys(operations) as Operation[]) server.registerTool(operation,
    { description: `Vista Verde synthetic goods market and slot profile: ${operation}. Contract ${BASELINE}.`,inputSchema: operations[operation],outputSchema: envelope },
    async (input: unknown) => {
      let response: Envelope;
      try { response = await application.execute(operation,input,await repository.authenticate(credential,randomUUID())); }
      catch (error) {
        response = { schemaVersion: BASELINE,ok: false,code: error instanceof BusinessError ? error.code : 'INTERNAL_ERROR',
          message: 'Fixture authorization failed.',retryable: false,fieldIssues: [] };
      }
      return { content: [{ type: 'text' as const,text: JSON.stringify(response) }],structuredContent: response,isError: !response.ok };
    });
  return server;
});
let closed = false;
async function close() { if (!closed) { closed=true; await handle.close(); await pool.end(); } }
process.stdin.once('end',() => { void close(); });
process.once('SIGTERM',() => { void close(); });
process.once('SIGINT',() => { void close(); });
