import { exampleStory } from './walkthrough-data.js';

const cases = { support_refund: 'support-refund', tool_retry: 'tool-retry', order_fulfillment: 'order-saga', document_pipeline: 'document-pipeline' };
const names = { loadTicket: 'Ticket', checkRefundPolicy: 'Policy check', issueRefund: 'Refund', publishReply: 'Reply', planToolCall: 'Plan', callMockTool: 'Tool attempt', saveToolResult: 'Tool result', reserveStock: 'Stock reservation', chargePayment: 'Charge', bookShipment: 'Shipment', refundPayment: 'Payment refund', releaseStock: 'Stock release', prepareBatch: 'Batch', processDocument: 'Document', extractFields: 'Extraction', indexDocument: 'Index', buildIndexReport: 'Batch report', plan: 'Plan', report: 'Report' };
const isTimer = step => Boolean(step.tags?.['resonate:timer']);
const isApproval = step => step.tags?.['cloud:wait'] === 'approval';
const elapsed = step => isTimer(step) && ['resolved', 'rejected_timedout'].includes(step.state);
const order = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true });
function label(step) { return step.tags?.['cloud:label'] || names[step.function] || (isTimer(step) ? 'Durable wait' : isApproval(step) ? 'Approval' : step.function || 'Promise'); }

// This projection consumes server records only. It never advances state on a
// timer or substitutes the illustrative walkthrough's predicted frames.
export function liveExecutionScene(run, presence = {}) {
  const caseId = cases[run.function];
  if (caseId && run.version !== 1) return null;
  if (!caseId && run.function !== 'research') return null;
  const input = run.input && typeof run.input === 'object' ? run.input : {};
  const base = caseId ? exampleStory(caseId, caseId === 'document-pipeline' ? { documentCount: Math.max(2, Math.min(4, Number(input.documentCount) || 3)) } : {})
    : { title: 'Durable research', layout: 'line', nodes: [{ id: 'plan', label: 'Plan' }, { id: 'wait', label: 'Durable wait' }, { id: 'approval', label: 'Approval' }, { id: 'result', label: 'Report' }], edges: [['plan', 'wait'], ['wait', 'approval'], ['approval', 'result']] };
  const steps = (run.steps ?? []).filter(step => step.id !== run.id).sort(order);
  const byFunction = name => steps.filter(step => step.function === name);
  const last = values => values.at(-1);
  const status = step => {
    if (!step) return 'idle';
    if (step.state === 'resolved' || elapsed(step)) return 'saved';
    if (step.state === 'pending') return isTimer(step) || isApproval(step) || run.state !== 'pending' || presence.known && presence.online === 0 ? 'waiting' : 'active';
    return step.state === 'rejected_canceled' ? 'waiting' : 'failed';
  };
  const description = step => !step ? run.truncated ? 'Not in this view' : run.state === 'pending' ? 'Not started' : 'Not run'
    : elapsed(step) ? 'Timer elapsed' : step.state === 'resolved' ? 'Saved' : step.state === 'pending' ? run.state !== 'pending' ? 'Unfinished' : isTimer(step) ? 'Timer pending' : isApproval(step) ? 'Decision pending' : 'Pending'
      : step.state === 'rejected_canceled' ? 'Canceled' : 'Failed';
  const states = {}, stepIds = {};
  function set(id, step, text) { states[id] = { status: status(step), text: text ?? description(step) }; if (step) stepIds[id] = step.id; }
  const timers = steps.filter(isTimer), approvals = steps.filter(isApproval);
  if (caseId === 'support-refund') {
    set('ticket', last(byFunction('loadTicket'))); set('policy', last(byFunction('checkRefundPolicy')));
    const approval = last(approvals);
    set('approval', approval, approval?.state === 'resolved' ? approval.result?.approved ? 'Approved · saved' : 'Declined · saved' : undefined);
    if (!approval && input.requireApproval === false) states.approval = { status: 'idle', text: 'Not required by this preset' };
    const refund = last(byFunction('issueRefund')), reply = last(byFunction('publishReply'));
    set('refund', reply ?? refund, reply?.state === 'resolved' ? 'Refund & reply saved' : refund?.state === 'resolved' ? 'Refund saved · reply pending' : undefined);
    if (refund?.state === 'resolved' && reply?.state !== 'resolved' && run.state === 'pending') states.refund.status = reply ? status(reply) : 'waiting';
  } else if (caseId === 'tool-retry') {
    set('plan', last(byFunction('planToolCall'))); set('wait', last(timers)); set('result', last(byFunction('saveToolResult')));
    const attempts = byFunction('callMockTool'), attempt = last(attempts);
    set('tool', attempt, attempt?.result?.status ? `Attempt ${attempt.result.attempt ?? attempts.length} · ${attempt.result.status}` : attempt ? `Attempt ${attempts.length} · ${description(attempt).toLowerCase()}` : undefined);
    if (attempt?.state === 'resolved' && attempt.result?.ok === false) states.tool.status = 'failed';
    if (run.result?.outcome === 'exhausted') states.result = { status: 'failed', text: 'Retry budget exhausted' };
    if (!timers.length && run.state === 'resolved') states.wait = { status: 'idle', text: 'No wait recorded' };
  } else if (caseId === 'order-saga') {
    const reserved = last(byFunction('reserveStock')), released = last(byFunction('releaseStock'));
    const charged = last(byFunction('chargePayment')), refunded = last(byFunction('refundPayment'));
    set('stock', released ?? reserved, released?.state === 'resolved' ? 'Stock released · saved' : released ? `Release ${description(released).toLowerCase()}` : reserved?.state === 'resolved' ? 'Stock reserved · saved' : undefined);
    set('payment', refunded ?? charged, refunded?.state === 'resolved' ? 'Payment refunded · saved' : refunded ? `Refund ${description(refunded).toLowerCase()}` : charged?.state === 'resolved' ? 'Payment charged · saved' : undefined);
    set('shipping', last(byFunction('bookShipment')));
    states.outcome = { status: run.state === 'resolved' ? 'saved' : run.state === 'pending' ? 'waiting' : 'failed', text: run.result?.outcome === 'compensated' ? 'Compensated' : run.result?.outcome === 'fulfilled' ? 'Fulfilled' : run.state === 'pending' ? 'Pending' : 'Execution ended' };
    stepIds.outcome = run.id;
  } else if (caseId === 'document-pipeline') {
    set('batch', last(byFunction('prepareBatch'))); set('join', last(byFunction('buildIndexReport')));
    const branches = byFunction('processDocument').filter(step => step.parentId === run.id);
    for (const [index, node] of base.nodes.filter(node => /^doc\d+$/.test(node.id)).entries()) {
      const branch = branches[index], children = branch ? steps.filter(step => step.parentId === branch.id) : [];
      const failure = children.find(step => status(step) === 'failed');
      const indexed = children.find(step => step.function === 'indexDocument' && step.state === 'resolved');
      const timer = children.find(step => isTimer(step) && step.state === 'pending');
      const record = failure ?? (branch?.state === 'resolved' ? branch : timer ?? branch);
      set(node.id, record, branch?.state === 'resolved' ? 'Indexed · saved' : failure ? 'Branch failed' : indexed ? 'Index saved · finishing' : timer ? 'Waiting on durable timer' : undefined);
    }
  } else {
    set('plan', last(byFunction('plan'))); set('wait', last(timers)); set('approval', last(approvals)); set('result', last(byFunction('report')));
    if (!approvals.length && input.requireApproval === false) states.approval = { status: 'idle', text: 'Not required by this preset' };
  }
  const recorded = steps.map(step => {
    const rateLimited = step.function === 'callMockTool' && step.result?.ok === false;
    return { id: step.id, label: label(step), status: rateLimited ? 'failed' : status(step),
      text: step.function === 'callMockTool' && step.result?.status ? `Attempt ${step.result.attempt ?? '?'} · ${step.result.status} recorded` : isApproval(step) && step.state === 'resolved' ? step.result?.approved ? 'Approved' : 'Declined' : description(step),
      timestamp: step.settledAt ?? (elapsed(step) ? step.timeoutAt : undefined) ?? step.createdAt, saved: step.state === 'resolved' || elapsed(step) };
  });
  const saved = recorded.filter(step => step.saved).map(step => step.label + (step.text.includes('recorded') ? ` · ${step.text}` : ' saved'));
  const ledger = saved.length > 8 ? [saved[0], ...saved.slice(-7)] : saved;
  const pendingApproval = approvals.some(step => step.state === 'pending'), pendingTimer = timers.some(step => step.state === 'pending');
  const failures = recorded.filter(step => step.status === 'failed');
  let title = 'Execution pending', caption = 'Waiting for more recorded progress from the service.';
  if (run.state !== 'pending') {
    title = { resolved: 'Execution completed', rejected: 'Execution failed', rejected_canceled: 'Execution canceled', rejected_timedout: 'Execution timed out' }[run.state] ?? 'Execution ended';
    caption = run.result?.summary ?? 'The diagram shows this execution’s recorded outcome.';
  } else if (pendingApproval) { title = 'Waiting for approval'; caption = 'Completed checks are saved. Submit a decision to continue this execution.'; }
  else if (presence.known && presence.online === 0) { title = 'Waiting for a worker'; caption = 'No compatible worker is reporting online. Recorded progress is retained; pending work can continue when a worker returns.'; }
  else if (pendingTimer) { title = caseId === 'tool-retry' ? 'Waiting before the next attempt' : 'Waiting on a durable timer'; caption = failures.length ? `${failures.length} failed response${failures.length === 1 ? '' : 's'} recorded. The service retains the completed steps while the timer is pending.` : 'The wait and completed checkpoints are saved. The next state will appear when the service records it.'; }
  else if (caseId === 'order-saga' && (byFunction('refundPayment').length || byFunction('releaseStock').length)) { title = 'Compensation in progress'; caption = 'Shipping failed. The diagram follows the recorded refund and inventory-release actions.'; }
  else if (saved.length) { title = 'Continuing from recorded progress'; caption = 'Saved steps remain visible while unfinished work continues. Pending steps reflect the latest server snapshot.'; }
  const activeEdges = [], doneEdges = [];
  base.edges.forEach(([from, to], index) => {
    if (!stepIds[from] || !stepIds[to]) return;
    if (states[from]?.status === 'saved' && states[to]?.status === 'saved') doneEdges.push(index);
    if (run.state === 'pending' && ['active', 'waiting'].includes(states[to]?.status) && ['saved', 'failed'].includes(states[from]?.status)) activeEdges.push(index);
  });
  // Reverse edges are shown only when an actual retry/compensation checkpoint
  // exists. A planned branch alone never becomes an observed event.
  if (caseId === 'tool-retry') {
    if (byFunction('callMockTool').length < 2) { remove(activeEdges, 2); remove(doneEdges, 2); }
  }
  if (caseId === 'order-saga') {
    for (const [edge, fn] of [[3, 'refundPayment'], [4, 'releaseStock']]) {
      remove(activeEdges, edge); remove(doneEdges, edge);
      const step = last(byFunction(fn)); if (step) (step.state === 'resolved' ? doneEdges : run.state === 'pending' ? activeEdges : []).push(edge);
    }
  }
  const task = run.tasks?.find(task => task.id === run.id);
  return { id: run.id, title: base.title, layout: base.layout, nodes: base.nodes, edges: base.edges,
    frames: [{ title, caption, nodes: states, saved: ledger, activeEdges, doneEdges }],
    live: { executionId: run.id, state: run.state, stepIds, records: recorded, completedSteps: recorded.filter(step => step.saved).length, failedSteps: failures.length,
      workerText: presence.known ? `${presence.online} compatible worker${presence.online === 1 ? '' : 's'} reporting` : 'Worker presence not yet available', taskState: task?.state, truncated: Boolean(run.truncated) } };
}
function remove(values, value) { const index = values.indexOf(value); if (index >= 0) values.splice(index, 1); }
