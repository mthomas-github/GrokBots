import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  MCP_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_USER_TOKEN?: string;  // optional: if set, messages are sent as you
  SLACK_USER_ID: string;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

async function slackFetch(
  token: string,
  method: string,
  params: Record<string, string> = {},
  useBody = false
) {
  const url = new URL(`https://slack.com/api/${method}`);
  const options: RequestInit = {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (useBody) {
    options.method = "POST";
    options.body = JSON.stringify(params);
  } else {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), options);
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
                  messages.push(`DM from <@${msg.user}> (channel ${channel.id}): ${msg.text.slice(0, 200)}`);
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
            const channelId = match.channel?.id || "";
            messages.push(`Mention in #${channel} (channel ${channelId}): ${text}`);
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

  server.registerTool(
    "lookup_slack_user",
    {
      description:
        "Look up a Slack user by name or email. Returns their user ID and, if possible, the DM channel ID you can use to message them.",
      inputSchema: z.object({
        query: z.string().describe("Name, display name, real name, or email to search for"),
      }),
    },
    async ({ query }) => {
      try {
        const users: any = await slackFetch(env.SLACK_BOT_TOKEN, "users.list", {
          limit: "200",
        });

        if (!users.ok || !users.members) {
          return {
            content: [{ type: "text", text: `Failed to list users: ${users.error || "unknown error"}` }],
          };
        }

        const q = query.toLowerCase();
        const matches = users.members.filter((m: any) => {
          if (m.deleted || m.is_bot) return false;
          const name = (m.name || "").toLowerCase();
          const real = (m.real_name || "").toLowerCase();
          const display = (m.profile?.display_name || "").toLowerCase();
          const email = (m.profile?.email || "").toLowerCase();
          return name.includes(q) || real.includes(q) || display.includes(q) || email.includes(q);
        });

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: `No users found matching "${query}".` }],
          };
        }

        const results: string[] = [];
        for (const user of matches.slice(0, 5)) {
          let dmId = "";
          try {
            const im: any = await slackFetch(env.SLACK_BOT_TOKEN, "conversations.open", {
              users: user.id,
            }, true);
            if (im.ok && im.channel?.id) dmId = im.channel.id;
          } catch (_) {}

          results.push(
            `${user.real_name || user.name} (@${user.name}) — User ID: ${user.id}${dmId ? ` — DM ID: ${dmId}` : ""}`
          );
        }

        return {
          content: [{ type: "text", text: `Found ${matches.length} user(s):\n\n${results.join("\n")}` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error looking up user: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "send_slack_message",
    {
      description:
        "Send a reply or new message in Slack. Use the channel ID from get_recent_slack_messages when replying.",
      inputSchema: z.object({
        channel: z.string().describe("Channel or DM ID (e.g. D01234567 or C01234567)"),
        text: z.string().describe("The message text to send"),
        thread_ts: z.string().optional().describe("Optional thread timestamp to reply in a thread"),
      }),
    },
    async ({ channel, text, thread_ts }) => {
      try {
        const params: Record<string, string> = {
          channel,
          text,
        };
        if (thread_ts) params.thread_ts = thread_ts;

        const result: any = await slackFetch(
          env.SLACK_USER_TOKEN || env.SLACK_BOT_TOKEN,
          "chat.postMessage",
          params,
          true
        );

        if (result.ok) {
          return {
            content: [{ type: "text", text: `Message sent successfully to channel ${channel}.` }],
          };
        } else {
          return {
            content: [{ 
              type: "text", 
              text: `Failed to send message: ${result.error || "unknown error"}\n\nFull response:\n${JSON.stringify(result, null, 2)}` 
            }],
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error sending Slack message: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
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
