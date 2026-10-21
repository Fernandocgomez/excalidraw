import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

/**
 * Dev-only MCP server for excalidraw-app.
 *
 * The MCP client (e.g. Claude Code, see `.mcp.json`) talks to this process
 * over stdio. The scene lives in the browser, so this process also runs a
 * WebSocket server the app connects to in dev (`useMcpBridge`) and forwards
 * every tool call to it.
 *
 * stdout is the MCP channel: log to stderr only.
 */

const BRIDGE_PORT = Number(process.env.EXCALIDRAW_MCP_BRIDGE_PORT) || 3015;
const APP_URL = process.env.EXCALIDRAW_APP_URL || "http://localhost:3001";
const REQUEST_TIMEOUT = 10_000;

const log = (...args: unknown[]) => console.error("[excalidraw-mcp]", ...args);

// -----------------------------------------------------------------------------
// browser bridge
// -----------------------------------------------------------------------------

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const pendingRequests = new Map<string, PendingRequest>();
// the tab we draw on: the one the user focused last (tabs send `claim` on
// focus), else the first one that connected
let browser: WebSocket | null = null;

const wss = new WebSocketServer({ host: "127.0.0.1", port: BRIDGE_PORT });

wss.on("listening", () =>
  log(`bridge listening on ws://127.0.0.1:${BRIDGE_PORT}`),
);
wss.on("error", (error) => log("bridge error:", error.message));

wss.on("connection", (socket) => {
  log("browser tab connected");
  browser ??= socket;

  socket.on("message", (data) => {
    let response:
      | { type: "claim" }
      | { type?: undefined; id: string; result?: unknown; error?: string };
    try {
      response = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (response.type === "claim") {
      browser = socket;
      return;
    }
    const pending = pendingRequests.get(response.id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.error !== undefined) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  });

  socket.on("close", () => {
    log("browser tab disconnected");
    if (browser === socket) {
      browser =
        [...wss.clients].find((client) => client.readyState === client.OPEN) ??
        null;
    }
  });
});

const callBrowser = (method: string, params?: unknown) => {
  const socket = browser;
  if (!socket || socket.readyState !== socket.OPEN) {
    return Promise.reject(
      new Error(
        `No Excalidraw tab is connected. Run \`yarn start\` in the excalidraw repo and open ${APP_URL}.`,
      ),
    );
  }
  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout: setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Excalidraw did not answer "${method}" in time`));
      }, REQUEST_TIMEOUT),
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
};

// -----------------------------------------------------------------------------
// MCP tools
// -----------------------------------------------------------------------------

const server = new McpServer({ name: "excalidraw", version: "1.0.0" });

const runTool = async (method: string, params?: unknown) => {
  try {
    const result = await callBrowser(method, params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text" as const, text: error.message }],
      isError: true,
    };
  }
};

const COLOR_HINT =
  'CSS color, e.g. "#1e1e1e" (default stroke), "#e03131", "#2f9e44", "#1971c2", "#f08c00"; backgrounds look best light, e.g. "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", or "transparent"';

const styleProps = {
  strokeColor: z.string().optional().describe(COLOR_HINT),
  backgroundColor: z.string().optional().describe(COLOR_HINT),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z.number().optional().describe("1 thin, 2 bold, 4 extra bold"),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z
    .number()
    .optional()
    .describe("0 architect (clean), 1 artist (default), 2 cartoonist"),
  opacity: z.number().min(0).max(100).optional(),
};

const labelSchema = z
  .looseObject({
    text: z.string(),
    fontSize: z.number().optional(),
    strokeColor: z.string().optional(),
  })
  .describe("text centered inside the shape (or on the arrow)");

const endpointSchema = z
  .looseObject({
    id: z
      .string()
      .optional()
      .describe("id of an existing or new element to bind to"),
    type: z
      .enum(["rectangle", "ellipse", "diamond", "text"])
      .optional()
      .describe("or create a new element here instead of binding by id"),
  })
  .describe("element the arrow starts/ends at; the arrow is bound to it");

const skeletonSchema = z.looseObject({
  type: z.enum([
    "rectangle",
    "ellipse",
    "diamond",
    "text",
    "arrow",
    "line",
    "frame",
  ]),
  id: z
    .string()
    .optional()
    .describe("your own id, to bind arrows to it or edit it later"),
  x: z.number().optional().describe("scene x of the top-left corner"),
  y: z.number().optional().describe("scene y of the top-left corner"),
  width: z.number().optional().describe("default 100"),
  height: z
    .number()
    .optional()
    .describe("default 100; 0 for a horizontal arrow"),
  text: z.string().optional().describe('required for type "text"'),
  fontSize: z.number().optional().describe("default 20"),
  label: labelSchema.optional(),
  start: endpointSchema.optional().describe("arrows only"),
  end: endpointSchema.optional().describe("arrows only"),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe("arrows/lines only: points relative to x/y, first is [0, 0]"),
  startArrowhead: z
    .enum(["arrow", "triangle", "dot", "bar"])
    .nullable()
    .optional(),
  endArrowhead: z
    .enum(["arrow", "triangle", "dot", "bar"])
    .nullable()
    .optional()
    .describe('arrows default to "arrow"'),
  children: z
    .array(z.string())
    .optional()
    .describe("frames only (required): ids of the elements inside the frame"),
  name: z.string().optional().describe("frames only: the frame title"),
  ...styleProps,
});

server.registerTool(
  "get_scene",
  {
    title: "Get Excalidraw scene",
    description:
      "Lists the elements on the Excalidraw canvas (ids, types, positions, sizes, colors, text, bindings) and the visible viewport in scene coordinates. Call it before editing, and to place new elements without overlapping existing ones.",
    inputSchema: {},
  },
  () => runTool("get_scene"),
);

server.registerTool(
  "create_elements",
  {
    title: "Create Excalidraw elements",
    description: [
      "Adds elements to the Excalidraw canvas. The user can undo it with Ctrl+Z.",
      "Coordinates are scene pixels, y grows downwards; leave ~40-80px between shapes.",
      "Give elements your own ids so arrows can connect them and you can edit them later.",
      "Examples:",
      '- box with text: {"type":"rectangle","id":"login","x":0,"y":0,"width":180,"height":80,"label":{"text":"Login"}}',
      '- arrow between two shapes (new ones in this call or ones already on the canvas): {"type":"arrow","x":180,"y":40,"start":{"id":"login"},"end":{"id":"home"}}',
      '- labeled arrow: add "label":{"text":"yes"}',
      '- free text: {"type":"text","x":0,"y":-60,"text":"Login flow","fontSize":28}',
      '- frame around elements: {"type":"frame","name":"Auth","children":["login","home"]}',
    ].join("\n"),
    inputSchema: {
      elements: z.array(skeletonSchema).min(1),
      scrollToContent: z
        .boolean()
        .optional()
        .describe("scroll the canvas to show the new elements (default true)"),
    },
  },
  (params) => runTool("create_elements", params),
);

server.registerTool(
  "update_elements",
  {
    title: "Update Excalidraw elements",
    description:
      "Changes existing elements by id: position, size, angle, style, font size and text. For a shape with a label, `text` replaces the label. Labels follow their shape when it moves or resizes. Arrows bound to a moved shape are not re-routed: update or recreate them if needed.",
    inputSchema: {
      updates: z
        .array(
          z.object({
            id: z.string(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            angle: z.number().optional().describe("radians"),
            text: z.string().optional(),
            fontSize: z.number().optional().describe("text elements only"),
            ...styleProps,
          }),
        )
        .min(1),
    },
  },
  (params) => runTool("update_elements", params),
);

server.registerTool(
  "delete_elements",
  {
    title: "Delete Excalidraw elements",
    description:
      "Deletes elements by id (a shape's label is deleted with it). The user can undo it with Ctrl+Z.",
    inputSchema: { ids: z.array(z.string()).min(1) },
  },
  (params) => runTool("delete_elements", params),
);

server.registerTool(
  "clear_canvas",
  {
    title: "Clear Excalidraw canvas",
    description:
      "Deletes every element on the canvas. The user can undo it with Ctrl+Z. Only use it when the user asks to start over.",
    inputSchema: {},
  },
  () => runTool("clear_canvas"),
);

await server.connect(new StdioServerTransport());
log("MCP server ready");
