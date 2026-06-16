# Agent 007 — Autonomous Deliveroo Agent

Autonomous multi-agent system for the [Deliveroo.js](https://github.com/unitn-asa/deliveroo-js) competitive environment, developed for the **Autonomous Software Agents** course at the University of Trento (2025–26).

Agents operate on a grid map, competing to pick up and deliver parcels under time pressure and partial observability. The system is built around a **BDI (Belief-Desire-Intention)** architecture with LLM-assisted mission interpretation, PDDL-based crate planning, and dual-agent coordination.

## Setup

**Requirements:** Node.js 20+, npm

```bash
git clone https://github.com/Eb3ls/agent_007.git
cd agent_007
npm install
cp .env.example .env   # fill in credentials
npm run build
```

### Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `DELIVEROO_HOST` | yes | Game server URL |
| `DELIVEROO_TOKEN` | yes | JWT token — BDI agent |
| `DELIVEROO_TOKEN_LLM` | no | JWT token — LLM agent (enables dual-agent mode) |
| `SERVER_AGENT_NAME` | no | Display name; also enables mission wiring when set |
| `LLM_API_URL` | no | OpenAI-compatible API endpoint |
| `LLM_API_TOKEN` | no | LLM API key |
| `LLM_MODEL` | no | Model identifier (e.g. `google/gemma-3-27b-it`) |
| `LLM_TIMEOUT_MS` | no | LLM request timeout in ms |

### Tunable constants

Copy `config.example.yaml` to `config.yaml`. All runtime constants (TTL multipliers, intention margins, exploration thresholds, log level) live there — see inline comments for guidance. Secrets stay in `.env`.

---

## Usage

```bash
npm start          # run agent (reads DELIVEROO_HOST + DELIVEROO_TOKEN_1 from .env)
npm run build      # TypeScript compilation
npm run dev        # watch mode
npm run typecheck  # type check without emit
```

---

## Authors

- **Leonardo Berselli** — University of Trento
- **Valerii Levchuck** — University of Trento

---

## License

[MIT](LICENSE)
