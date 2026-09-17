import { assertEquals } from "jsr:@std/assert@^1";
import {
  buildViewQuery,
  parseProjectViewUrl,
  sortViewItems,
} from "./list_project_view_items.ts";

Deno.test("프로젝트 뷰 URL에서 조직·프로젝트·뷰·슬라이스를 읽는다", () => {
  assertEquals(
    parseProjectViewUrl(
      "https://github.com/orgs/example/projects/100/views/4?" +
        "sliceBy%5Bvalue%5D=%EC%9A%94%EC%B2%AD",
    ),
    {
      owner: "example",
      projectNumber: 100,
      viewNumber: 4,
      sliceValue: "요청",
    },
  );
});

Deno.test("뷰 필터와 선택한 슬라이스를 함께 조회한다", () => {
  assertEquals(
    buildViewQuery({
      filter: "assignee:@me",
      sliceField: "Status",
      sliceValue: "요청",
    }),
    'assignee:@me status:"요청"',
  );
});

Deno.test("우선순위대로 정렬하고 같은 우선순위의 뷰 상대 순서를 유지한다", () => {
  const items = [
    { id: "high-1", priority: "High" },
    { id: "urgent-1", priority: "Urgent" },
    { id: "high-2", priority: "High" },
    { id: "none", priority: undefined },
    { id: "medium-1", priority: "Medium" },
    { id: "urgent-2", priority: "Urgent" },
  ];

  assertEquals(
    sortViewItems(items, ["Urgent", "High", "Medium", "Low"], "ASC"),
    [
      { id: "urgent-1", priority: "Urgent" },
      { id: "urgent-2", priority: "Urgent" },
      { id: "high-1", priority: "High" },
      { id: "high-2", priority: "High" },
      { id: "medium-1", priority: "Medium" },
      { id: "none", priority: undefined },
    ],
  );
});
