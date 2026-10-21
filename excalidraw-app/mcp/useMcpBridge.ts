import { useEffect } from "react";

import { isDevEnv } from "@excalidraw/common";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { handleMcpCommand } from "./mcpCommands";

import type { McpCommand } from "./mcpCommands";

/**
 * Dev-only: connects to the local `mcp-server` (see `.mcp.json`) so an MCP
 * client such as Claude Code can read and edit this canvas. The server is
 * started by the MCP client, so it may come and go — keep retrying.
 */

const MIN_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 10000;

type McpRequest = { id: string } & McpCommand;

export const useMcpBridge = (excalidrawAPI: ExcalidrawImperativeAPI | null) => {
  useEffect(() => {
    const url = import.meta.env.VITE_APP_MCP_BRIDGE_URL;
    if (!isDevEnv() || !excalidrawAPI || !url) {
      return;
    }

    let socket: WebSocket | null = null;
    let retryTimeout: number | undefined;
    let retryDelay = MIN_RETRY_DELAY;
    let disposed = false;

    // with several tabs open, the server draws on the one focused last
    const claim = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "claim" }));
      }
    };

    const connect = () => {
      socket = new WebSocket(url);

      socket.onopen = () => {
        retryDelay = MIN_RETRY_DELAY;
        console.info("[mcp-bridge] connected to", url);
        if (document.hasFocus()) {
          claim();
        }
      };

      socket.onmessage = (event) => {
        let request: McpRequest;
        try {
          request = JSON.parse(event.data);
        } catch {
          return;
        }
        let response;
        try {
          response = {
            id: request.id,
            result: handleMcpCommand(excalidrawAPI, request),
          };
        } catch (error: any) {
          response = { id: request.id, error: error?.message ?? String(error) };
        }
        socket?.send(JSON.stringify(response));
      };

      socket.onclose = () => {
        socket = null;
        if (!disposed) {
          retryTimeout = window.setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
        }
      };
    };

    connect();
    window.addEventListener("focus", claim);

    return () => {
      disposed = true;
      window.removeEventListener("focus", claim);
      window.clearTimeout(retryTimeout);
      socket?.close();
    };
  }, [excalidrawAPI]);
};
