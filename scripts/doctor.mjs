import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const configPath = join(root, "opencode.json");
const packageLockPath = join(root, "package-lock.json");
const hasGroqKey = Boolean(process.env.GROQ_API_KEY);

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`OK   ${message}`);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor >= 20) {
  pass(`Node.js ${process.versions.node}`);
} else {
  fail(`Node.js ${process.versions.node}; use Node.js 20 or newer`);
}

if (existsSync(packageLockPath)) {
  pass("dependencies installed");
} else {
  fail("dependencies are not installed; run npm install");
}

if (!existsSync(configPath)) {
  fail("missing opencode.json");
  process.exit();
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
  pass("opencode.json parses");
} catch (error) {
  fail(`opencode.json is invalid JSON: ${error.message}`);
  process.exit();
}

const provider = config.provider?.groq;
if (config.model === "groq/openai/gpt-oss-120b") {
  pass("default model is groq/openai/gpt-oss-120b");
} else {
  fail(`unexpected default model: ${config.model ?? "<missing>"}`);
}

if (provider?.options?.baseURL === "https://api.groq.com/openai/v1") {
  pass("Groq OpenAI-compatible base URL configured");
} else {
  fail("Groq base URL is missing or incorrect");
}

if (provider?.models?.["openai/gpt-oss-120b"]) {
  pass("Groq GPT-OSS 120B model entry configured");
} else {
  fail("missing openai/gpt-oss-120b model entry");
}

if (hasGroqKey) {
  pass("GROQ_API_KEY is set");
} else {
  fail("GROQ_API_KEY is not set in this shell");
}
