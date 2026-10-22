# Security Policy

## Supported version

Security fixes are applied to the latest version on the `main` branch.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting for this repository when it is
available. Please do not open a public issue containing credentials, personal
financial data, exploit details, or other sensitive information.

Include the affected component, reproduction steps, impact, and any suggested
mitigation. Remove or redact API keys, session cookies, account identifiers,
database contents, and portfolio data from reports.

If private vulnerability reporting is unavailable, contact the maintainers
through their GitHub profiles to establish a private channel before sharing
technical details.

## Broker and credential boundary

Oakline's Alpaca paper client rejects the live trading endpoint, and paper-order
submission is disabled unless its independent enablement controls are explicitly
configured. The separate live-investing client requires its own credentials,
expected account identity, and explicit submission gate. Live investing starts
paused and unfunded; allocation limits and execution mode require operator review.
Preserve the separation between paper, live, and simulator accounts. Never commit
broker credentials, application secrets, runtime databases, exports, or logs.
