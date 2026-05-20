# Agent 007 — Autonomous Deliveroo Agent

Autonomous multi-agent system for the [Deliveroo.js](https://github.com/unitn-asa/deliveroo-js) competitive environment, developed for the **Autonomous Software Agents** course at the University of Trento (2025–26).

Agents operate on a grid map, competing to pick up and deliver parcels under time pressure and partial observability. The system is built around a **BDI (Belief-Desire-Intention)** architecture with planned support for LLM-assisted planning, PDDL-based planning, and multi-agent coordination.

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

| Variable | Description |
|---|---|
| `DELIVEROO_HOST` | Game server URL |
| `DELIVEROO_TOKEN_1` | JWT token — first agent |
| `DELIVEROO_TOKEN_2` | JWT token — second agent (multi-agent mode) |
| `LLM_API_URL` | OpenRouter-compatible API endpoint |
| `LLM_API_TOKEN` | LLM API key |
| `LLM_MODEL` | Model identifier (e.g. `google/gemma-3-27b-it`) |
| `LOG_LEVEL` | Log verbosity (`info` / `debug`) |

PDDL solver configuration (optional, see `.env.example`).

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
