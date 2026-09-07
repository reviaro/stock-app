// Applies to new simulator writes only. Existing seed/import rows are never
// rewritten or retroactively validated; historical dates remain supported.
function normalizeSimTransaction(txn) {
    const fail = message => { throw Object.assign(new Error(message), { code: 'SIM_INVALID_TRANSACTION' }); };
    if (!txn || !['buy', 'sell', 'deposit', 'withdrawal'].includes(txn.type)) fail('invalid type');
    const account_id = Number(txn.account_id ?? 1);
    if (!Number.isSafeInteger(account_id) || account_id <= 0) fail('invalid account_id');
    const date = txn.txn_date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail('invalid txn_date (YYYY-MM-DD calendar date required)');
    const fees = Number(txn.fees ?? 0);
    if (!Number.isFinite(fees) || fees < 0) fail('fees must be finite and nonnegative');
    const trade = ['buy', 'sell'].includes(txn.type);
    const symbol = txn.symbol == null ? null : String(txn.symbol).trim().toUpperCase();
    if ((trade || symbol !== null) && !/^[A-Z][A-Z0-9]{0,4}(?:[.-][A-Z]{1,2})?$/.test(symbol || '')) fail('invalid US symbol');
    const shares = txn.shares == null ? null : Number(txn.shares);
    const price = txn.price == null ? null : Number(txn.price);
    if ((trade || shares !== null) && (!Number.isFinite(shares) || shares <= 0)) fail('shares must be a positive finite number');
    if ((trade || price !== null) && (!Number.isFinite(price) || price <= 0)) fail('price must be a positive finite number');
    const amount = trade ? shares * price : Number(txn.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(amount + fees)) fail('amount must be a positive finite number');
    return { account_id, symbol, type: txn.type, shares, price, amount, fees, txn_date: date, notes: txn.notes ?? null };
}
module.exports = { normalizeSimTransaction };
