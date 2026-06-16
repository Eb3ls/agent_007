export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type LlmClientConfig = {
	apiUrl: string;
	apiToken: string;
	model: string;
	timeoutMs?: number;
	maxRetries: number;
};

export class LlmClient {
	constructor(private readonly cfg: LlmClientConfig) {}

	async complete(messages: ChatMessage[]): Promise<string> {
		let lastErr: unknown;
		for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
			try {
				const ctrl = new AbortController();
				const tid =
					this.cfg.timeoutMs !== undefined
						? setTimeout(() => ctrl.abort(), this.cfg.timeoutMs)
						: undefined;
				const resp = await fetch(this.cfg.apiUrl, {
					method: "POST",
					signal: ctrl.signal,
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.cfg.apiToken}`,
					},
					body: JSON.stringify({
						model: this.cfg.model,
						messages,
						response_format: { type: "json_object" },
						temperature: 0,
						reasoning: { enabled: false },
					}),
				}).finally(() => {
					if (tid !== undefined) clearTimeout(tid);
				});

				if (!resp.ok) {
					throw new Error(
						`LLM HTTP ${resp.status}: ${await resp.text()}`,
					);
				}
				const data = (await resp.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
				};
				const content = data.choices?.[0]?.message?.content;
				if (!content) throw new Error("LLM returned empty content");
				return content;
			} catch (err) {
				lastErr = err;
				if (attempt < this.cfg.maxRetries) {
					await new Promise((r) =>
						setTimeout(r, 500 * (attempt + 1)),
					);
				}
			}
		}
		throw lastErr;
	}
}

export function createLlmClient(): LlmClient {
	const apiUrl = process.env.LLM_API_URL;
	const apiToken = process.env.LLM_API_TOKEN;
	const model = process.env.LLM_MODEL;
	if (!apiUrl || !apiToken || !model)
		throw new Error(
			"Missing LLM_API_URL, LLM_API_TOKEN, or LLM_MODEL env vars",
		);
	const rawTimeout = process.env.LLM_TIMEOUT_MS;
	return new LlmClient({
		apiUrl,
		apiToken,
		model,
		maxRetries: 2,
		...(rawTimeout !== undefined && { timeoutMs: Number(rawTimeout) }),
	});
}
