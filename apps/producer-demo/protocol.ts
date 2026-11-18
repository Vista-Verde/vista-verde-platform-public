import {z} from 'zod';

export const PRODUCER_VERSION='ms-print.v1' as const;
const uuid=z.uuid(),instant=z.iso.datetime(),minor=z.number().int().nonnegative().max(100_000_000);
export const briefSchema=z.strictObject({need:z.string().trim().min(3).max(1000),material:z.string().trim().min(1).max(100),
  quantity:z.number().int().min(1).max(20),budgetMinor:minor,deliveryBy:instant.optional(),
  stl:z.literal('not_provided'),scenario:z.enum(['normal','fail_after_start'])});
const command={schemaVersion:z.literal(PRODUCER_VERSION),runId:uuid,commandId:uuid};
export const submitSchema=z.strictObject({...command,brief:briefSchema});
export const acceptSchema=z.strictObject({...command,requestId:uuid,quoteId:uuid,quoteRevision:z.literal(1),termsDigest:z.string().regex(/^[a-f0-9]{64}$/)});
export const readSchema=z.strictObject({schemaVersion:z.literal(PRODUCER_VERSION),runId:uuid.optional(),requestId:uuid.optional()});
export const actionSchemas={read:readSchema,submit:submitSchema,accept:acceptSchema};
export type ProducerAction=keyof typeof actionSchemas;
export type Brief=z.infer<typeof briefSchema>;
export type Submit=z.infer<typeof submitSchema>;
export type Accept=z.infer<typeof acceptSchema>;
export type ReadExchange=z.infer<typeof readSchema>;
export const messageSchema=z.strictObject({messageId:uuid,correlationId:uuid,replyTo:uuid.nullable(),sequence:z.number().int().positive(),
  sender:z.enum(['requester','producer']),kind:z.enum(['SubmitPartRequest','QuoteReady','AcceptQuote','ProducerAccepted','JobStatus']),at:instant,summary:z.string().max(1500)});
export const quoteSchema=z.strictObject({quoteId:uuid,revision:z.literal(1),priceMinor:minor,currency:z.literal('USD'),leadHours:z.number().int().positive(),
  leadStarts:z.literal('producer_acceptance'),expiresAt:instant,termsDigest:z.string().regex(/^[a-f0-9]{64}$/),assumptions:z.array(z.string()),blockers:z.array(z.string())});
export const exchangeSchema=z.strictObject({requestId:uuid,runId:uuid,revision:z.literal(1),submitCommandId:uuid,brief:briefSchema,quote:quoteSchema,
  createdAt:instant,job:z.strictObject({jobId:uuid,quoteId:uuid,acceptedAt:instant,producerAcceptedAt:instant,
    state:z.enum(['queued','printing','completed_simulated','failed_simulated']),sequence:z.number().int().positive()}).nullable(),messages:z.array(messageSchema).max(12)});
export type Exchange=z.infer<typeof exchangeSchema>;
export const viewSchema=z.strictObject({schemaVersion:z.literal(PRODUCER_VERSION),ok:z.literal(true),runId:uuid,observedAt:instant,
  requester:z.literal('deterministic'),producer:z.literal('simulated'),exchange:exchangeSchema.nullable(),
  recent:z.array(z.strictObject({requestId:uuid,need:z.string(),state:z.string()})).max(10)});
export type ExchangeView=z.infer<typeof viewSchema>;
export const producerCodes=['INVALID_REQUEST','FORBIDDEN','UNAVAILABLE','RUN_CHANGED','NOT_FOUND','IDEMPOTENCY_CONFLICT','QUOTE_EXPIRED','TERMS_CHANGED','BUDGET_EXCEEDED','DEADLINE_MISSED','ALREADY_ACCEPTED','RUN_FULL'] as const;
export type ProducerCode=typeof producerCodes[number];
export class ProducerError extends Error { readonly code:ProducerCode;constructor(code:ProducerCode){super(code);this.code=code;} }
export const healthSchema=z.strictObject({schemaVersion:z.literal(PRODUCER_VERSION),runId:uuid,healthy:z.literal(true)});
export const failureSchema=z.strictObject({schemaVersion:z.literal(PRODUCER_VERSION),ok:z.literal(false),code:z.enum(producerCodes),retryable:z.boolean()});
export const dollars=(minorUnits:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(minorUnits/100);
