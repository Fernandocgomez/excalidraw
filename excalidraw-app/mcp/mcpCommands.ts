import { arrayToMap } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  computeBoundTextPosition,
  convertToExcalidrawElements,
  getBoundTextElement,
  getContainerElement,
  isTextElement,
  newElementWith,
  refreshTextDimensions,
  syncInvalidIndices,
} from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element";
import type { LocalPoint } from "@excalidraw/math";
import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawTextContainer,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/**
 * Commands the dev-only MCP bridge (see `useMcpBridge`) runs against the
 * canvas on behalf of the `mcp-server` workspace, so an MCP client such as
 * Claude Code can read and edit the open scene.
 *
 * Every write is captured immediately so the user can undo it.
 */

export type McpCommand =
  | { method: "get_scene"; params?: undefined }
  | {
      method: "create_elements";
      params: {
        elements: ExcalidrawElementSkeleton[];
        scrollToContent?: boolean;
      };
    }
  | {
      method: "update_elements";
      params: { updates: McpElementUpdate[] };
    }
  | { method: "delete_elements"; params: { ids: string[] } }
  | { method: "clear_canvas"; params?: undefined };

/** props an MCP client may change on an existing element */
const UPDATABLE_PROPS = [
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "fontSize",
] as const;

export type McpElementUpdate = {
  id: string;
  /** for a text element its text, for a container its label */
  text?: string;
} & Partial<Record<typeof UPDATABLE_PROPS[number], any>>;

const summarizeElement = (element: ExcalidrawElement) => ({
  id: element.id,
  type: element.type,
  x: Math.round(element.x),
  y: Math.round(element.y),
  width: Math.round(element.width),
  height: Math.round(element.height),
  angle: element.angle,
  strokeColor: element.strokeColor,
  backgroundColor: element.backgroundColor,
  ...(isTextElement(element)
    ? {
        text: element.originalText,
        fontSize: element.fontSize,
        containerId: element.containerId,
      }
    : null),
  ...(element.boundElements?.length
    ? { boundElements: element.boundElements }
    : null),
  ...("startBinding" in element && element.startBinding
    ? { startElementId: element.startBinding.elementId }
    : null),
  ...("endBinding" in element && element.endBinding
    ? { endElementId: element.endBinding.elementId }
    : null),
  ...(element.frameId ? { frameId: element.frameId } : null),
});

const getScene = (api: ExcalidrawImperativeAPI) => {
  const { scrollX, scrollY, zoom, width, height } = api.getAppState();
  return {
    viewport: {
      // the scene-coordinate box currently visible on screen
      x: Math.round(-scrollX),
      y: Math.round(-scrollY),
      width: Math.round(width / zoom.value),
      height: Math.round(height / zoom.value),
      zoom: zoom.value,
    },
    elements: api.getSceneElements().map(summarizeElement),
  };
};

const commitElements = (
  api: ExcalidrawImperativeAPI,
  elements: ExcalidrawElement[],
) => {
  api.updateScene({
    elements: syncInvalidIndices(elements),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/**
 * `convertToExcalidrawElements()` falls back to its default size when a
 * linear element's `width`/`height` is 0, so a vertical arrow
 * (`width: 0`) comes out diagonal. Spell the size out as points instead.
 */
const withExplicitPoints = (
  skeleton: ExcalidrawElementSkeleton,
): ExcalidrawElementSkeleton => {
  if (
    (skeleton.type !== "arrow" && skeleton.type !== "line") ||
    skeleton.points ||
    (skeleton.width === undefined && skeleton.height === undefined)
  ) {
    return skeleton;
  }
  return {
    ...skeleton,
    points: [
      pointFrom<LocalPoint>(0, 0),
      pointFrom<LocalPoint>(skeleton.width ?? 100, skeleton.height ?? 0),
    ],
  } as ExcalidrawElementSkeleton;
};

/** ids of scene elements that the skeletons' arrows start or end at */
const getReferencedSceneIds = (
  skeletons: readonly ExcalidrawElementSkeleton[],
  sceneElementsMap: ElementsMap,
  newIds: ReadonlySet<string>,
) => {
  const referencedIds = new Set<string>();
  for (const skeleton of skeletons) {
    if (!("start" in skeleton || "end" in skeleton)) {
      continue;
    }
    for (const endpoint of [skeleton.start, skeleton.end]) {
      if (
        endpoint?.id &&
        !newIds.has(endpoint.id) &&
        sceneElementsMap.has(endpoint.id)
      ) {
        referencedIds.add(endpoint.id);
      }
    }
  }
  return referencedIds;
};

const createElements = (
  api: ExcalidrawImperativeAPI,
  {
    elements: skeletons,
    scrollToContent = true,
  }: Extract<McpCommand, { method: "create_elements" }>["params"],
) => {
  const sceneElementsMap: ElementsMap = arrayToMap(api.getSceneElements());
  const clashingId = skeletons.find(
    (skeleton) => skeleton.id && sceneElementsMap.has(skeleton.id),
  )?.id;
  if (clashingId) {
    throw new Error(`An element with id "${clashingId}" already exists`);
  }

  // the conversion only binds arrows to elements of the same batch, so
  // arrows pointing at elements already on the canvas bind to stand-ins of
  // them, whose new bindings are then copied over to the real ones
  const newIds = new Set(
    skeletons.flatMap((skeleton) => (skeleton.id ? [skeleton.id] : [])),
  );
  const referencedIds = getReferencedSceneIds(
    skeletons,
    sceneElementsMap,
    newIds,
  );
  const standIns = [...referencedIds].map(
    (id) =>
      ({
        ...sceneElementsMap.get(id)!,
        boundElements: null,
      } as ExcalidrawElementSkeleton),
  );

  // keep the ids the client chose so it can bind arrows and refer to the
  // elements in later calls
  const converted = convertToExcalidrawElements(
    [...standIns, ...skeletons.map(withExplicitPoints)],
    { regenerateIds: false },
  );
  const created = converted.filter((element) => !referencedIds.has(element.id));
  const reboundStandIns = arrayToMap(
    converted.filter((element) => referencedIds.has(element.id)),
  );

  // reusing the id of a deleted element (e.g. redrawing after clearing the
  // canvas) replaces it, so ids stay unique
  const createdIds = new Set(created.map((element) => element.id));
  commitElements(api, [
    ...api
      .getSceneElementsIncludingDeleted()
      .filter((element) => !createdIds.has(element.id))
      .map((element) => {
        const standIn = reboundStandIns.get(element.id);
        return standIn?.boundElements
          ? newElementWith(element, {
              boundElements: [
                ...(element.boundElements ?? []),
                ...standIn.boundElements,
              ],
            })
          : element;
      }),
    ...created,
  ]);

  if (scrollToContent && created.length) {
    api.setViewport({ target: created, fit: "scale-down", animation: true });
  }

  return { created: created.map(summarizeElement) };
};

/** rewraps and recenters a text after its text or its container changed */
const refreshText = (
  textElement: ExcalidrawTextElement,
  elementsMap: ElementsMap,
  text = textElement.originalText,
) => {
  const container = getContainerElement<
    ExcalidrawTextElement,
    ExcalidrawTextContainer
  >(textElement, elementsMap);
  const refreshed = newElementWith(textElement, {
    originalText: text,
    ...refreshTextDimensions(textElement, container, elementsMap, text),
  });
  if (!container) {
    return refreshed;
  }
  return newElementWith(
    refreshed,
    computeBoundTextPosition(
      container,
      refreshed as ExcalidrawTextElementWithContainer,
      elementsMap,
    ),
  );
};

const updateElements = (
  api: ExcalidrawImperativeAPI,
  { updates }: Extract<McpCommand, { method: "update_elements" }>["params"],
) => {
  const elementsMap: ElementsMap = arrayToMap(
    api.getSceneElementsIncludingDeleted(),
  );

  for (const { id, text, ...props } of updates) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) {
      throw new Error(`Element "${id}" not found`);
    }

    const changes = Object.fromEntries(
      UPDATABLE_PROPS.filter((prop) => props[prop] !== undefined).map(
        (prop) => [prop, props[prop]],
      ),
    );
    const updated = newElementWith(element, changes);
    elementsMap.set(id, updated);

    const textElement = isTextElement(updated)
      ? updated
      : getBoundTextElement(updated, elementsMap);
    if (text !== undefined && !textElement) {
      throw new Error(`Element "${id}" has no text to update`);
    }
    if (textElement) {
      // also covers a container that moved or resized: its label follows
      elementsMap.set(
        textElement.id,
        refreshText(textElement, elementsMap, text ?? textElement.originalText),
      );
    }
  }

  commitElements(api, [...elementsMap.values()]);

  return {
    updated: updates.map(({ id }) => summarizeElement(elementsMap.get(id)!)),
  };
};

const deleteElements = (
  api: ExcalidrawImperativeAPI,
  { ids }: Extract<McpCommand, { method: "delete_elements" }>["params"],
) => {
  const elementsMap: ElementsMap = arrayToMap(
    api.getSceneElementsIncludingDeleted(),
  );
  const idsToDelete = new Set<string>();

  for (const id of ids) {
    const element = elementsMap.get(id);
    if (!element || element.isDeleted) {
      throw new Error(`Element "${id}" not found`);
    }
    idsToDelete.add(id);
    // a container's label goes with it
    const boundText = getBoundTextElement(element, elementsMap);
    if (boundText) {
      idsToDelete.add(boundText.id);
    }
  }

  const elements = [...elementsMap.values()].map((element) => {
    if (idsToDelete.has(element.id)) {
      return newElementWith(element, { isDeleted: true });
    }
    // a container whose label alone was deleted stops pointing at it
    if (element.boundElements?.some(({ id }) => idsToDelete.has(id))) {
      return newElementWith(element, {
        boundElements: element.boundElements.filter(
          ({ id }) => !idsToDelete.has(id),
        ),
      });
    }
    return element;
  });
  commitElements(api, elements);

  return { deleted: [...idsToDelete] };
};

const clearCanvas = (api: ExcalidrawImperativeAPI) => {
  const elements = api.getSceneElementsIncludingDeleted();
  // unlike `resetScene()`, this stays undoable
  commitElements(
    api,
    elements.map((element) =>
      element.isDeleted
        ? element
        : newElementWith(element, { isDeleted: true }),
    ),
  );
  return { deleted: elements.filter((element) => !element.isDeleted).length };
};

export const handleMcpCommand = (
  api: ExcalidrawImperativeAPI,
  command: McpCommand,
) => {
  switch (command.method) {
    case "get_scene":
      return getScene(api);
    case "create_elements":
      return createElements(api, command.params);
    case "update_elements":
      return updateElements(api, command.params);
    case "delete_elements":
      return deleteElements(api, command.params);
    case "clear_canvas":
      return clearCanvas(api);
    default:
      throw new Error(`Unknown method "${(command as McpCommand).method}"`);
  }
};
