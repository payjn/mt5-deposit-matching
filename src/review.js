// Conservative fictional name matching is not KYC verification.
export function reviewReason(intent, event) {
  if (!intent) return 'unknown_reference';
  if (event.currency !== intent.currency) return 'currency_mismatch';
  if (event.amountMinor !== intent.amountMinor) return 'amount_mismatch';
  if (event.paidAt >= intent.expiresAt) return 'paid_after_expiry';
  if (event.payerName !== undefined && intent.verifiedClientName !== undefined &&
      event.payerName.trim().toLowerCase() !== intent.verifiedClientName.trim().toLowerCase()) {
    return 'payer_name_mismatch';
  }
  if (intent.status !== 'awaiting_payment') return 'intent_not_awaiting_payment';
  return undefined;
}
