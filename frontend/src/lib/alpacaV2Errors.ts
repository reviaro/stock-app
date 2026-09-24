// The UI shows only these fixed phrases, keyed by the backend's stable error code -- never the
// response's own text -- so nothing broker-shaped can reach the page even if a message leaks.
const MESSAGES: Record<string, string> = {
  ALPACA_V2_BROKER_UNAVAILABLE: 'The broker could not be read. Nothing was changed.',
  ALPACA_V2_CONFIRMATION_REQUIRED: 'The typed confirmation did not match.',
  ALPACA_V2_OPERATOR_REQUIRED: 'Sign in as the dashboard operator to use this control.',
  ALPACA_V2_ATTENTION_UNRESOLVED: 'A plan still needs operator resolution before clearing.',
  ALPACA_V2_ACCOUNT_NOT_RECONCILED: 'The broker shows exposure that no v2 plan accounts for.',
  ALPACA_V2_NOT_FLAT: 'The broker still shows a position or working order for this symbol.',
  ALPACA_V2_PLAN_TERMINAL: 'This plan is already closed.',
  ALPACA_V2_MODE_INVALID: 'That mode is not available.',
}

export class AlpacaV2Error extends Error {
  code: string
  constructor(code: string) {
    super(MESSAGES[code] ?? 'The request could not be completed.')
    this.code = code
  }
}

export function v2ErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && MESSAGES[code] ? MESSAGES[code] : 'The request could not be completed.'
}
