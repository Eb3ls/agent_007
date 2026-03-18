# Deliveroo.js Autonomous Agent

Multi-agent BDI + LLM system for the Deliveroo.js game.
University of Trento — Autonomous Software Agents (A.A. 2025-2026).

## Prerequisites

- Node.js >= 18
- A running Deliveroo.js game server
- Agent tokens from the game server

## Install

```bash
npm install
```

## Configure

```bash
cp .env.example .env
# Edit .env with your server URL, agent tokens, and LLM API key
```

## Run a single BDI agent

```bash
npm run start:bdi
# or with a custom config:
npx tsx src/main.ts --config configs/agent-bdi.json
```

## Run two agents (BDI + LLM)

```bash
npm run start:team
# or manually:
npx tsx src/main.ts --config configs/agent-bdi.json &
npx tsx src/main.ts --config configs/agent-llm.json &
wait
```

## Build

```bash
npm run build
```
