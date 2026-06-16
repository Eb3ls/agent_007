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
						temperature: 0,
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

export function createLlmClient(
	cfg: Omit<LlmClientConfig, "maxRetries">,
): LlmClient {
	return new LlmClient({ ...cfg, maxRetries: 2 });
}
