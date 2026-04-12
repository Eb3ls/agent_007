import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AllyTracker } from "./ally-tracker.js";
import { MessageHandler } from "./message-handler.js";
import {
  makeHello,
  makeParcelClaim,
} from "./message-protocol.js";
import { MockGameClient } from "../testing/mock-game-client.js";
import { BeliefStore } from "../beliefs/belief-store.js";
import { BeliefMapImpl } from "../beliefs/belief-map.js";
import {
  FIXTURE_MAP_TILES,
  FIXTURE_MAP_WIDTH,
  FIXTURE_MAP_HEIGHT,
  FIXTURE_SELF,
} from "../testing/fixtures.js";

const SELF_ID = "agent-self";
const ALLY_ID = "agent-ally";

function makeSetup() {
  const client = new MockGameClient();
  const handler = new MessageHandler(client, SELF_ID);
  const map = new BeliefMapImpl(
    FIXTURE_MAP_TILES,
    FIXTURE_MAP_WIDTH,
    FIXTURE_MAP_HEIGHT,
  );
  const beliefs = new BeliefStore(map);
  beliefs.updateSelf(FIXTURE_SELF);
  const tracker = new AllyTracker(handler, beliefs, SELF_ID, "bdi");
  return { client, tracker, beliefs };
}

describe("AllyTracker — edge cases", () => {
  it("ignores non-hello messages from unknown senders", () => {
    const { client, tracker } = makeSetup();
    tracker.start();

    client.emitMessage(
      "unknown-agent",
      makeParcelClaim("unknown-agent", "p-1", 1),
    );

    assert.equal(tracker.getAllyCount(), 0);
    assert.equal(tracker.getClaimedByOthers().size, 0);
    tracker.stop();
  });

  it("resolves pending outgoing claim to yield on competing incoming claim with higher priority", async () => {
    const { client, tracker, beliefs } = makeSetup();
    tracker.start();

    client.emitMessage(ALLY_ID, makeHello(ALLY_ID, "bdi"));

    beliefs.updateParcels([
      { id: "p-race", x: 9, y: 9, carriedBy: null, reward: 10 },
    ]);

    const pending = tracker.claimParcel("p-race", 20);

    // Ally claims same parcel with shorter distance; this should force immediate yield
    client.emitMessage(ALLY_ID, makeParcelClaim(ALLY_ID, "p-race", 1));

    const result = await pending;
    assert.equal(result, "yield");
    tracker.stop();
  });

  it("keeps claim when ally reply yields (yield=true)", async () => {
    const { client, tracker } = makeSetup();
    tracker.start();
    client.emitMessage(ALLY_ID, makeHello(ALLY_ID, "bdi"));

    const claimPromise = tracker.claimParcel("p-ack", 2);

    // Ally replies via ask: yield=true means ally yields → we win immediately
    client.resolveAsk(ALLY_ID, "p-ack", true);

    const result = await claimPromise;
    assert.equal(result, "claim");
    tracker.stop();
  });
});
