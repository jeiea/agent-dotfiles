import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  collectStyleTargetIds,
  renderAnnotatedTree,
} from "./annotated_tree.ts";

Deno.test("renderAnnotatedTree annotates leaf text and changed child attributes", () => {
  const report = renderAnnotatedTree({
    source: "sample figma url",
    tree: {
      rootNodeId: "1:1",
      rootNodeName: "Screen",
      rootNodeType: "FRAME",
      tree: {
        id: "1:1",
        name: "Screen",
        type: "FRAME",
        children: [
          {
            id: "1:2",
            name: "Header",
            type: "FRAME",
            children: [
              { id: "1:3", name: "Title", type: "TEXT", children: [] },
            ],
          },
          {
            id: "1:4",
            name: "Body",
            type: "FRAME",
            children: [
              { id: "1:5", name: "Copy", type: "TEXT", children: [] },
            ],
          },
        ],
      },
    },
    styles: {
      count: 5,
      nodes: [
        {
          nodeId: "1:1",
          nodeName: "Screen",
          nodeType: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
          css: {
            "background-color": "#ffffff",
            width: "375px",
            height: "812px",
            display: "flex",
            "flex-direction": "column",
            padding: "0px 0px 0px 0px",
          },
          layout: {
            mode: "VERTICAL",
            layoutSizingHorizontal: "FIXED",
            layoutSizingVertical: "FIXED",
          },
          style: {},
        },
        {
          nodeId: "1:2",
          nodeName: "Header",
          nodeType: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 56 },
          css: {
            "background-color": "#ffffff",
            width: "375px",
            height: "56px",
            display: "flex",
            "flex-direction": "row",
            gap: "8px",
            padding: "8px 16px 8px 16px",
          },
          layout: {
            mode: "HORIZONTAL",
            layoutSizingHorizontal: "FILL",
            layoutSizingVertical: "FIXED",
          },
          style: {},
        },
        {
          nodeId: "1:4",
          nodeName: "Body",
          nodeType: "FRAME",
          absoluteBoundingBox: { x: 0, y: 56, width: 375, height: 756 },
          css: {
            "background-color": "#fafafa",
            width: "375px",
            height: "756px",
            display: "flex",
            "flex-direction": "column",
            gap: "24px",
            padding: "20px 20px 20px 20px",
          },
          layout: {
            mode: "VERTICAL",
            layoutSizingHorizontal: "FILL",
            layoutSizingVertical: "FILL",
          },
          style: {},
        },
        {
          nodeId: "1:3",
          nodeName: "Title",
          nodeType: "TEXT",
          absoluteBoundingBox: { x: 20, y: 12, width: 140, height: 28 },
          css: {
            width: "140px",
            height: "28px",
            "font-family": "Pretendard",
            "font-weight": "700",
            "font-size": "20px",
            "line-height": "28px",
            "letter-spacing": "0px",
          },
          layout: {
            layoutSizingHorizontal: "HUG",
            layoutSizingVertical: "HUG",
          },
          style: {},
        },
        {
          nodeId: "1:5",
          nodeName: "Copy",
          nodeType: "TEXT",
          absoluteBoundingBox: { x: 20, y: 96, width: 335, height: 48 },
          css: {
            width: "335px",
            height: "48px",
            "font-family": "Pretendard",
            "font-weight": "400",
            "font-size": "16px",
            "line-height": "24px",
            "letter-spacing": "0px",
          },
          layout: {
            layoutSizingHorizontal: "FILL",
            layoutSizingVertical: "HUG",
          },
          style: {},
        },
      ],
    },
    colors: {
      fileKey: "sample",
      nodeId: "1:1",
      depth: 99,
      count: 1,
      nodes: [
        {
          nodeId: "1:3",
          nodeName: "Title",
          nodeType: "TEXT",
          depth: 2,
          fills: ["#222222"],
          strokes: [],
        },
        {
          nodeId: "1:5",
          nodeName: "Copy",
          nodeType: "TEXT",
          depth: 2,
          fills: ["#24262b"],
          strokes: [],
        },
      ],
    },
    text: {
      fileKey: "sample",
      nodeId: "1:1",
      count: 2,
      nodes: [
        {
          id: "1:3",
          name: "Title",
          page: "Scoped node",
          text: "마이크로소프트 Agent",
        },
        {
          id: "1:5",
          name: "Copy",
          page: "Scoped node",
          text: "한 애널리스트가 테슬라가 -60%까지 떨어질 것으로 봤어요",
        },
      ],
    },
  });

  assertStringIncludes(report, "1:3 Title TEXT");
  assertStringIncludes(report, 'text [T1] "마이크로소프트 Agent"');
  assertStringIncludes(report, "1:4 Body FRAME");
  assertStringIncludes(report, "paint bg #fafafa");
  assertStringIncludes(report, "space gap 24px, padding 20px 20px 20px 20px");
  assertStringIncludes(
    report,
    'text [T2] "한 애널리스트가 테슬라가 -60%까지 떨어질 것으로 봤어요"',
  );
  assertStringIncludes(report, "## Text Styles");
  assertStringIncludes(
    report,
    "[T1] Pretendard 700 20px/28px ls 0px fill #222222",
  );
  assertStringIncludes(
    report,
    "[T2] Pretendard 400 16px/24px ls 0px fill #24262b",
  );
});

Deno.test("renderAnnotatedTree omits inherited paint when child matches parent", () => {
  const report = renderAnnotatedTree({
    tree: {
      rootNodeId: "1:1",
      rootNodeName: "Screen",
      rootNodeType: "FRAME",
      tree: {
        id: "1:1",
        name: "Screen",
        type: "FRAME",
        children: [{
          id: "1:2",
          name: "Same Paint",
          type: "FRAME",
          children: [],
        }],
      },
    },
    styles: {
      count: 2,
      nodes: [
        {
          nodeId: "1:1",
          nodeName: "Screen",
          nodeType: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          css: {
            "background-color": "#ffffff",
            width: "100px",
            height: "100px",
          },
          layout: {},
          style: {},
        },
        {
          nodeId: "1:2",
          nodeName: "Same Paint",
          nodeType: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
          css: {
            "background-color": "#ffffff",
            width: "100px",
            height: "50px",
          },
          layout: {},
          style: {},
        },
      ],
    },
  });

  const childBlock = report.slice(report.indexOf("1:2 Same Paint FRAME"));
  assertEquals(childBlock.includes("paint bg #ffffff"), false);
});

Deno.test("renderAnnotatedTree collapses small vector-only svg instances", () => {
  const report = renderAnnotatedTree({
    tree: {
      tree: {
        id: "1:1",
        name: "Screen",
        type: "FRAME",
        children: [{
          id: "1:2",
          name: "exclamationmark_circle",
          type: "INSTANCE",
          children: [
            {
              id: "I1:2;1:3",
              name: "Union",
              type: "BOOLEAN_OPERATION",
              children: [],
            },
            { id: "I1:2;1:4", name: "Circle", type: "ELLIPSE", children: [] },
          ],
        }],
      },
    },
    styles: {
      nodes: [{
        nodeId: "1:2",
        nodeName: "exclamationmark_circle",
        nodeType: "INSTANCE",
        absoluteBoundingBox: { x: 20, y: 20, width: 18, height: 18 },
        css: { width: "18px", height: "18px", padding: "0px 0px 0px 0px" },
        layout: {
          layoutSizingHorizontal: "FIXED",
          layoutSizingVertical: "FIXED",
        },
      }],
    },
    colors: {
      nodes: [
        {
          nodeId: "I1:2;1:3",
          nodeType: "BOOLEAN_OPERATION",
          fills: ["#616161"],
          strokes: [],
        },
        {
          nodeId: "I1:2;1:4",
          nodeType: "ELLIPSE",
          fills: [],
          strokes: ["#616161"],
        },
      ],
    },
  });

  assertStringIncludes(report, "1:2 exclamationmark_circle INSTANCE");
  assertStringIncludes(report, "asset svg/icon");
  assertStringIncludes(report, "paint colors #616161");
  assertEquals(report.includes("component exclamationmark_circle"), false);
  assertEquals(report.includes("I1:2;1:3 Union BOOLEAN_OPERATION"), false);
  assertEquals(report.includes("I1:2;1:4 Circle ELLIPSE"), false);
});

Deno.test("collectStyleTargetIds keeps structural and text nodes in tree order", () => {
  const ids = collectStyleTargetIds({
    id: "1:1",
    name: "Screen",
    type: "FRAME",
    children: [
      { id: "1:2", name: "Vector", type: "VECTOR", children: [] },
      { id: "1:3", name: "Title", type: "TEXT", children: [] },
      { id: "1:4", name: "Group", type: "GROUP", children: [] },
    ],
  });

  assertEquals(ids, ["1:1", "1:3", "1:4"]);
});
