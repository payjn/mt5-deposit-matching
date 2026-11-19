import test from 'node:test';
import assert from 'node:assert/strict';
import { createDepositIntent } from '../src/deposit-intent.js';
import { DemoCreditor } from '../src/credit.js';

const args = () => ({ clientId: 'demo-client', login: 'demo-login-001', amountMinor: 150000,
  now: 1000, expiresAt: 2000, verifiedClientName: 'Demo Client' });
const payment = intent => ({ verified: true, status: 'demo_settled', reference: intent.reference,
  amountMinor: 150000, currency: 'IDR', paidAt: 1500, payerName: 'Demo Client' });
function setup(overrides = {}) {
  const calls = [];
  const tradingPlatform = {
    creditBalance: async (...values) => { calls.push(values); return { id: 'demo-deal' }; },
    findCredit: async () => null,
    ...overrides,
  };
  const worker = new DemoCreditor({ tradingPlatform });
  const intent = createDepositIntent(args());
  worker.addIntent(intent);
  return { worker, intent, calls };
}

test('intent binds immutable client, login, IDR, amount, expiry and unique reference', () => {
  const one = createDepositIntent(args()), two = createDepositIntent(args());
  assert.notEqual(one.reference, two.reference);
  assert.equal(one.clientId, 'demo-client');
  assert.equal(one.login, 'demo-login-001');
  assert.equal(one.currency, 'IDR');
  assert.equal(one.amountMinor, 150000);
  assert.equal(one.expiresAt, 2000);
  assert.equal(one.status, 'awaiting_payment');
  assert.throws(() => { one.login = 'another-login'; });
  for (const change of [{ clientId: '' }, { login: '' }, { amountMinor: 1.5 },
    { amountMinor: 0 }, { amountMinor: '150000' }, { expiresAt: 1000 }, { verifiedClientName: '' }]) {
    assert.throws(() => createDepositIntent({ ...args(), ...change }));
  }
});

test('concurrent duplicates and later redelivery credit the bound account once', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  const { worker, intent } = setup({ creditBalance: async (login, amount, comment) => {
    count++;
    assert.equal(login, intent.login);
    assert.equal(amount, intent.amountMinor);
    assert.equal(comment, 'DEMO-DEP:' + intent.reference);
    await gate;
    return { id: 'demo-deal' };
  } });
  const tasks = Array.from({ length: 20 }, () => worker.credit(payment(intent)));
  assert.equal(count, 1);
  release();
  const results = await Promise.all(tasks);
  assert.ok(results.every(result => result.status === 'credited'));
  assert.equal(results.filter(result => result.duplicate).length, 19);
  assert.equal((await worker.credit(payment(intent))).duplicate, true);
  assert.equal(count, 1);
  assert.throws(() => worker.addIntent(intent), /Duplicate/);
});

test('review decisions never call the platform', async () => {
  for (const [change, reason] of [
    [{ reference: 'demo-unknown' }, 'unknown_reference'], [{ amountMinor: 149999 }, 'amount_mismatch'],
    [{ amountMinor: 150001 }, 'amount_mismatch'], [{ paidAt: 2000 }, 'paid_after_expiry'],
    [{ paidAt: 2001 }, 'paid_after_expiry'], [{ payerName: 'Other Person' }, 'payer_name_mismatch'],
    [{ currency: 'USD' }, 'currency_mismatch'],
  ]) {
    const { worker, intent, calls } = setup();
    const result = await worker.credit({ ...payment(intent), ...change });
    assert.equal(result.status, 'needs_review');
    assert.equal(result.reason, reason);
    assert.equal(calls.length, 0);
  }
  const { worker, intent, calls } = setup();
  worker.intents.set(intent.reference, { ...intent, status: 'needs_review' });
  assert.equal((await worker.credit(payment(intent))).reason, 'intent_not_awaiting_payment');
  assert.equal(calls.length, 0);
});

test('optional payer name and conservative case/space normalization', async () => {
  for (const payerName of [undefined, ' demo client ']) {
    const { worker, intent, calls } = setup();
    assert.equal((await worker.credit({ ...payment(intent), payerName })).status, 'credited');
    assert.equal(calls.length, 1);
  }
});

test('changed reference payload never credits a second time', async () => {
  const { worker, intent, calls } = setup();
  await worker.credit(payment(intent));
  assert.equal((await worker.credit({ ...payment(intent), amountMinor: 160000 })).reason, 'reference_conflict');
  assert.equal(calls.length, 1);
});

test('platform acceptance followed by timeout requires lookup, never another credit', async () => {
  let count = 0, lookupCount = 0, accepted;
  const { worker, intent } = setup({
    creditBalance: async (login, amountMinor, comment) => {
      count++;
      accepted = { id: 'demo-accepted-before-timeout', login, amountMinor, comment };
      throw new Error('demo timeout');
    },
    findCredit: async (login, comment) => {
      lookupCount++;
      assert.equal(login, accepted.login);
      assert.equal(comment, accepted.comment);
      return accepted;
    },
  });
  assert.equal((await worker.credit(payment(intent))).status, 'credit_unknown');
  assert.equal((await worker.credit(payment(intent))).status, 'credit_unknown');
  assert.equal(lookupCount, 0);
  assert.equal((await worker.recover(intent.reference)).status, 'credited');
  assert.equal((await worker.credit(payment(intent))).status, 'credited');
  assert.equal(count, 1);
  assert.equal(lookupCount, 1);
});

test('absence, lookup failure or mismatching deal remain unknown with no retry', async () => {
  for (const findCredit of [async () => null, async () => { throw new Error('lookup timeout'); },
    async () => ({ id: 'wrong-deal', login: 'wrong', amountMinor: 150000, comment: 'wrong' })]) {
    let count = 0;
    const { worker, intent } = setup({ creditBalance: async () => {
      count++; throw new Error('timeout');
    }, findCredit });
    await worker.credit(payment(intent));
    assert.equal((await worker.recover(intent.reference)).status, 'credit_unknown');
    await worker.credit(payment(intent));
    assert.equal(count, 1);
  }
});

test('malformed platform result is uncertain and invalid notifications cannot credit', async () => {
  const { worker, intent } = setup({ creditBalance: async () => undefined });
  assert.equal((await worker.credit(payment(intent))).status, 'credit_unknown');
  const fresh = setup();
  for (const change of [{ verified: false }, { status: 'demo_pending' }, { amountMinor: 1.5 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 }, { paidAt: NaN }, { payerName: 123 }]) {
    await assert.rejects(fresh.worker.credit({ ...payment(fresh.intent), ...change }));
  }
  assert.equal(fresh.calls.length, 0);
});
