import { reviewReason } from './review.js';

// Volatile single-process worker; production must persist acceptance first.
export class DemoCreditor {
  constructor({ tradingPlatform }) {
    this.tradingPlatform = tradingPlatform;
    this.intents = new Map();
    this.jobs = new Map();
  }

  addIntent(intent) {
    if (this.intents.has(intent.reference)) throw new Error('Duplicate intent reference');
    this.intents.set(intent.reference, Object.freeze({ ...intent }));
  }

  async credit(event) {
    if (!event || event.verified !== true || event.status !== 'demo_settled' ||
        typeof event.reference !== 'string' || !event.reference ||
        !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0 ||
        !Number.isSafeInteger(event.paidAt) || event.paidAt < 0 ||
        (event.payerName !== undefined && typeof event.payerName !== 'string')) {
      throw new Error('Invalid verified notification');
    }
    const payment = Object.freeze({ ...event });
    const fingerprint = JSON.stringify([payment.amountMinor, payment.currency,
      payment.paidAt, payment.payerName ?? null]);
    const previous = this.jobs.get(payment.reference);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return { status: 'needs_review', reason: 'reference_conflict' };
      }
      return { ...await previous.promise, duplicate: true };
    }
    const intent = this.intents.get(payment.reference);
    const job = { fingerprint, intent, comment: 'DEMO-DEP:' + payment.reference };
    // Reserve before asynchronous work so concurrent duplicates share one job.
    this.jobs.set(payment.reference, job);
    job.promise = this.process(job, payment);
    return job.promise;
  }

  async process(job, event) {
    const reason = reviewReason(job.intent, event);
    if (reason) return job.result = { status: 'needs_review', reason };
    job.result = { status: 'crediting' };
    try {
      const deal = await this.tradingPlatform.creditBalance(
        job.intent.login, event.amountMinor, job.comment);
      if (!deal || typeof deal.id !== 'string' || !deal.id) throw new Error('Uncertain result');
      return job.result = { status: 'credited', dealId: deal.id };
    } catch {
      // Every exception may conceal an accepted operation. Never blindly retry.
      return job.result = { status: 'credit_unknown', reason: 'lookup_required' };
    }
  }

  async recover(reference) {
    const job = this.jobs.get(reference);
    if (!job) throw new Error('Unknown job');
    await job.promise;
    if (job.result.status !== 'credit_unknown') return job.result;
    try {
      const deal = await this.tradingPlatform.findCredit(job.intent.login, job.comment);
      if (typeof deal?.id === 'string' && deal.id && deal.login === job.intent.login &&
          deal.amountMinor === job.intent.amountMinor && deal.comment === job.comment) {
        job.result = { status: 'credited', dealId: deal.id };
        job.promise = Promise.resolve(job.result);
      }
    } catch { /* Lookup failures never authorize another credit. */ }
    return job.result;
  }
}
