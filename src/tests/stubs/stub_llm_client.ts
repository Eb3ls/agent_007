/**
 * Scripted LLM client for mission e2e tests.
 * Constructor-injectable where LlmClient is expected (task 4.1).
 * Queued responses are returned in order; the queue resets on dequeue.
 */
export class StubLlmClient {
	private readonly queue: string[] = [];

	/** Queue responses to be returned in order by chat(). */
	queueResponses(...responses: string[]): void {
		this.queue.push(...responses);
	}

	async chat(_prompt: string): Promise<string> {
		const next = this.queue.shift();
		if (next === undefined)
			throw new Error("StubLlmClient: no queued response for chat()");
		return next;
	}

	async chatJson<T>(_prompt: string): Promise<T> {
		const raw = await this.chat(_prompt);
		return JSON.parse(raw) as T;
	}
}
