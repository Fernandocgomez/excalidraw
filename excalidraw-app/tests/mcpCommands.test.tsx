import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { handleMcpCommand } from "../mcp/mcpCommands";

import type { McpCommand } from "../mcp/mcpCommands";

const { h } = window;

describe("MCP bridge commands", () => {
  let api: ExcalidrawImperativeAPI;

  const run = (command: McpCommand) => {
    let result: any;
    act(() => {
      result = handleMcpCommand(api, command);
    });
    return result;
  };

  const getElement = (id: string) =>
    h.elements.find((element) => element.id === id)!;

  const createFlow = () =>
    run({
      method: "create_elements",
      params: {
        scrollToContent: false,
        elements: [
          {
            type: "rectangle",
            id: "a",
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            label: { text: "Login" },
          },
          {
            type: "rectangle",
            id: "b",
            x: 400,
            y: 0,
            width: 200,
            height: 80,
          },
          {
            type: "arrow",
            id: "arrow",
            x: 200,
            y: 40,
            start: { id: "a" },
            end: { id: "b" },
          },
        ],
      },
    });

  beforeEach(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw
        handleKeyboardGlobally
        onExcalidrawAPI={(nextApi) => apiPromise.resolve(nextApi as any)}
      />,
    );
    api = await apiPromise;
  });

  it("creates elements with the given ids and bindings", () => {
    const { created } = createFlow();

    expect(created.map(({ id }: { id: string }) => id)).toEqual(
      expect.arrayContaining(["a", "b", "arrow"]),
    );
    const label = h.elements.find(
      (element) => element.type === "text",
    ) as ExcalidrawTextElement;
    expect(label.containerId).toBe("a");
    expect(label.originalText).toBe("Login");
    expect(getElement("arrow")).toMatchObject({
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
    });
  });

  it("binds arrows to elements created in an earlier call", () => {
    createFlow();
    const labelId = getElement("a").boundElements![0].id;

    run({
      method: "create_elements",
      params: {
        scrollToContent: false,
        elements: [
          { type: "ellipse", id: "c", x: 0, y: 300 },
          {
            type: "arrow",
            id: "down",
            x: 100,
            y: 80,
            points: [
              [0, 0],
              [0, 220],
            ],
            start: { id: "a" },
            end: { id: "c" },
          },
        ] as any,
      },
    });

    expect(getElement("down")).toMatchObject({
      startBinding: { elementId: "a" },
      endBinding: { elementId: "c" },
    });
    // the existing container keeps its label and earlier arrow
    expect(getElement("a").boundElements).toEqual(
      expect.arrayContaining([
        { type: "text", id: labelId },
        { type: "arrow", id: "arrow" },
        { type: "arrow", id: "down" },
      ]),
    );
    expect(getElement("a")).toMatchObject({ x: 0, y: 0, width: 200 });
    expect(h.elements.filter(({ id }) => id === "a")).toHaveLength(1);
  });

  it("keeps zero-width arrows vertical", () => {
    run({
      method: "create_elements",
      params: {
        scrollToContent: false,
        elements: [
          { type: "arrow", id: "vertical", x: 0, y: 0, width: 0, height: 120 },
        ],
      },
    });

    expect(getElement("vertical")).toMatchObject({ width: 0, height: 120 });
  });

  it("is undoable", () => {
    createFlow();
    expect(api.getSceneElements().length).toBeGreaterThan(0);

    Keyboard.undo();

    expect(api.getSceneElements()).toEqual([]);
  });

  it("rejects ids that already exist", () => {
    createFlow();
    expect(() =>
      run({
        method: "create_elements",
        params: { elements: [{ type: "ellipse", id: "a", x: 0, y: 0 }] },
      }),
    ).toThrow('An element with id "a" already exists');
  });

  it("reuses the ids of deleted elements", () => {
    createFlow();
    run({ method: "clear_canvas" });

    createFlow();

    expect(api.getSceneElements().map(({ id }) => id)).toEqual(
      expect.arrayContaining(["a", "b", "arrow"]),
    );
    expect(h.elements.filter(({ id }) => id === "a")).toHaveLength(1);
  });

  it("reads the scene", () => {
    createFlow();
    const scene = run({ method: "get_scene" });

    expect(scene.viewport).toMatchObject({ zoom: 1 });
    expect(scene.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", type: "rectangle", width: 200 }),
        expect.objectContaining({
          id: "arrow",
          startElementId: "a",
          endElementId: "b",
        }),
        expect.objectContaining({
          type: "text",
          text: "Login",
          containerId: "a",
        }),
      ]),
    );
  });

  it("updates style, position and a container's label", () => {
    createFlow();
    const labelId = getElement("a").boundElements![0].id;

    run({
      method: "update_elements",
      params: {
        updates: [
          {
            id: "a",
            x: 100,
            y: 50,
            backgroundColor: "#a5d8ff",
            text: "Sign in",
          },
        ],
      },
    });

    expect(getElement("a")).toMatchObject({
      x: 100,
      y: 50,
      backgroundColor: "#a5d8ff",
    });
    const label = getElement(labelId) as ExcalidrawTextElement;
    expect(label.originalText).toBe("Sign in");
    // the label moved along with its container
    expect(label.x).toBeGreaterThan(100);
    expect(label.y).toBeGreaterThan(50);
  });

  it("rejects text updates on elements without text", () => {
    createFlow();
    expect(() =>
      run({
        method: "update_elements",
        params: { updates: [{ id: "b", text: "nope" }] },
      }),
    ).toThrow('Element "b" has no text to update');
  });

  it("deletes a container along with its label", () => {
    createFlow();
    const labelId = getElement("a").boundElements![0].id;

    const { deleted } = run({
      method: "delete_elements",
      params: { ids: ["a"] },
    });

    expect(deleted).toEqual(expect.arrayContaining(["a", labelId]));
    expect(getElement("a").isDeleted).toBe(true);
    expect(getElement(labelId).isDeleted).toBe(true);
    expect(getElement("b").isDeleted).toBe(false);
  });

  it("clears the canvas undoably", () => {
    createFlow();

    run({ method: "clear_canvas" });
    expect(api.getSceneElements()).toEqual([]);

    Keyboard.undo();
    expect(api.getSceneElements().length).toBeGreaterThan(0);
  });
});
