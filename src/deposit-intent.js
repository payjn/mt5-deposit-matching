import { randomUUID } from 'node:crypto';

// Verify trading account ownership before creation. Fictional IDR account only.
export function createDepositIntent({ clientId, login, amountMinor, expiresAt,
  verifiedClientName, now = Date.now() }) {
  if (typeof clientId !== 'string' || !clientId.trim() ||
      typeof login !== 'string' || !login.trim() ||
      !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || expiresAt <= now ||
      (verifiedClientName !== undefined &&
       (typeof verifiedClientName !== 'string' || !verifiedClientName.trim()))) {
    throw new Error('Invalid deposit intent');
  }
  return Object.freeze({ reference: 'demo-deposit-' + randomUUID(), clientId, login,
    currency: 'IDR', amountMinor, expiresAt, verifiedClientName, status: 'awaiting_payment' });
}
