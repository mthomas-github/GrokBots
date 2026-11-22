import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  MCP_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_USER_ID: string;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

async function slackFetch(token: string, method: string, params: Record<string, string> = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "slack-checker",
    version: "1.0.0",
  });

  server.registerTool(
    "get_recent_slack_messages",
    {
      description:
        "Fetch recent Slack DMs and mentions of the user. Returns a concise summary suitable for reading aloud in a car.",
      inputSchema: z.object({
        limit: z
          .number()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Max number of messages to return"),
        hours: z
          .number()
          .min(1)
          .max(72)
          .optional()
          .default(24)
          .describe("Look back this many hours"),
      }),
    },
    async ({ limit = 5, hours = 24 }) => {
      const oldest = Math.floor(Date.now() / 1000) - hours * 3600;
      const messages: string[] = [];

      try {
        // 1. Direct messages
        const imList: any = await slackFetch(env.SLACK_BOT_TOKEN, "conversations.list", {
          types: "im",
          limit: "20",
        });

        if (imList.ok && imList.channels) {
          for (const channel of imList.channels.slice(0, 5)) {
            const history: any = await slackFetch(env.SLACK_BOT_TOKEN, "conversations.history", {
              channel: channel.id,
              oldest: String(oldest),
              limit: String(limit),
            });

            if (history.ok && history.messages) {
              for (const msg of history.messages.reverse()) {
                if (msg.user && msg.user !== env.SLACK_USER_ID && msg.text) {
                  messages.push(`DM from <@${msg.user}>: ${msg.text.slice(0, 200)}`);
                }
              }
            }
          }
        }

        // 2. Mentions via search
        const search: any = await slackFetch(env.SLACK_BOT_TOKEN, "search.messages", {
          query: `<@${env.SLACK_USER_ID}>`,
          count: String(limit),
          sort: "timestamp",
          sort_dir: "desc",
        });

        if (search.ok && search.messages?.matches) {
          for (const match of search.messages.matches.slice(0, limit)) {
            const text = match.text?.slice(0, 200) || "";
            const channel = match.channel?.name || "unknown";
            messages.push(`Mention in #${channel}: ${text}`);
          }
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching Slack messages: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "No new Slack DMs or mentions in the last " + hours + " hours." }],
        };
      }

      const summary = messages.slice(0, limit).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Recent Slack messages for you:\n\n${summary}`,
          },
        ],
      };
    }
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Bearer auth
    const auth = request.headers.get("Authorization");
    if (!auth || auth !== `Bearer ${env.MCP_API_KEY}`) {
      return unauthorized();
    }

    const handler = createMcpHandler(() => createServer(env));
    return handler(request, env);
  },
} satisfies ExportedHandler<Env>;
