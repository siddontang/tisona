const text = { type: 'string', minLength: 1, maxLength: 120 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const descriptor = (name, description, properties, required) => ({ name, version: 1, group: 'examples-v1', description,
  inputSchema: { type: 'object', additionalProperties: false, properties, required } });

// Curated, original examples. Tool responses are fixtures; every checkpoint,
// approval, timer and result uses the real Resonate/TiDB execution path.
export const examples = [
  {
    id: 'support-refund', title: 'A refund that waits for you', category: 'Human approval', number: '01',
    description: 'A support agent checks a refund, waits for a person, then issues a receipt.',
    value: 'Keep human decisions and completed checks across browser and worker restarts.',
    observe: 'Approve or decline in the execution view. Before approval, no refund step runs.',
    steps: ['Load ticket', 'Check policy', 'Wait for approval', 'Refund & reply'],
    descriptor: descriptor('support_refund', 'Simulated support refund with a durable human approval gate.',
      { ticketId: text, amountCents: integer(1, 100000), requireApproval: { type: 'boolean' } }, ['ticketId', 'amountCents', 'requireApproval']),
    variants: [
      { name: 'Wait for approval', input: { ticketId: 'SUP-1042', amountCents: 8900, requireApproval: true } },
      { name: 'Automatic policy-approved refund', input: { ticketId: 'SUP-1043', amountCents: 1900, requireApproval: false } }
    ]
  },
  {
    id: 'tool-retry', title: 'An agent that gets past rate limits', category: 'Durable retries', number: '02',
    description: 'A tool returns 429 twice. The agent records each response, backs off, and finishes.',
    value: 'Resume the retry sequence without repeating a completed planning checkpoint.',
    observe: 'Inspect each failed response and the durable timers between attempts. The retry budget is bounded.',
    steps: ['Plan request', 'Call tool', 'Wait & retry', 'Save result'],
    descriptor: descriptor('tool_retry', 'Simulated rate-limited tool with checkpointed attempts and durable backoff.',
      { task: text, failTimes: integer(0, 4), maxAttempts: integer(1, 4), backoffSeconds: integer(1, 5) }, ['task', 'failTimes', 'maxAttempts', 'backoffSeconds']),
    variants: [
      { name: 'Recover after two rate limits', input: { task: 'Enrich a customer account', failTimes: 2, maxAttempts: 4, backoffSeconds: 2 } },
      { name: 'Exhaust the retry budget', input: { task: 'Enrich a customer account', failTimes: 4, maxAttempts: 3, backoffSeconds: 1 } }
    ]
  },
  {
    id: 'order-saga', title: 'An order that cleans up after failure', category: 'Saga compensation', number: '03',
    description: 'Reserve inventory and charge a payment. If shipping fails, refund and release stock.',
    value: 'Make recovery work explicit and inspectable across a multi-service business operation.',
    observe: 'The failed shipment stays visible. Compensation runs in reverse order; the final outcome says Compensated.',
    steps: ['Reserve stock', 'Charge payment', 'Book shipment', 'Refund & release'],
    descriptor: descriptor('order_fulfillment', 'Simulated order saga with explicit payment and stock compensation.',
      { orderId: text, amountCents: integer(1, 100000), failShipment: { type: 'boolean' } }, ['orderId', 'amountCents', 'failShipment']),
    variants: [
      { name: 'Shipment fails → compensate', input: { orderId: 'ORD-2048', amountCents: 12900, failShipment: true } },
      { name: 'Successful fulfillment', input: { orderId: 'ORD-2049', amountCents: 12900, failShipment: false } }
    ]
  },
  {
    id: 'document-pipeline', title: 'A document batch with parallel progress', category: 'Fan-out / fan-in', number: '04',
    description: 'Process several documents concurrently, checkpoint each result, then build one index report.',
    value: 'Track independent branches and retain completed work when a worker restarts.',
    observe: 'All document branches start before the join. Expand their timers, extraction and indexing checkpoints.',
    steps: ['Prepare batch', 'Process in parallel', 'Index each document', 'Join results'],
    descriptor: descriptor('document_pipeline', 'Simulated parallel document ingestion with durable per-document progress.',
      { batchId: text, documentCount: integer(2, 4), delaySeconds: integer(1, 8) }, ['batchId', 'documentCount', 'delaySeconds']),
    variants: [
      { name: 'Index three documents', input: { batchId: 'BATCH-001', documentCount: 3, delaySeconds: 2 } },
      { name: 'Longer wait for restart testing', input: { batchId: 'BATCH-002', documentCount: 4, delaySeconds: 8 } }
    ]
  }
];
