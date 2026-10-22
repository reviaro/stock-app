# Contributing

Contributions to Oakline are welcome through focused pull requests against `main`.

## Before submitting

1. Keep credentials, runtime databases, portfolio exports, logs, and local
   deployment details out of Git.
2. Use neutral examples (`dashboard-user`, `stocks.example.com`, and RFC 5737
   documentation IP addresses) in tests and documentation.
3. Preserve paper, live, and simulator account isolation. Keep live credentials,
   account binding, submission gates, and operator-reviewed limits separate from
   paper trading.
4. Add or update tests for behavior changes.
5. Run the backend and frontend checks documented in `README.md`.
6. Describe security-sensitive changes and any remaining limitations clearly.

Do not include real portfolio holdings, account identifiers, API responses, or
screenshots containing private data in issues or pull requests.
