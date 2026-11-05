# Retired paper day-trading entry API

Alpaca paper investing now lives in **Simulator → Alpaca paper** and uses
long-term allocation reviews. See the [paper investing API and setup](../README.md#long-term-paper-investing).

The former v2 entry and entry-preview endpoints, new day-trading decisions,
execution-mode activation and raw `/api/alpaca-paper/orders` submissions are
retired. Authenticated operator requests receive HTTP 410; old day-trading agent
credentials have no API authority. No broker request is made by these entry paths.

Historical records remain intact. The archive in the paper workspace exposes
legacy history and recovery controls. Disable retained monitor modes and reconcile
unresolved records before using long-term execution. Existing broker orders must
be reviewed at Alpaca; retirement does not cancel brackets or liquidate positions.
Restart the app and monitor on the new version so reconciliation runs without
automatic intraday exits.

Use `/api/alpaca-paper/long-term/preview` for a current allocation preview, followed
by explicit confirmation at `/execute`, or configure a separate scoped
paper-investing agent. Simulator, paper and live records remain separate.
