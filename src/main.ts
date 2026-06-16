import { createLlmClient } from "./mission/llm_client.js";
import { L3Executor } from "./mission/l3_executor.js";
import { L1Executor } from "./mission/l1_executor.js";
import { createBeliefStore } from "./belief_store.js";
import { Coordinator } from "./team/coordinator.js";
import { Extractor } from "./mission/extractor.js";
import { Assembler } from "./mission/assembler.js";
import { Listener } from "./mission/listener.js";
import { AgentCore } from "./core/agent_core.js";
import { AgentBus } from "./team/agent_bus.js";
import { GameClient } from "./game_client.js";
import { log } from "./logger.js";
import { env } from "./env.js";

const beliefs = createBeliefStore();
const bus = new AgentBus();
const coordinator = new Coordinator();

const clientBdi = new GameClient("bdi", env.host, env.tokenBdi, beliefs);
clientBdi.connect();

if (env.tokenLlm) {
	const clientLlm = new GameClient("llm", env.host, env.tokenLlm, beliefs);
	clientLlm.connect();

	const [bdi, llm] = await Promise.all([
		clientBdi.waitForConnect(),
		clientLlm.waitForConnect(),
	]);
	if (bdi.teamId !== llm.teamId)
		throw new Error(
			`Team mismatch: bdi.teamId=${bdi.teamId} llm.teamId=${llm.teamId}`,
		);
	log.info(
		"main",
		`dual-agent ok bdi=${bdi.id} llm=${llm.id} team=${bdi.teamId}`,
	);
	clientBdi.addFriendlyAgent(llm.id);
	clientLlm.addFriendlyAgent(bdi.id);

	if (env.serverAgentName) {
		// env.llm is non-null whenever env.tokenLlm is set
		const llmClient = createLlmClient(env.llm!);
		const extractor = new Extractor(llmClient, clientBdi.staticMap);
		const l1Executor = new L1Executor(llmClient, {
			map: clientBdi.staticMap,
			bdiClient: clientBdi,
			senderId: env.serverAgentName,
		});
		const l3Executor = new L3Executor(
			bus,
			coordinator,
			beliefs,
			clientBdi.staticMap,
			clientBdi,
		);
		const listener = new Listener(bus, env.serverAgentName);
		listener.attachClient(clientBdi);
		listener.attachClient(clientLlm);
		const assembler = new Assembler(
			bus,
			clientBdi,
			listener,
			extractor,
			l1Executor,
			l3Executor,
		);

		void (async () => {
			while (true) {
				await assembler.processPending();
				await new Promise((r) => setTimeout(r, 100));
			}
		})();

		log.info(
			"main",
			`mission wiring active allowlist=${env.serverAgentName}`,
		);
	} else {
		log.info("main", "SERVER_AGENT_NAME not set — mission wiring disabled");
	}

	await Promise.all([
		new AgentCore("bdi", clientBdi, beliefs, bus, coordinator).run(),
		new AgentCore("llm", clientLlm, beliefs, bus, coordinator).run(),
	]);
} else {
	log.info("main", "single-agent mode (DELIVEROO_TOKEN_LLM not set)");
	await new AgentCore("bdi", clientBdi, beliefs, bus, coordinator).run();
}
