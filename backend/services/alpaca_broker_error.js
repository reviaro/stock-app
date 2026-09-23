function sanitizeBrokerMessage(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw;
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return null;

    s = s.replace(/\b(client_order_id|order_id|orderid|account_id|account_number|account|id)\s*[:=]\s*["']?[^\s,;"')]+/gi, '$1=[redacted]');
    s = s.replace(/\baccount\s+["']?[^\s,;"')]+/gi, 'account [redacted]');
    s = s.replace(/\bdt-[a-z]+-\d+(?:-a\d+)?\b/gi, '[client-id]');

    s = s.replace(/https?:\/\/\S+/gi, '[url]');
    s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]');
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]');
    s = s.replace(/\b(api[_-]?key|secret|token|authorization|password)\s*[:=]\s*(?:bearer\s+|basic\s+)?\S+/gi, '$1=[redacted]');
    s = s.replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]');
    s = s.replace(/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{12,}\b/g, '[redacted]');

    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > 200) {
        s = s.slice(0, 200);
    }
    return s || null;
}

module.exports = { sanitizeBrokerMessage };
