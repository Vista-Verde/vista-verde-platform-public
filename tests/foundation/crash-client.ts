import { compose } from '../../apps/api/src/composition.ts';
import type { Context,Command,CommandInput } from '../../packages/contracts/src/index.ts';

const { application } = await compose(process.env.VV_DATABASE_URL ?? '','local_test');
process.once('message',async (message: { context: Context; operation: Command; input: CommandInput }) => {
  const receipt = await application.execute(message.operation,message.input,message.context);
  // Deliberately lose the response after commit; the parent only observes process exit.
  process.exit(receipt.ok ? 9 : 10);
});
