import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";

const names = [
  "ALPACA_API_KEY", "ALPACA_API_SECRET", "MAHORAGA_API_TOKEN", "KILL_SWITCH_SECRET",
  "LLM_PROVIDER", "LLM_MODEL", "MINIMAX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY",
  "CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID", "CLOUDFLARE_AI_GATEWAY_TOKEN",
  "SEC_USER_AGENT", "HALAL_SH_API_KEY",
];

try {
  const env = parseEnv(await readFile(process.argv[2] || ".dev.vars", "utf8"));
  const selected = Object.fromEntries(names.filter((name) => env[name]?.trim()).map((name) => [name, env[name]]));
  for (const name of ["ALPACA_API_KEY", "ALPACA_API_SECRET", "MAHORAGA_API_TOKEN", "KILL_SWITCH_SECRET"]) {
    if (!selected[name] || /^(your_|generate_)/.test(selected[name])) throw new Error(`Configure ${name} in the local secrets file first`);
  }
  const child = spawn("node_modules/.bin/wrangler", ["secret", "bulk"], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(selected));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
