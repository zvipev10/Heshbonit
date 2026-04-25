# VAT Report

React/Vite frontend for reviewing extracted invoice data, syncing Gmail invoices, editing invoice rows, and saving the final VAT report data through the invoice backend.

## Setup

```powershell
npm install
npm run dev
```

The development server proxies `/api` requests to the configured backend in `vite.config.js`.

## Production Build

```powershell
npm run build
npm run preview
```

## Environment

Production API targets are configured through:

```text
VITE_API_URL
VITE_GMAIL_API_URL
```

See `.env.production` for the current deployed backend URLs.
