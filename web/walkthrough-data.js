// Original illustrative scenes. Frames are complete states, so seeking and
// replay never depend on earlier playback. No execution API is called here.
const node = (id, label) => ({ id, label });
const state = (status, text) => ({ status, text });
const frame = (title, caption, nodes, saved = [], activeEdges = [], doneEdges = []) => ({ title, caption, nodes, saved, activeEdges, doneEdges });

export function overviewStory() {
  return { id: 'overview', title: 'Progress survives a worker restart', layout: 'line',
    nodes: [node('agent', 'Your agent'), node('state', 'Durable state'), node('worker', 'Your worker')], edges: [['agent', 'state'], ['state', 'worker']],
    frames: [
      frame('Start the work', 'Your agent submits one execution. The worker runs your code.', { agent: state('active', 'Submitting work'), state: state('idle', 'TiDB · ready'), worker: state('idle', 'Ready to run') }, [], [0]),
      frame('Save a checkpoint', 'The planning result is recorded before the workflow continues.', { agent: state('idle', 'Waiting for the result'), state: state('saved', 'Planning result saved'), worker: state('active', 'Working on the next step') }, ['Plan saved'], [1], [0]),
      frame('The worker stops', 'The process is interrupted. The saved checkpoint stays in TiDB.', { agent: state('waiting', 'Execution still pending'), state: state('saved', 'Planning result retained'), worker: state('failed', 'Worker offline') }, ['Plan saved']),
      frame('A worker returns', 'Pending work is delivered again. Recovery reads the recorded planning result.', { agent: state('waiting', 'Same execution'), state: state('saved', 'Planning result retained'), worker: state('active', 'Reading saved progress') }, ['Plan saved'], [1]),
      frame('Continue the remaining work', 'The completed plan is reused. Only the unfinished work continues.', { agent: state('idle', 'Waiting for the result'), state: state('saved', 'Plan reused'), worker: state('active', 'Completing the next step') }, ['Plan saved', 'Plan reused'], [1]),
      frame('Return the result', 'Your code finishes with its recorded progress intact.', { agent: state('saved', 'Result available'), state: state('saved', 'Result saved in TiDB'), worker: state('saved', 'Work completed') }, ['Plan saved', 'Result saved'], [], [0, 1])
    ] };
}

export function exampleStory(id, input = {}) {
  if (id === 'support-refund') {
    const nodes = [node('ticket', 'Ticket'), node('policy', 'Policy check'), node('approval', 'Human decision'), node('refund', 'Refund & reply')];
    const frames = [frame('Check the request', 'The agent loads a simulated ticket and checks the refund policy.', { ticket: state('saved', 'Ticket loaded'), policy: state('active', 'Checking eligibility') }, ['Ticket saved'], [0])];
    if (input.requireApproval !== false) frames.push(
      frame('Wait for a person', 'The policy check is saved. No refund is issued while the decision is pending.', { ticket: state('saved', 'Ticket loaded'), policy: state('saved', 'Eligible'), approval: state('waiting', 'Waiting for approval') }, ['Ticket saved', 'Policy saved'], [1], [0]),
      frame('The worker can go offline', 'The wait lives in TiDB. Closing the browser or stopping the worker does not erase it.', { ticket: state('saved', 'Ticket retained'), policy: state('saved', 'Policy retained'), approval: state('waiting', 'Decision pending'), refund: state('idle', 'No refund yet') }, ['Ticket saved', 'Policy saved']),
      frame('Save the decision', 'A person approves. The decision is recorded even if no worker is online.', { ticket: state('saved', 'Ticket retained'), policy: state('saved', 'Eligible'), approval: state('saved', 'Approved'), refund: state('waiting', 'Ready when a worker returns') }, ['Policy saved', 'Approval saved'], [], [0, 1])
    );
    else frames.push(frame('The policy permits automatic processing', 'This preset skips the human gate and records the policy result.', { ticket: state('saved', 'Ticket loaded'), policy: state('saved', 'Automatic policy'), approval: state('saved', 'Not required') }, ['Policy saved'], [], [0, 1]));
    frames.push(frame('Resume and finish', 'A connected worker issues the simulated refund and saves the reply.', { ticket: state('saved', 'Ticket loaded'), policy: state('saved', 'Eligible'), approval: state('saved', input.requireApproval === false ? 'Not required' : 'Approved'), refund: state('saved', 'Refund & reply saved') }, ['Policy saved', ...(input.requireApproval === false ? [] : ['Approval saved']), 'Refund saved'], [], [0, 1, 2]));
    return { id, title: 'A refund that waits for you', layout: 'line', nodes, edges: [['ticket', 'policy'], ['policy', 'approval'], ['approval', 'refund']], frames };
  }
  if (id === 'tool-retry') {
    const fails = input.failTimes ?? 2, max = input.maxAttempts ?? 4;
    const frames = [frame('Plan once', 'The planning result becomes a checkpoint before the first tool call.', { plan: state('saved', 'Plan recorded'), tool: state('idle', 'Ready'), wait: state('idle', 'No wait yet'), result: state('idle', 'Not published') }, ['Plan saved'])];
    const count = Math.min(fails + 1, max);
    for (let attempt = 1; attempt <= count; attempt++) {
      if (attempt > fails) {
        frames.push(frame('The tool recovers', `Attempt ${attempt} returns 200. The saved plan and earlier responses remain available.`, { plan: state('saved', 'Reused'), tool: state('saved', `Attempt ${attempt} · 200`), wait: state('saved', attempt > 1 ? 'Waits completed' : 'No wait needed'), result: state('saved', 'Result saved') }, ['Plan saved', `${attempt - 1} failures recorded`, 'Result saved'], [], attempt > 1 ? [0, 1, 2, 3] : [0, 3]));
      } else {
        frames.push(frame(`Attempt ${attempt} is rate limited`, 'A 429 response is recorded. A failed tool response is still saved progress.', { plan: state('saved', 'Reused'), tool: state('failed', `Attempt ${attempt} · 429`), wait: state('idle', 'Not waiting yet'), result: state('idle', 'Not published') }, ['Plan saved', `${attempt} failures recorded`], [attempt > 1 ? 2 : 0]));
        if (attempt < max) frames.push(frame('Wait without keeping a process alive', `A durable timer schedules the next attempt after ${(input.backoffSeconds ?? 2) * 2 ** (attempt - 1)} seconds. A restart keeps the recorded plan and responses.`, { plan: state('saved', 'Retained'), tool: state('waiting', 'Retry scheduled'), wait: state('waiting', 'Timer stored in TiDB'), result: state('idle', 'Not published') }, ['Plan saved', `${attempt} failures recorded`], [1]));
      }
    }
    if (fails >= max) frames.push(frame('Stop at the retry limit', 'The budget is exhausted. The run reports that outcome without publishing a successful result.', { plan: state('saved', 'Retained'), tool: state('failed', `${max} failed attempts`), wait: state('idle', 'No more retries'), result: state('waiting', 'Retry budget exhausted') }, ['Plan saved', `${max} failures recorded`]));
    return { id, title: 'An agent that gets past rate limits', layout: 'retry', nodes: [node('plan', 'Plan'), node('tool', 'Tool call'), node('wait', 'Durable wait'), node('result', 'Result')], edges: [['plan', 'tool'], ['tool', 'wait'], ['wait', 'tool'], ['tool', 'result']], frames };
  }
  if (id === 'order-saga') {
    const nodes = [node('stock', 'Inventory'), node('payment', 'Payment'), node('shipping', 'Shipment'), node('outcome', 'Order outcome')];
    const frames = [
      frame('Reserve the inventory', 'A simulated inventory reservation is recorded.', { stock: state('saved', 'Stock reserved') }, ['Reservation saved']),
      frame('Charge the payment', 'The simulated charge is saved before attempting shipping.', { stock: state('saved', 'Stock reserved'), payment: state('saved', 'Payment charged'), shipping: state('active', 'Booking shipment') }, ['Reservation saved', 'Charge saved'], [1], [0])
    ];
    if (input.failShipment !== false) frames.push(
      frame('Shipping fails', 'The shipping error is visible. The earlier reservation and charge still need to be handled.', { stock: state('saved', 'Stock reserved'), payment: state('saved', 'Payment charged'), shipping: state('failed', 'Provider unavailable') }, ['Reservation saved', 'Charge saved']),
      frame('Compensate the charge', 'The workflow explicitly refunds the simulated payment. This is a new action, not a database rollback.', { stock: state('saved', 'Still reserved'), payment: state('saved', 'Payment refunded'), shipping: state('failed', 'Shipping failed'), outcome: state('waiting', 'Compensation in progress') }, ['Charge saved', 'Refund saved'], [3]),
      frame('Release inventory', 'Compensation continues in reverse order: refund first, then release the reservation.', { stock: state('saved', 'Stock released'), payment: state('saved', 'Payment refunded'), shipping: state('failed', 'Shipping failed'), outcome: state('active', 'Saving outcome') }, ['Refund saved', 'Release saved'], [4]),
      frame('The order is compensated', 'The run finishes with a Compensated outcome. Both the failure and the recovery actions stay inspectable.', { stock: state('saved', 'Stock released'), payment: state('saved', 'Payment refunded'), shipping: state('failed', 'Failure retained'), outcome: state('saved', 'Compensated') }, ['Refund saved', 'Release saved', 'Outcome saved'], [], [2])
    );
    else frames.push(frame('Fulfill the order', 'Shipping succeeds. No refund or inventory release is needed.', { stock: state('saved', 'Stock allocated'), payment: state('saved', 'Payment charged'), shipping: state('saved', 'Shipment booked'), outcome: state('saved', 'Fulfilled') }, ['Reservation saved', 'Charge saved', 'Shipment saved'], [], [0, 1, 2]));
    return { id, title: 'An order that cleans up after failure', layout: 'line', nodes, edges: [['stock', 'payment'], ['payment', 'shipping'], ['shipping', 'outcome'], ['shipping', 'payment'], ['payment', 'stock']], frames };
  }
  if (id === 'document-pipeline') {
    const count = Math.max(2, Math.min(4, input.documentCount ?? 3));
    const docs = Array.from({ length: count }, (_, i) => node(`doc${i + 1}`, `Document ${i + 1}`));
    const saved = [], base = { batch: state('saved', 'Batch prepared'), join: state('waiting', 'Waiting for every branch') };
    const frames = [frame('Start the batch', 'One batch fans out into independent document branches.', { ...base, ...Object.fromEntries(docs.map(d => [d.id, state('active', 'Processing')])) }, ['Batch saved'], docs.map((_, i) => i * 2))];
    for (let i = 0; i < count; i++) {
      saved.push(`Document ${i + 1} indexed`);
      frames.push(frame(`Document ${i + 1} is saved`, i < count - 1 ? 'This branch is complete while the others keep working. Its saved result remains available across a worker restart.' : 'Every document now has its own saved extraction and indexing results.', { ...base, ...Object.fromEntries(docs.map((d, j) => [d.id, state(j <= i ? 'saved' : 'active', j <= i ? 'Indexed · saved' : 'Still processing')])) }, ['Batch saved', ...saved], docs.flatMap((_, j) => j > i ? [j * 2] : []), docs.flatMap((_, j) => j <= i ? [j * 2, j * 2 + 1] : [])));
    }
    frames.push(frame('Join the saved results', 'The batch report is built only after all document branches have completed.', { batch: state('saved', 'Batch prepared'), ...Object.fromEntries(docs.map(d => [d.id, state('saved', 'Indexed · saved')])), join: state('saved', `${count} documents indexed`) }, [...saved, 'Report saved'], [], docs.flatMap((_, i) => [i * 2, i * 2 + 1])));
    return { id, title: 'A document batch with parallel progress', layout: 'parallel', nodes: [node('batch', 'Batch'), ...docs, node('join', 'Index report')], edges: docs.flatMap(d => [['batch', d.id], [d.id, 'join']]), frames };
  }
  throw new Error('Unknown walkthrough');
}
