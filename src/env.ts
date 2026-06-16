import dotenv from "dotenv";

dotenv.config();

export type LlmEnv = {
	apiUrl: string;
	apiToken: string;
	model: string;
	timeoutMs?: number;
};

export type Env = {
	host: string;
	tokenBdi: string;
	tokenLlm: string | null;
	serverAgentName: string | null;
	llm: LlmEnv | null;
};

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

function parseOptionalPositiveInt(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0)
		throw new Error(`${name} must be a positive integer, got "${raw}"`);
	return n;
}

function parseEnv(): Env {
	const host = required("DELIVEROO_HOST");
	const tokenBdi = required("DELIVEROO_TOKEN");
	const tokenLlm = process.env.DELIVEROO_TOKEN_LLM ?? null;
	const serverAgentName = process.env.SERVER_AGENT_NAME ?? null;

	if (tokenLlm && tokenLlm === tokenBdi)
		throw new Error(
			"DELIVEROO_TOKEN and DELIVEROO_TOKEN_LLM are identical — agents would share the same id",
		);

	const timeoutMs = parseOptionalPositiveInt("LLM_TIMEOUT_MS");
	const llm: LlmEnv | null = tokenLlm
		? {
				apiUrl: required("LLM_API_URL"),
				apiToken: required("LLM_API_TOKEN"),
				model: required("LLM_MODEL"),
				...(timeoutMs !== undefined && { timeoutMs }),
			}
		: null;

	return { host, tokenBdi, tokenLlm, serverAgentName, llm };
}

export const env = parseEnv();
