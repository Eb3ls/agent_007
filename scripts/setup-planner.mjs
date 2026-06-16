#!/usr/bin/env node
// Verifies the ENHSP planner JAR is present (cross-platform: Windows/macOS/Linux).
//
// ENHSP has no prebuilt-JAR download — it is built from source at
//   https://gitlab.com/enricos83/ENHSP-Public  (branch: enhsp-20)
// This repo commits bin/enhsp.jar so you normally never need to build it.
// If the JAR is missing, this prints the exact build steps and exits non-zero.

import { existsSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jarPath = join(__dirname, "..", "bin", "enhsp.jar");
const MB = 1024 * 1024;

if (existsSync(jarPath) && statSync(jarPath).size > MB) {
	const size = (statSync(jarPath).size / MB).toFixed(2);
	console.log(`\x1b[32mENHSP present: ${jarPath} (${size} MB)\x1b[0m`);
	process.exit(0);
}

console.error(`\x1b[31mENHSP jar not found at ${jarPath}\x1b[0m`);
console.error(
	`\x1b[33m
ENHSP is built from source (there is no prebuilt JAR to download). To build it:

  git clone --branch enhsp-20 https://gitlab.com/enricos83/ENHSP-Public.git
  cd ENHSP-Public
  ./compile                 # produces enhsp-dist/enhsp.jar  (requires a JDK)

Then copy the result into this project as bin/enhsp.jar:

  cp enhsp-dist/enhsp.jar "${jarPath}"

On some Linux setups you may also need: export JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF8
\x1b[0m`,
);
process.exit(1);
