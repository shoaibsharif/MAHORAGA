⚠️ **Warning:** This software is provided for educational and informational purposes only. Nothing in this repository constitutes financial, investment, legal, or tax advice.

# MAHORAGA

An autonomous, LLM-powered trading agent that runs 24/7 on Cloudflare Workers.

[![Discord](https://img.shields.io/discord/1467592472158015553?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/vMFnHe2YBh)

MAHORAGA dynamically discovers stock candidates from StockTwits and SEC signals, checks dated Sharia screening evidence, uses AI to research eligible companies, and executes individual-stock trades through Alpaca. It runs as a Cloudflare Durable Object with persistent state and automatic restarts.

<img width="1278" height="957" alt="dashboard" src="https://github.com/user-attachments/assets/56473ab6-e2c6-45fc-9e32-cf85e69f1a2d" />

## Features

- **24/7 Operation** — Runs on Cloudflare Workers, no local machine required
- **Multi-Source Signals** — StockTwits, SEC filings, Twitter confirmation
- **Multi-Provider LLM** — OpenAI, Anthropic, Google, xAI, DeepSeek, MiniMax via AI SDK or Cloudflare AI Gateway
- **Dynamic Halal Screening** — Dated AAOIFI screening evidence with purchase enforcement across autonomous and MCP orders
- **Financial Research** — Public SEC financial facts and filing links supplied to the research model
- **Staleness Detection** — Auto-exit positions that lose momentum
- **Pre-Market Analysis** — Prepare trading plans before market open
- **Discord Notifications** — Get alerts on BUY signals
- **Pluggable Strategy System** — Create custom strategies without touching core files

## Requirements

- Node.js 24.22.2 (pinned in `.nvmrc`; run `nvm use`) and npm 12.2.2 (pinned by `packageManager` in `package.json`; install it with `npm install -g npm@12.2.2`)
- Cloudflare account (free tier works)
- Alpaca account (free, paper trading supported)
- LLM API key (OpenAI, Anthropic, Google, xAI, DeepSeek, MiniMax) or Cloudflare AI Gateway credentials

Both npm lockfiles contain the verified dependency versions. Cloudflare Agents currently requires MCP SDK `1.32.1`; keep that version aligned with its peer dependency. The Miniflare-scoped `undici` override selects patched `7.30.1` because the current Wrangler release still pins an affected version. Recheck the override when updating Wrangler ([advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c)).

npm 12 blocks dependency install scripts unless `allowScripts` in `package.json` approves them. The four packages that have one (esbuild, workerd, fsevents, core-js-pure) are denied: esbuild and workerd load their platform binaries from optional dependencies, and the other two scripts aren't needed. If a new dependency needs its script, review it with `npm install-scripts ls` before approving it.

## Dynamic halal stock portfolio

There is no fixed company list, fund allocation, or SPUS membership requirement. The existing gatherers discover candidates, and the agent screens candidates before spending LLM tokens on research. It scans up to 20 candidate symbols per research cycle to find eligible opportunities, then sizes purchases from the trading sleeve. Holding cash is valid when no candidates qualify.

Screening uses the public [HalalScreener badge API](https://halalscreener.app/en/widget), which currently requires no API key and documents a 60-request/minute limit. Its dated AAOIFI Standard 21 verdict is an external provider assessment, not a religious certification or a claim that all screening authorities agree. The app requires a matching symbol, an individual-stock asset type, and a compliant verdict. Missing dates, provider errors, questionable results, inconsistent published ratios, funds, crypto and derivatives block purchases. A provider assessment expires after eight days; fetched evidence is refreshed at least hourly, and every purchase requires evidence the provider confirmed within the hour. A compliant verdict that is merely due for a re-check is shown as such, not as a failure. Non-compliant and uncovered results are kept for six hours, and transient errors for two minutes, to limit retry traffic. A changed provider response or format fails closed.

Setting `HALAL_SH_API_KEY` switches screening to [halal.sh](https://docs.halal.sh), which also applies AAOIFI Standard 21 and adds a purification rate and a data-confidence score. halal.sh recomputes a verdict when a company files, so its assessments are accepted for up to 150 days and a compliant verdict is relied on for a day before the provider is asked again; a compliant verdict with confidence below 0.7 is treated as questionable and blocks purchases. Results and SEC financial context are stored in D1, with a history row each time a symbol's verdict changes.

The policy engine checks screening evidence immediately before autonomous purchases. MCP order previews include the evidence, and submission rechecks screening and current risk limits, so an old approval token cannot bypass a failed screen. Selling an owned position does not require a passing screen. Legacy options and crypto settings are disabled on hydration and cannot be enabled through agent configuration. Existing holdings are reviewed hourly and status changes are logged; a screening failure does not trigger an automatic liquidation or invent a disposal deadline.

Research includes the screening ratios available from the free response and [SEC company financial facts and filing metadata](https://www.sec.gov/search-filings/edgar-application-programming-interfaces). Set `SEC_USER_AGENT` to identify your application and contact email. Financial figures keep their original periods, concept names and filing dates. Unsupported taxonomies or inaccessible filings remain explicitly unavailable; linked filing contents are not represented as having been reviewed. The free screening feed does not provide a purification rate, so the dashboard displays it as unavailable rather than assuming zero.

The **Halal Screening** dashboard panel shows evidence, dates, rejection reasons, available ratios and source links. The MCP `halal-screen` tool returns the same evidence for any supplied stock symbol. No screening subscription is required. Brokerage and LLM credentials are still required for their respective services.

## Quick Start

Cloudflare builds and deploys this repository from GitHub. Every push to `main` runs the typecheck and tests, builds the dashboard, applies database migrations, and deploys the dashboard and Worker together. `/api/*` is an authenticated same-origin alias for `/agent/*`.

Orders are sized from a sleeve that starts at `starting_equity` (default $100) and compounds with the agent's realized and unrealized P&L. Alpaca's paper cash is left untouched, including the usual $100,000 paper balance. With `position_size_pct_of_cash=10` and `DEFAULT_MAX_POSITION_PCT=0.10`, a $100 sleeve buys about $6–$10 per stock entry. Leave the position dollar cap blank, keep `min_trade_notional=1`, and set `DEFAULT_MAX_NOTIONAL_PER_TRADE=none` when you do not want a fixed dollar ceiling. Stock entries are fractional dollar market orders on assets Alpaca marks tradable and fractionable ([Alpaca fractional trading](https://docs.alpaca.markets/us/docs/fractional-trading)). A losing close is recorded against the sleeve and starts the loss cooldown. Leave options and crypto disabled. Other open positions in the same Alpaca account count against the sleeve, so start from a flat paper book. This does not fund the account or enable live trading. MiniMax API usage is billed separately from the brokerage balance.

### 1. Clone and install

```bash
git clone https://github.com/shoaibsharif/MAHORAGA.git
cd MAHORAGA
npm install
npm ci --prefix dashboard && npm run build --prefix dashboard
```

### 2. Create the database

Before the first build, create a D1 database named `mahoraga-db` (Storage & Databases → D1 in the Cloudflare dashboard, or `npx wrangler d1 create mahoraga-db`). Each deploy applies migrations before the new Worker goes live, so the database has to exist first. The KV namespace and R2 bucket are created on the first deploy; R2 must be enabled on the account.

### 3. Connect the repository

In the Cloudflare dashboard, open Workers & Pages → Create → Import a repository, pick this repository, and set:

| Setting | Value |
|---|---|
| Worker name | `mahoraga` (must match `name` in `wrangler.jsonc`) |
| Production branch | `main` |
| Build command | `npm run build:cloudflare` |
| Deploy command | `npm run deploy` |
| Enable Preview Builds (Settings → Build → Branch control) | Off |

The build command runs the typecheck and tests, then builds the dashboard, so a type error or failing test stops the deploy before the database is touched. The deploy command applies D1 migrations, then runs `wrangler deploy`. The API token Cloudflare creates for builds doesn't include D1, so edit it to add **D1 Edit**; otherwise migrations fail. Cloudflare's build reads the Node version from `.nvmrc` and the npm version from `packageManager`, so it installs with the same versions as your machine.

Keep preview builds off. A preview doesn't inherit the production bindings, and `wrangler.jsonc` has no `previews` block, so a preview would start without its database, cache or bucket and fail.

`npm run deploy` also works from your machine after `npx wrangler login` and a dashboard build.

### 4. Set secrets

After the first deploy, add the Worker's secrets under Settings → Variables and Secrets, or upload them from your local `.dev.vars`:

```bash
npx wrangler login
node scripts/upload-cloudflare-secrets.mjs .dev.vars
```

The script uploads an allowlist: the Alpaca keys, `MAHORAGA_API_TOKEN`, `KILL_SWITCH_SECRET`, the LLM provider, model and API keys, and `SEC_USER_AGENT`. It skips Discord settings and can't override paper mode, which is set by `ALPACA_PAPER` in `wrangler.jsonc`. A fresh agent uses the deployed LLM selection and starts disabled with a $100 sleeve. Later deploys keep its stored configuration and enabled state.

To set secrets one at a time instead:

```bash
# Required
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET
npx wrangler secret put MAHORAGA_API_TOKEN   # e.g. openssl rand -base64 48
npx wrangler secret put KILL_SWITCH_SECRET   # Emergency kill switch (separate from API token)

# LLM provider: "openai-raw" (default), "ai-sdk", or "cloudflare-gateway"
npx wrangler secret put LLM_PROVIDER
npx wrangler secret put LLM_MODEL            # e.g. "gpt-4o-mini" or "minimax/MiniMax-M3.1-Flash"

# LLM API key for the chosen provider
npx wrangler secret put OPENAI_API_KEY       # openai-raw, or ai-sdk with OpenAI
# npx wrangler secret put OPENAI_BASE_URL    # Optional OpenAI-compatible base URL
# npx wrangler secret put MINIMAX_API_KEY
# npx wrangler secret put ANTHROPIC_API_KEY
# npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
# npx wrangler secret put XAI_API_KEY
# npx wrangler secret put DEEPSEEK_API_KEY
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ID
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_TOKEN

# Optional
npx wrangler secret put SEC_USER_AGENT       # "AppName you@example.com" for SEC requests
npx wrangler secret put HALAL_SH_API_KEY     # screen with halal.sh instead of the free HalalScreener badge
npx wrangler secret put TWITTER_BEARER_TOKEN
npx wrangler secret put DISCORD_WEBHOOK_URL
```

### 5. Enable the agent

The dashboard is served from the Worker's URL. All API endpoints require the Bearer token:

```bash
export MAHORAGA_URL="https://mahoraga.<your-subdomain>.workers.dev"
export MAHORAGA_TOKEN="your-api-token"

curl -H "Authorization: Bearer $MAHORAGA_TOKEN" "$MAHORAGA_URL/agent/enable"
```

### 6. Monitor

```bash
# Check status
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" "$MAHORAGA_URL/agent/status"

# View logs
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" "$MAHORAGA_URL/agent/logs"

# Emergency kill switch (uses separate KILL_SWITCH_SECRET)
curl -H "Authorization: Bearer $KILL_SWITCH_SECRET" "$MAHORAGA_URL/agent/kill"
```

The dashboard at your Worker's URL can be installed as an app: use **Install** in Chrome or Edge, or **Share → Add to Home Screen** in Safari on iPhone. A service worker caches the app's own files so it opens without a connection, but it never caches trading data; when the agent can't be reached, the dashboard says so instead of showing old figures as current.

## Local Development

`wrangler dev` uses the same `wrangler.jsonc` with local D1, KV and R2, and reads secrets from `.dev.vars`. It serves `dashboard/dist`, so build the dashboard once first (step 1), then apply migrations to the local database:

```bash
npm run db:migrate

# Terminal 1 - Start wrangler
npx wrangler dev

# Terminal 2 - Start dashboard
cd dashboard && npm run dev

# Terminal 3 - Enable the agent
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" \
  http://localhost:8787/agent/enable
```

## Custom Strategies

Mahoraga uses a **pluggable strategy system**. The core harness is a thin orchestrator — all customizable logic lives in strategy modules. You never need to modify core files.

### How it works

1. Create `src/strategy/my-strategy/index.ts` implementing the `Strategy` interface
2. Change one import line in `src/strategy/index.ts`

```typescript
// src/strategy/index.ts
import { myStrategy } from "./my-strategy";
export const activeStrategy = myStrategy;
```

### What you can customize

| Component | File | What it does |
|-----------|------|--------------|
| **Gatherers** | `gatherers/*.ts` | Fetch signals from data sources (StockTwits, SEC, etc.) |
| **Prompts** | `prompts/*.ts` | LLM prompt templates for research and analysis |
| **Entry rules** | `rules/entries.ts` | Decide which signals to buy |
| **Exit rules** | `rules/exits.ts` | Decide when to sell positions |
| **Config** | `config.ts` | Default parameters and source weights |

You can reuse default gatherers, mix in custom ones, override prompts, and define your own entry/exit rules — all without touching core files.

### Adding a new data source

Create a gatherer that returns `Signal[]`:

```typescript
import type { Gatherer, StrategyContext } from "../../types";

const myGatherer: Gatherer = {
  name: "my-source",
  gather: async (ctx: StrategyContext) => {
    const res = await fetch("https://your-api.com/data");
    const data = await res.json();
    return data.items.map(item => ({
      symbol: item.ticker,
      source: "my_source",
      source_detail: "my_source_v1",
      sentiment: item.sentiment,
      raw_sentiment: item.sentiment,
      volume: 1,
      freshness: 1.0,
      source_weight: 0.9,
      reason: `MySource: ${item.summary}`,
      timestamp: Date.now(),
    }));
  },
};
```

Then include it in your strategy's `gatherers` array.

See `docs/harness.html` for the full customization guide.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `max_positions` | 5 | Maximum concurrent positions |
| `max_position_value` | null | Optional dollar cap; percentage and cash limits still apply |
| `min_trade_notional` | 1 | Minimum dollar value of a stock entry |
| `starting_equity` | 100 | Sleeve bankroll. Agent P&L compounds on top of this |
| `position_size_pct_of_cash` | 10 | Cash percentage used to size entries before confidence adjustment |
| `take_profit_pct` | 10 | Take profit percentage |
| `stop_loss_pct` | 5 | Loss at which the analyst model reviews the position with the news and decides to sell or hold |
| `hard_stop_loss_pct` | 15 | Loss at which the position is always sold, without a review |
| `open_sell_delay_minutes` | 30 | Minutes after the opening bell during which nothing is sold, unless the hard stop is hit |
| `min_sentiment_score` | 0.3 | Minimum sentiment to consider |
| `min_analyst_confidence` | 0.6 | Minimum LLM confidence to trade |
| `options_enabled` | false | Enable options trading |
| `crypto_enabled` | false | Enable 24/7 crypto trading |
| `llm_model` | gpt-4o-mini | Research model (cheap, for bulk analysis) |
| `llm_analyst_model` | gpt-4o | Analyst model (smart, for trading decisions) |

### LLM Provider Configuration

MAHORAGA supports multiple LLM providers via three modes:

| Mode | Description | Required Env Vars |
|------|-------------|-------------------|
| `openai-raw` | Direct OpenAI API (default) | `OPENAI_API_KEY` |
| `ai-sdk` | Vercel AI SDK with 6 providers, including MiniMax | One or more provider keys |
| `cloudflare-gateway` | Cloudflare AI Gateway (/compat) | `CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN` |

**MiniMax setup:**

- Add `MINIMAX_API_KEY` to `.dev.vars` locally, or use `npx wrangler secret put MINIMAX_API_KEY` for deployment.
- Set `LLM_PROVIDER=ai-sdk` and `LLM_MODEL=minimax/MiniMax-M3.1-Flash`, then restart the Worker. In dashboard settings, choose **AI SDK** and set both research and analyst models to **MiniMax-M3.1-Flash**. `MiniMax-M3` is also available.
- MiniMax uses the MiniMax-maintained `@minimax-ai/ai-sdk-provider` package through AI SDK's `generateText`, with its default Anthropic-compatible transport (`https://api.minimax.io/anthropic/v1/messages`).
- The integration separates reasoning from the final answer, allows at least 8,192 output tokens (including reasoning), and rejects truncated, empty, or invalid JSON responses. Requests use a 60-second timeout, medium reasoning effort, and no automatic retries.
- Dashboard cost estimates use standard, uncached MiniMax API prices. Actual billing can differ with prompt caching or subscription access.

See the [MiniMax AI SDK guide](https://platform.minimax.io/docs/api-reference/text-ai-sdk) and [pricing](https://platform.minimax.io/docs/pricing/overview).

**Optional OpenAI Base URL Override:**

- `OPENAI_BASE_URL` — Override the base URL used for OpenAI requests. Applies to `LLM_PROVIDER=openai-raw` and OpenAI models in `LLM_PROVIDER=ai-sdk` (models starting with `openai/`). Default: `https://api.openai.com/v1`.

**Cloudflare AI Gateway Notes:**

- This integration calls Cloudflare's OpenAI-compatible `/compat/chat/completions` endpoint and always sends `cf-aig-authorization`.
- It is intended for BYOK/Unified Billing setups where upstream provider keys are configured in Cloudflare (so your worker does not send provider API keys).
- Models use the `{provider}/{model}` format (e.g. `openai/gpt-5-mini`, `google-ai-studio/gemini-2.5-flash`, `anthropic/claude-sonnet-4-5`).

**AI SDK Supported Providers:**

| Provider | Env Var | Example Models |
|----------|---------|----------------|
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o`, `openai/o1` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4`, `anthropic/claude-opus-4` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | `google/gemini-2.5-pro`, `google/gemini-2.5-flash` |
| xAI (Grok) | `XAI_API_KEY` | `xai/grok-4`, `xai/grok-3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner` |
| MiniMax | `MINIMAX_API_KEY` | `minimax/MiniMax-M3.1-Flash`, `minimax/MiniMax-M3` |

**Example: Using Claude with AI SDK:**

```bash
npx wrangler secret put LLM_PROVIDER      # Set to "ai-sdk"
npx wrangler secret put LLM_MODEL         # Set to "anthropic/claude-sonnet-4"
npx wrangler secret put ANTHROPIC_API_KEY # Your Anthropic API key
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/agent/status` | Full status (account, positions, signals) |
| `/agent/enable` | Enable the agent |
| `/agent/disable` | Disable the agent |
| `/agent/config` | Get or update configuration |
| `/agent/logs` | Get recent logs |
| `/agent/trigger` | Manually trigger (for testing) |
| `/agent/test-alert` | POST: send a test message to the Discord webhook |
| `/agent/kill` | Emergency kill switch (uses `KILL_SWITCH_SECRET`) |
| `/mcp` | MCP server for tool access |

## Security

### API Authentication (Required)

All `/agent/*` endpoints require Bearer token authentication using `MAHORAGA_API_TOKEN`:

```bash
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" "$MAHORAGA_URL/agent/status"
```

Generate a secure token: `openssl rand -base64 48`

### Emergency Kill Switch

The `/agent/kill` endpoint uses a separate `KILL_SWITCH_SECRET` for emergency shutdown:

```bash
curl -H "Authorization: Bearer $KILL_SWITCH_SECRET" "$MAHORAGA_URL/agent/kill"
```

This immediately disables the agent, cancels all alarms, and clears the signal cache.

### Cloudflare Access (Recommended)

For additional security with SSO/email verification, set up Cloudflare Access:

```bash
# 1. Create a Cloudflare API token with Access:Edit permissions
#    https://dash.cloudflare.com/profile/api-tokens

# 2. Run the setup script
CLOUDFLARE_API_TOKEN=your-token \
CLOUDFLARE_ACCOUNT_ID=your-account-id \
MAHORAGA_WORKER_URL=https://mahoraga.your-subdomain.workers.dev \
MAHORAGA_ALLOWED_EMAILS=you@example.com \
npm run setup:access
```

This creates a Cloudflare Access Application with email verification or One-Time PIN.

## Project Structure

```
mahoraga/
├── wrangler.jsonc              # Cloudflare Workers config
├── src/
│   ├── index.ts                # Entry point & routing
│   ├── core/
│   │   ├── types.ts            # Shared types (Signal, AgentState, etc.)
│   │   └── policy-broker.ts    # PolicyEngine-wrapped trade execution
│   ├── durable-objects/
│   │   └── mahoraga-harness.ts # Core orchestrator (thin — delegates to strategy)
│   ├── strategy/
│   │   ├── types.ts            # Strategy interface contract
│   │   ├── index.ts            # Active strategy selector (change this one line)
│   │   └── default/            # Default "sentiment-momentum" strategy
│   │       ├── index.ts        # Strategy assembly
│   │       ├── config.ts       # Default config & source weights
│   │       ├── gatherers/      # StockTwits, SEC, crypto, Twitter
│   │       ├── prompts/        # LLM prompt templates
│   │       ├── rules/          # Entry/exit/staleness/options/crypto rules
│   │       └── helpers/        # Ticker extraction, sentiment analysis
│   ├── mcp/                    # MCP server & tools
│   ├── policy/                 # Trade validation & risk engine
│   ├── providers/              # Alpaca, LLM providers
│   └── schemas/                # Config schemas (Zod)
├── dashboard/                  # React dashboard
├── docs/                       # Documentation
└── migrations/                 # D1 database migrations
```

## Safety Features

| Feature | Description |
|---------|-------------|
| Paper Trading | Start with `ALPACA_PAPER=true` |
| Kill Switch | Emergency halt via secret |
| Position Limits | Max positions and $ per position |
| Daily Loss Limit | Stops trading after 2% daily loss |
| Staleness Detection | Auto-exit stale positions |
| Settled Sales Only | Shares bought today are not sold until the next trading day, stop loss included |
| Reviewed Stop Loss | A position past the stop loss is sold only after the analyst model has read the news; a hard stop always sells |
| Opening Wait | No sales in the first 30 minutes of the session, when prices swing most |
| No Margin | Cash-only trading |
| No Shorting | Long positions only |

## Community

Join our Discord for help and discussion:

**[Discord Server](https://discord.gg/vMFnHe2YBh)**

## Disclaimer

**⚠️ IMPORTANT: READ BEFORE USING**

This software is provided for **educational and informational purposes only**. Nothing in this repository constitutes financial, investment, legal, or tax advice.

**By using this software, you acknowledge and agree that:**

- All trading and investment decisions are made **at your own risk**
- Markets are volatile and **you can lose some or all of your capital**
- No guarantees of performance, profits, or outcomes are made
- The authors and contributors are **not responsible** for any financial losses
- This software may contain bugs or behave unexpectedly
- Past performance does not guarantee future results

**Always start with paper trading and never risk money you cannot afford to lose.**

## License

MIT License - Free for personal and commercial use. See [LICENSE](LICENSE) for full terms.
