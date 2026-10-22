# Oakline frontend

React, TypeScript, Vite, and Tailwind provide Oakline's research dashboard,
portfolio, simulator, paper-trading and live-investing views, Research Lab, and
AI chat. Follow the [root setup guide](../README.md#setup) to configure the
backend and its Python environments first.

## Development

Use Node.js 24, or a supported Node.js 20.19+ / 22.12+ release.

```bash
npm ci
npm run dev
```

Vite serves the app at `http://localhost:5173` and proxies `/api` to the backend
at `http://localhost:3002`. Sign in with the backend login you configured.
For a separate backend, set the proxy target when starting Vite:

```bash
VITE_DEV_BACKEND_TARGET=http://127.0.0.1:3003 npm run dev
```

`VITE_DEV_PORT` selects a different frontend port. Both values can also be kept
in an ignored `.env.local` file. Vite variables are browser-visible configuration;
keep broker credentials, model API keys, and session secrets on the backend.

## Structure

- `src/pages/`: application workspaces and page composition.
- `src/components/`: dashboard, chat, simulator, and reusable UI components.
- `src/hooks/`: API requests and React Query state.
- `src/types/`: shared frontend API types.
- `src/lib/`: client utilities and application state.
- `src/test/setup.ts`: shared Vitest setup; tests live beside their components.

## Checks and build

```bash
npm test
npm run lint
npm run build
```

Tests use Vitest, jsdom, and Testing Library with mocked API calls; they do not
need a running backend. The build checks both TypeScript configurations and
emits `dist/`, which the Express backend can serve. `npm run preview` previews
the frontend bundle; use the backend for the complete application.
