import { parentPort, workerData } from 'node:worker_threads';
import { SlotError, SlotService } from '../examples/slots/service.ts';
import { FIXTURE_NOW } from '../examples/slots/fixtures.ts';

const service = new SlotService(workerData.path, () => FIXTURE_NOW);
const gate = new Int32Array(workerData.gate);
parentPort!.postMessage({ ready: true });
try {
  if (Atomics.wait(gate, 0, 0, 5_000) === 'timed-out') throw new Error('race barrier timed out');
  let result;
  switch (workerData.operation) {
    case 'purchase': result = service.purchase(workerData.actor, workerData.key, workerData.input); break;
    case 'publish': result = service.publish(workerData.actor, workerData.key, workerData.input); break;
    case 'release': result = service.release(workerData.actor, workerData.key, workerData.input); break;
    default: throw new Error('unsupported test operation');
  }
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, code: error instanceof SlotError ? error.code : String(error) });
} finally { service.close(); }
