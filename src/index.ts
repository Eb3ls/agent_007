import { GameClient } from "./game_client.js";
import dotenv from "dotenv";

dotenv.config();

const host = process.env.DELIVEROO_HOST;
const token = process.env.DELIVEROO_TOKEN;

if (!host) {
	console.error("DELIVEROO_HOST environment variable is not set");
	process.exit(1);
}

if (!token) {
	console.error("DELIVEROO_TOKEN environment variable is not set");
	process.exit(1);
}

const gameClient = new GameClient(host, token);
gameClient.connect();
