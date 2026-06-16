import type { ChatMessage } from "../../mission/llm_client.js";

/**
 * Scripted LLM client for mission e2e tests.
 * Constructor-injectable where LlmClient is expected.
 * Queued responses are returned in order; the queue resets on dequeue.
 */
export class StubLlmClient {
	private readonly queue: string[] = [];

	/** Queue responses to be returned in order by complete()/chat(). */
	queueResponses(...responses: string[]): void {
		this.queue.push(...responses);
	}

	async complete(_messages: ChatMessage[]): Promise<string> {
		const next = this.queue.shift();
		if (next === undefined)
			throw new Error("StubLlmClient: no queued response for complete()");
		return next;
	}

	async chat(_prompt: string): Promise<string> {
		return this.complete([{ role: "user", content: _prompt }]);
	}

	async chatJson<T>(_prompt: string): Promise<T> {
		const raw = await this.chat(_prompt);
		return JSON.parse(raw) as T;
	}
}
