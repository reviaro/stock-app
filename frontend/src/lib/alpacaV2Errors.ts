// The UI shows only these fixed phrases, keyed by the backend's stable error code -- never the
// response's own text -- so nothing broker-shaped can reach the page even if a message leaks.
const MESSAGES: Record<string, string> = {
  ALPACA_V2_POLICY_INVALID: 'The entry safety policy is unavailable. New entries remain blocked.',
  ALPACA_V2_REWARD_RISK_TOO_LOW: 'The target does not meet the minimum reward-to-risk ratio at the maximum entry price.',
  ALPACA_V2_DAILY_LOSS_LIMIT_REACHED: 'The daily v2 realized-loss limit has been reached. New entries are blocked.',
  ALPACA_V2_DAILY_PNL_UNAVAILABLE: 'Today’s v2 realized risk could not be verified. New entries remain blocked.',
  ALPACA_V2_EXPERIMENT_INVALID: 'Review the experiment settings and try again.',
  ALPACA_V2_HISTORY_STALE: 'This preview is out of date. Load a new preview and review it before applying.',
  ALPACA_V2_HISTORY_REPAIR_BLOCKED: 'History repair is unavailable while the account or monitor needs attention. Nothing was changed.',
  ALPACA_HISTORY_CONFIRMATION_REQUIRED: 'Type APPLY_HISTORY_REPAIR exactly to confirm the reviewed changes.',
  ALPACA_HISTORY_SELECTION_INVALID: 'Select repair candidates from the current preview.',
  ALPACA_HISTORY_ATTRIBUTION_CONFIRMATION_REQUIRED: 'Explicitly confirm ownership attribution for each selected candidate that requires it.',
  ALPACA_HISTORY_STALE_PREVIEW: 'This preview is out of date. Load a new preview and review it before applying.',
  ALPACA_HISTORY_BROKER_STATE_CHANGED: 'Broker activity changed. Load a new preview and review it before applying.',
  ALPACA_HISTORY_BROKER_UNAVAILABLE: 'Broker history could not be read. Nothing was changed.',
  ALPACA_HISTORY_FILL_CONFLICT: 'Conflicting fill evidence needs review. Nothing was changed.',
  ALPACA_HISTORY_BROKER_NOT_FLAT: 'History repair requires no broker positions or working orders.',
  ALPACA_HISTORY_MONITORS_ENABLED: 'History repair requires both execution monitors to be disabled. Load a new preview after they are disabled.',
  ALPACA_HISTORY_ACTIVE_EXECUTION: 'History repair is blocked while execution or an active plan remains.',
  ALPACA_HISTORY_RECENT_PLAN: 'Recent plans cannot be repaired yet. Review them after the historical waiting period.',
  ALPACA_HISTORY_INCOMPLETE_BROKER_HISTORY: 'Broker history is incomplete. Repair is blocked until the evidence is complete.',
  ALPACA_HISTORY_STALE_BROKER_SNAPSHOT: 'The broker snapshot is out of date. Load a new preview before applying.',
  ALPACA_HISTORY_NO_REPAIRS: 'No eligible historical repairs were found.',
  ALPACA_V2_SUBMISSION_IN_PROGRESS: 'Entry submission is in progress; retry after reconciliation.',
  ALPACA_V2_CONTROL_STATE_CHANGED: 'Account state changed during this check; review and retry.',
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
