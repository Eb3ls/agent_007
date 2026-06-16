import { dirname, join } from "path";
import Handlebars from "handlebars";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));

const SYSTEM_TMPL = Handlebars.compile(
	readFileSync(join(__dir, "prompts/system.hbs"), "utf8"),
	{ noEscape: true },
);
const USER_TMPL = Handlebars.compile(
	readFileSync(join(__dir, "prompts/user.hbs"), "utf8"),
	{ noEscape: true },
);
const L1_SYSTEM_TMPL = Handlebars.compile(
	readFileSync(join(__dir, "prompts/l1_system.hbs"), "utf8"),
	{ noEscape: true },
);
const L1_USER_TMPL = Handlebars.compile(
	readFileSync(join(__dir, "prompts/l1_user.hbs"), "utf8"),
	{ noEscape: true },
);

export function buildSystemPrompt(): string {
	return SYSTEM_TMPL({});
}

export function buildExtractionPrompt(text: string): string {
	return USER_TMPL({ text });
}

export function buildL1SystemPrompt(): string {
	return L1_SYSTEM_TMPL({});
}

export function buildL1UserPrompt(raw: string): string {
	return L1_USER_TMPL({ raw });
}
