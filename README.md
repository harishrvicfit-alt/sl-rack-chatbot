# SL Rack AI Assistant

Customer-facing AI assistant for SL Rack photovoltaic mounting systems.

## Run locally

1. Install dependencies:

```powershell
npm.cmd install
```

2. Copy `.env.example` to `.env` and add `OPENAI_API_KEY`.

3. Start the app:

```powershell
npm.cmd run dev
```

If port `3000` is busy:

```powershell
$env:PORT="3001"; npm.cmd run dev
```

## What it does

- Recommends SL Rack product families for pitched roofs, flat roofs, ground-mounted PV, facades, carports and Agri-PV.
- Uses a deterministic product selector for reliable product ranking.
- Uses OpenAI when `OPENAI_API_KEY` is configured.
- Works in fallback mode without an API key for demos.

## Product knowledge

Edit `src/slRackKnowledge.js` to add more products, technical rules, qualifying questions or sales advantages.

## SL Rack download knowledge base

Build or refresh the local document index from the public SL Rack downloads page:

```powershell
npm.cmd run ingest:downloads
```

The script downloads public PDF documents into `data/sl-rack-documents`, extracts text into `data/sl-rack-text`, and writes the searchable chatbot index to `data/knowledge-index.json`.

## Deploy

For Vercel, set these environment variables:

```text
OPENAI_API_KEY
OPENAI_MODEL=gpt-5.4-mini
```

The deployment includes `data/knowledge-index.json`; raw PDFs and extracted text files are excluded by `.vercelignore`.

The Vercel project is connected to the GitHub repository, so pushes to `main` can trigger production deployments.
