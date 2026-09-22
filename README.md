# Agent 007 — Autonomous Deliveroo Agent

Autonomous multi-agent system for the [Deliveroo.js](https://github.com/unitn-asa/deliveroo-js) competitive environment, developed for the **Autonomous Software Agents** course at the University of Trento (2025–26).

Agents operate on a grid map, competing to pick up and deliver parcels under time pressure and partial observability. The system is built around a **BDI (Belief-Desire-Intention)** architecture with LLM-assisted mission interpretation, PDDL-based crate planning, and dual-agent coordination.

---

## Architecture

### BDI Core

Each agent runs a sense–think–act loop grounded in a **belief store** that tracks parcels, other agents, and map state, all subject to time-to-live expiry as information goes stale.

Every tick the agent **deliberates**: it scores every possible next action — pick up a nearby parcel, deliver what it's carrying, batch multiple parcels in one trip, explore an unseen spawn area, or follow a mission waypoint — and selects the highest-scoring option. The current intention is always kept in the candidate pool, so a new action only wins if it's meaningfully better; this prevents the agent from thrashing between near-equal options.

If the chosen intention turns out to be no longer viable (parcel stolen, tile unreachable, too many failed moves), it is dropped and deliberation restarts from scratch the next tick.

Scoring is utility-based: each candidate is evaluated by expected parcel reward minus decay during travel, adjusted for competition risk, carry capacity, and any active mission bonuses or penalties.

### Crate Planning

The agent uses **BFS** for ordinary path-finding. When crates block a route, it can invoke an external **PDDL solver (ENHSP)** to plan moves that push crates out of the way. The planner can also solve a combined collect-then-deliver trip in a single pass. Repeated PDDL attempts for the same target are limited by a cooldown. If neither BFS nor PDDL produces a route, the unreachable intention is dropped so the agent can reconsider its next action. Disabling the solver leaves only BFS routes available.

### Mission System

Natural-language instructions are sent via the Deliveroo chat channel. The agent interprets these in three steps:

1. **Parse** — an LLM (with a cached response layer) converts the free-form text into a structured mission record, classifying it by level and operation type.
2. **Resolve** — if the instruction references a vague location ("the top area of the map"), a second LLM call with full map context resolves it to concrete tile coordinates.
3. **Execute** — the mission record is dispatched to the right executor and takes effect on the agents' next deliberation tick.

Missions are classified into three levels based on complexity:

**L1 — simple moves and answers.** The agent is asked to go to a specific tile for a bonus, or poses a question/calculation. The agent navigates to the waypoint or answers immediately.

**L2 — scoring rules and constraints.** The changes are made on how the agents should behave from now on: multiply delivery rewards at a specific tile, add a penalty for crossing a forbidden zone, nullify deliveries above a value threshold, require a minimum carry count before delivering, or pause and resume movement. These rules are applied as modifiers to the scoring function and remain active until they expire or are cancelled.

**L3 — two-agent choreography.** The requests require coordinated behaviour that needs both agents to act together:
- **Handoff** — one agent collects parcels and drops them at a mutually reachable tile; the other picks them up and delivers. The agents negotiate a drop location, assess whether the expected gain outweighs the coordination cost, and retry up to three times if the pickup fails.
- **Rendezvous** — both agents navigate to within a specified distance of a target location and wait until both have arrived.
- **Stage** — both agents move onto a particular tile class (e.g. an odd-numbered row, the leftmost delivery tile) and hold position until the message is sent to resume.

### Team Coordination

When two agents are running, they share state through an in-process coordinator. Each agent publishes its current position, carry load, and active intention every tick. The coordinator uses this to prevent duplication: if one agent is already heading for a parcel or spawn area, the other steers away. It also tracks cumulative delivery throughput, which feeds back into the scoring model so both agents calibrate their decisions against the team's actual delivery rate.

---

## Setup

**Requirements:** Node.js 20+, npm, Java

```bash
git clone https://github.com/Eb3ls/agent_007.git
cd agent_007
npm ci
cp .env.example .env   # fill in credentials
cp config.example.yaml config.yaml
npm run build
```

### Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `DELIVEROO_HOST` | yes | Game server URL |
| `DELIVEROO_TOKEN` | yes | JWT token — BDI agent |
| `DELIVEROO_TOKEN_LLM` | for dual-agent mode | Second agent's JWT token; must differ from `DELIVEROO_TOKEN` and belong to the same team |
| `SERVER_AGENT_NAME` | for missions | Name of the sender whose chat messages are accepted as missions; other senders are ignored |
| `LLM_API_URL` | when `DELIVEROO_TOKEN_LLM` is set | OpenAI-compatible chat-completions endpoint |
| `LLM_API_TOKEN` | when `DELIVEROO_TOKEN_LLM` is set | LLM API key |
| `LLM_MODEL` | when `DELIVEROO_TOKEN_LLM` is set | Model identifier (e.g. `google/gemma-3-27b-it`) |
| `LLM_TIMEOUT_MS` | no | LLM request timeout in ms; leave blank or unset for no timeout |

For a single BDI agent, set `DELIVEROO_HOST` and `DELIVEROO_TOKEN`; leave `DELIVEROO_TOKEN_LLM` blank. For two agents, also set `DELIVEROO_TOKEN_LLM` and the three LLM API variables. To enable chat missions in dual-agent mode, set `SERVER_AGENT_NAME` to the mission sender's name (matched case-insensitively). It does not change either agent's display name.

### Tunable constants

Copy `config.example.yaml` to `config.yaml`. All runtime constants live there — see inline comments for guidance. Key groups:

| Group | Notable keys |
|---|---|
| `belief` | `parcel_ttl_mult`, `agent_ttl_mult`, `parcel_belief_stale_steps` |
| `intention` | `switch_margin_fraction`, `hysteresis_pct` (L3 dispatch/abort threshold), `steal_prob` (steal-risk weight), `max_move_fail_streak`, `max_age_steps` |
| `explore` | `spawn_observed_ttl_steps`, `ev_promote` (A/B flag for explore-EV formula), `competitor_penalty_alpha`, `memory_decay_horizon_steps` |
| `race` | `horizon_steps` (steal-probability horizon) |
| `crates` | `enabled`, `cooldown_ms` |
| `log` | `level` (`silent` / `info` / `debug`) |

Secrets stay in `.env`.

---

## Usage

```bash
npm start          # run agent (reads DELIVEROO_HOST + DELIVEROO_TOKEN from .env)
npm run build      # TypeScript compilation
npm run dev        # watch and recompile TypeScript; does not start/restart the agent
npm run typecheck  # type check without emit
npm test           # tests; live LLM tests are skipped unless explicitly enabled
npm run check      # type check, formatting check, and tests
```

---

## Authors

- **Leonardo Berselli** — University of Trento
- **Valerii Levchuk** — University of Trento

---

## License

[MIT](LICENSE)
