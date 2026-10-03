# Stock Dashboard walkthrough

Caption-led screen recording; no voiceover. All portfolio data is fictional.

**00:00:00–00:00:07** Stock Dashboard is a research workbench I built for my own use.

**00:00:07–00:00:14** This walkthrough uses a fictional portfolio in a separate sample database.

**00:00:14–00:00:23** Portfolio cash, holdings, cost basis and profit or loss are calculated from a transaction ledger.

**00:00:23–00:00:32** Risk rules set limits for each position and sector. This sample allows at most 15% in one position.

**00:00:32–00:00:42** MSFT exceeds that limit. The breach is visible alongside the holdings and transaction history.

**00:00:42–00:00:51** Now I ask the AI analyst to check the same rule. The request explicitly says: no trades.

**00:00:51–00:01:01** This is a live OpenAI API request. The analyst calls the portfolio risk tool to get evidence.

**00:01:01–00:01:17** Its answer compares the actual position weight with the configured limit, using the returned tool data.

**00:01:17–00:01:24** The simulator has separate long-term and day-trading sleeves, each with its own cash and holdings.

**00:01:24–00:01:34** These are fictional simulator trades. They are separate from the broker-backed paper account.

**00:01:34–00:01:45** Broker execution is disabled here. The backend rejects live endpoints and checks the kill switch before new entries.

**00:01:45–00:01:52** Built with AI coding agents. I owned the scope, architecture decisions, testing and operations.

**00:01:52–00:02:00** The public repository links safety claims to implementation and tests. Explore the screenshots and local sample setup.
