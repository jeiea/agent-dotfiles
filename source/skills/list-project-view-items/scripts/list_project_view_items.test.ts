import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import {
  buildViewQuery,
  listProjectViewItems,
  parseProjectViewUrl,
  sortViewItems,
} from "./list_project_view_items.ts";

Deno.test("프로젝트 뷰 URL에서 임시 필터와 식별 가능한 슬라이스를 읽는다", () => {
  assertEquals(
    parseProjectViewUrl(
      "https://github.com/orgs/example/projects/100/views/4?" +
        "filterQuery=assignee%3A%40me&sliceBy%5BcolumnId%5D=123&" +
        "sliceBy%5Bvalue%5D=%EC%9A%94%EC%B2%AD&" +
        "sortedBy%5BcolumnId%5D=Impact&sortedBy%5Bdirection%5D=desc",
    ),
    {
      owner: "example",
      projectNumber: 100,
      viewNumber: 4,
      filter: "assignee:@me",
      sliceFieldId: "123",
      sliceValue: "요청",
      sortFieldId: "Impact",
      sortDirection: "DESC",
    },
  );
});

Deno.test("필드를 알 수 없는 슬라이스 URL은 추정하지 않는다", () => {
  assertThrows(
    () =>
      parseProjectViewUrl(
        "https://github.com/orgs/example/projects/100/views/4?" +
          "sliceBy%5Bvalue%5D=%EC%9A%94%EC%B2%AD",
      ),
    Error,
    "sliceBy[columnId]",
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

Deno.test("단일선택 옵션대로 정렬하고 같은 값의 입력 순서를 유지한다", () => {
  const items = [
    { id: "high-1", sortValue: "High" },
    { id: "urgent-1", sortValue: "Urgent" },
    { id: "high-2", sortValue: "High" },
    { id: "none", sortValue: undefined },
    { id: "medium-1", sortValue: "Medium" },
    { id: "urgent-2", sortValue: "Urgent" },
  ];

  assertEquals(
    sortViewItems(items, {
      options: ["Urgent", "High", "Medium", "Low"],
      direction: "ASC",
    }),
    [
      { id: "urgent-1", sortValue: "Urgent" },
      { id: "urgent-2", sortValue: "Urgent" },
      { id: "high-1", sortValue: "High" },
      { id: "high-2", sortValue: "High" },
      { id: "medium-1", sortValue: "Medium" },
      { id: "none", sortValue: undefined },
    ],
  );
});

Deno.test("내림차순에서도 값이 없는 항목은 마지막에 둔다", () => {
  assertEquals(
    sortViewItems([
      { id: "high", sortValue: "High" },
      { id: "unknown", sortValue: "Removed option" },
      { id: "low", sortValue: "Low" },
      { id: "none", sortValue: undefined },
    ], {
      options: ["High", "Low"],
      direction: "DESC",
    }),
    [
      { id: "low", sortValue: "Low" },
      { id: "high", sortValue: "High" },
      { id: "unknown", sortValue: "Removed option" },
      { id: "none", sortValue: undefined },
    ],
  );
});

Deno.test("뷰의 임시 필터와 조직 단일선택 정렬을 최종 목록에 반영한다", async () => {
  const calls: string[][] = [];
  const responses: unknown[] = [
    {
      data: {
        organization: {
          projectV2: {
            fields: {
              nodes: [
                {
                  databaseId: 123,
                  name: "Labels",
                  dataType: "LABELS",
                },
                {
                  databaseId: 321,
                  name: "Impact",
                  dataType: "SINGLE_SELECT",
                  options: [],
                  issueField: {
                    options: [{ name: "Critical" }, { name: "Minor" }],
                  },
                },
              ],
            },
            view: {
              filter: "is:open",
              sortByFields: {
                nodes: [{
                  direction: "ASC",
                  field: {
                    name: "Priority",
                    options: [{ name: "High" }, { name: "Low" }],
                  },
                }],
              },
            },
          },
        },
      },
    },
    {
      totalCount: 2,
      items: [
        { id: "minor", title: "Minor work" },
        { id: "critical", title: "Critical work" },
      ],
    },
    {
      data: {
        nodes: [
          {
            id: "minor",
            value: { issueFieldValue: { issueName: "Minor" } },
          },
          {
            id: "critical",
            value: { issueFieldValue: { issueName: "Critical" } },
          },
        ],
      },
    },
  ];

  const output = await listProjectViewItems(
    "https://github.com/orgs/example/projects/100/views/4?" +
      "filterQuery=assignee%3A%40me&sortedBy%5BcolumnId%5D=321&" +
      "sortedBy%5Bdirection%5D=asc&sliceBy%5BcolumnId%5D=123&" +
      "sliceBy%5Bvalue%5D=bug",
    {
      runGhJson: (args) => {
        calls.push(args);
        return Promise.resolve(responses.shift());
      },
    },
  );

  assertEquals(
    calls[1]?.slice(-2),
    ["--query", 'assignee:@me label:"bug"'],
  );
  assertEquals(output, [
    {
      position: 1,
      sortField: "Impact",
      sortValue: "Critical",
      number: null,
      title: "Critical work",
      url: null,
    },
    {
      position: 2,
      sortField: "Impact",
      sortValue: "Minor",
      number: null,
      title: "Minor work",
      url: null,
    },
  ]);
});

Deno.test("전체 항목을 받지 못하면 불완전한 순서를 출력하지 않는다", async () => {
  const responses: unknown[] = [
    {
      data: {
        organization: {
          projectV2: {
            fields: { nodes: [] },
            view: {
              filter: "",
              sortByFields: {
                nodes: [{
                  direction: "ASC",
                  field: {
                    name: "Priority",
                    options: [{ name: "High" }],
                  },
                }],
              },
            },
          },
        },
      },
    },
    {
      totalCount: 1001,
      items: [{ id: "first", title: "First" }],
    },
  ];

  await assertRejects(
    () =>
      listProjectViewItems(
        "https://github.com/orgs/example/projects/100/views/4",
        { runGhJson: () => Promise.resolve(responses.shift()) },
      ),
    Error,
    "1001개 중 1개",
  );
});
