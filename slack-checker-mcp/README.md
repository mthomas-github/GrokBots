# Slack Checker MCP for Grok Bot

A Cloudflare Worker that exposes an MCP server. The Grok Bot (and Tesla Grok) can call it to get recent Slack DMs and mentions.

## Features
- Bearer token authentication (`MCP_API_KEY`)
- Fetches recent DMs and @mentions of you
- Can send replies or new messages as the bot, or as **you** if `SLACK_USER_TOKEN` is set (`send_slack_message`)
- Returns a short, TTS-friendly summary
- Runs entirely on Cloudflare Workers

## Setup

### 1. Slack App
1. Go to https://api.slack.com/apps → Create New App → From scratch.
2. Add Bot Token Scopes:
   - `im:history`
   - `im:read`
   - `channels:history`
   - `app_mentions:read`
   - `users:read`
   - `search:read`
   - `chat:write`
3. Add User Token Scopes (so messages can be sent as you):
   - `chat:write`
4. Install the app to your workspace.
   - Copy the **Bot User OAuth Token** (`xoxb-...`)
   - Also copy the **User OAuth Token** (`xoxp-...`) if you want replies to appear as you
5. Find your Slack user ID (click your profile → More → Copy member ID). It looks like `U01234567`.

### 2. Deploy the Worker
```bash
cd slack-checker-mcp
npm install
npx wrangler login
npx wrangler secret put MCP_API_KEY          # generate a long random string, e.g. openssl rand -hex 32
npx wrangler secret put SLACK_BOT_TOKEN      # paste your xoxb- token
npx wrangler secret put SLACK_USER_TOKEN     # optional: paste your xoxp- token to reply as you
npx wrangler secret put SLACK_USER_ID        # paste your U... user ID
npx wrangler deploy
```

Note the deployed URL, e.g. `https://slack-checker-mcp.your-account.workers.dev`.

### 3. Connect to Grok Bot
In Grok Bot → Connect apps → Add a custom connector:
- Name: `slack-checker`
- URL: `https://slack-checker-mcp.your-account.workers.dev/mcp` (or the root if the handler is mounted there)
- Header: `Authorization` = `Bearer <your MCP_API_KEY>`

### 4. Use from Tesla
Ask Grok in the car:
> “Ask my Bot for any new Slack messages for me.”

The Bot will call the `get_recent_slack_messages` tool and read the summary back to you.

## Notes
- The Worker only returns messages from the last N hours (default 24).
- Keep the MCP_API_KEY secret; anyone with it can query your Slack.
- You can adjust scopes or add more tools (e.g. reply) later.
