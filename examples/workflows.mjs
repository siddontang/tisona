import { appendFile } from 'node:fs/promises';

async function evidence(info, step) {
  if (process.env.WORKER_AUDIT_FILE) await appendFile(process.env.WORKER_AUDIT_FILE, JSON.stringify({ execution: info.originId, step }) + '\n');
}
const effect = (info, kind, reference) => ({ simulated: true, reference, idempotencyKey: `${info.originId}:${kind}` });

async function loadTicket(info, input) { await evidence(info, 'loadTicket'); return { ...input, eligible: true, currency: 'USD' }; }
async function checkRefundPolicy(_info, ticket) { return { eligible: ticket.eligible, amountCents: ticket.amountCents, approvalRequired: ticket.requireApproval }; }
async function issueRefund(info, ticket) { await evidence(info, 'issueRefund'); return { ...effect(info, 'refund', ticket.ticketId), amountCents: ticket.amountCents }; }
async function publishReply(info, refund) { return { ...effect(info, 'reply', refund.reference), message: 'Your simulated refund has been issued.' }; }
export async function supportRefund(ctx, input) {
  const ticket = await ctx.run(loadTicket, input);
  const policy = await ctx.run(checkRefundPolicy, ticket);
  if (!policy.eligible) return { simulated: true, outcome: 'ineligible', summary: 'Policy declined the refund. No refund was issued.' };
  if (policy.approvalRequired) {
    const decision = await ctx.promise({ tags: { 'cloud:wait': 'approval', 'cloud:label': 'Refund approval',
      'cloud:prompt': `Approve a simulated USD ${(ticket.amountCents / 100).toFixed(2)} refund for ${ticket.ticketId}?` } });
    if (!decision.approved) return { simulated: true, outcome: 'declined', summary: 'Review declined. No refund or reply was issued.' };
  }
  const refund = await ctx.run(issueRefund, ticket);
  const reply = await ctx.run(publishReply, refund);
  return { simulated: true, outcome: 'refunded', summary: 'Refund and customer reply completed after the required checks.', refund, reply };
}

async function planToolCall(info, input) { await evidence(info, 'planToolCall'); return { task: input.task, tool: 'account_enrichment', simulated: true }; }
async function callMockTool(_info, input, attempt) {
  return attempt <= input.failTimes ? { simulated: true, ok: false, status: 429, attempt, message: 'Simulated rate limit' }
    : { simulated: true, ok: true, status: 200, attempt, data: { account: 'Example account', segment: 'Growth' } };
}
async function saveToolResult(info, plan, response) { await evidence(info, 'saveToolResult'); return { ...plan, response }; }
export async function toolRetry(ctx, input) {
  const plan = await ctx.run(planToolCall, input);
  const attempts = [];
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const response = await ctx.run(callMockTool, input, attempt); attempts.push(response);
    if (response.ok) {
      const saved = await ctx.run(saveToolResult, plan, response);
      return { simulated: true, outcome: 'recovered', summary: `Tool completed on attempt ${attempt}; ${attempt - 1} recorded failures and durable waits.`, attempts, saved };
    }
    if (attempt < input.maxAttempts) await ctx.sleep(input.backoffSeconds * 2 ** (attempt - 1) * 1000);
  }
  return { simulated: true, outcome: 'exhausted', summary: `Stopped after ${input.maxAttempts} recorded failures. The retry budget was exhausted.`, attempts };
}

async function reserveStock(info, input) { return { ...effect(info, 'stock', input.orderId), quantity: 1 }; }
async function chargePayment(info, input) { await evidence(info, 'chargePayment'); return { ...effect(info, 'charge', input.orderId), amountCents: input.amountCents }; }
async function bookShipment(info, input) {
  if (input.failShipment) throw new Error('Simulated shipping provider unavailable');
  return { ...effect(info, 'shipment', input.orderId), status: 'booked' };
}
async function refundPayment(info, charge) { await evidence(info, 'refundPayment'); return { ...effect(info, 'refund-charge', charge.reference), amountCents: charge.amountCents, status: 'refunded' }; }
async function releaseStock(info, stock) { await evidence(info, 'releaseStock'); return { ...effect(info, 'release-stock', stock.reference), status: 'released' }; }
export async function orderFulfillment(ctx, input) {
  const stock = await ctx.run(reserveStock, input);
  const charge = await ctx.run(chargePayment, input);
  try {
    const shipment = await ctx.run(bookShipment, input);
    return { simulated: true, outcome: 'fulfilled', summary: 'Inventory reserved, payment charged, and shipment booked.', stock, charge, shipment };
  } catch (error) {
    // Business compensation is explicit, not a database rollback. Real tools
    // must honor these stable idempotency keys and reconcile ambiguous effects.
    const refund = await ctx.run(refundPayment, charge);
    const release = await ctx.run(releaseStock, stock);
    return { simulated: true, outcome: 'compensated', summary: 'Shipping failed. Payment was refunded, then inventory was released.', reason: error.message, compensation: [refund, release] };
  }
}

async function prepareBatch(info, input) { await evidence(info, 'prepareBatch'); return { batchId: input.batchId, documents: Array.from({ length: input.documentCount }, (_, i) => `${input.batchId}-doc-${i + 1}`) }; }
async function extractFields(_info, id) { return { simulated: true, documentId: id, title: `Extracted ${id}`, chunks: 3 }; }
async function indexDocument(info, document) { await evidence(info, `indexDocument:${document.documentId}`); return { ...effect(info, `index:${document.documentId}`, document.documentId), chunks: document.chunks, status: 'indexed' }; }
async function processDocument(ctx, id, delaySeconds) {
  await ctx.sleep(delaySeconds * 1000);
  const fields = await ctx.run(extractFields, id);
  return await ctx.run(indexDocument, fields);
}
async function buildIndexReport(_info, batchId, documents) { return { simulated: true, outcome: 'indexed', summary: `${documents.length} documents indexed. Parallel branches joined into one completed batch.`, batchId, indexedDocuments: documents.length, documents }; }
export async function documentPipeline(ctx, input) {
  const batch = await ctx.run(prepareBatch, input);
  // ctx.run is eager: launch every branch before awaiting their results.
  const branches = batch.documents.map((id, index) => ctx.run(processDocument, id, input.delaySeconds * (index + 1)));
  const documents = [];
  for (const branch of branches) documents.push(await branch);
  return await ctx.run(buildIndexReport, batch.batchId, documents);
}

export const workflows = { support_refund: supportRefund, tool_retry: toolRetry, order_fulfillment: orderFulfillment, document_pipeline: documentPipeline };
