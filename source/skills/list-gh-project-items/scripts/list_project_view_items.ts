import { parseArgs } from "jsr:@std/cli@^1";

interface ProjectViewLocation {
  owner: string;
  projectNumber: number;
  viewNumber: number;
  filter?: string;
  sliceFieldId?: string;
  sliceValue?: string;
  sortFieldId?: string;
  sortDirection?: SortDirection;
}

interface ViewQueryInput {
  filter: string;
  sliceField?: string;
  sliceValue?: string;
}

type SortDirection = "ASC" | "DESC";
type RunGhJson = (args: string[]) => Promise<unknown>;

interface SortableItem {
  sortValue?: string;
}

interface ProjectItem extends SortableItem {
  id: string;
  title: string;
  content?: {
    number?: number;
    url?: string;
  };
}

interface ProjectField {
  databaseId?: number;
  name: string;
  dataType?: string;
  options?: Array<{ name: string }>;
  issueField?: {
    options: Array<{ name: string }>;
  };
}

interface ViewConfigurationResponse {
  data: {
    organization: {
      projectV2?: {
        fields: {
          nodes: Array<ProjectField | null>;
        };
        view?: {
          filter?: string;
          groupByFields: {
            nodes: Array<{
              databaseId?: number;
              name: string;
            }>;
          };
          sortByFields: {
            nodes: Array<{
              direction: SortDirection;
              field?: {
                name: string;
                options: Array<{ name: string }>;
                issueField?: {
                  options: Array<{ name: string }>;
                };
              };
            }>;
          };
        };
      };
    };
  };
}

interface ProjectItemListResponse {
  totalCount: number;
  items: ProjectItem[];
}

interface ItemFieldValuesResponse {
  data: {
    nodes: Array<
      {
        id: string;
        value?: {
          projectName?: string;
          issueFieldValue?: { issueName?: string };
        };
      } | null
    >;
  };
}

export interface ListedProjectItem {
  position: number;
  sortField: string;
  sortValue: string | null;
  number: number | null;
  title: string;
  url: string | null;
}

const VIEW_CONFIGURATION_QUERY = `
query($owner: String!, $projectNumber: Int!, $viewNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      fields(first: 100) {
        nodes {
          ... on ProjectV2FieldCommon {
            databaseId
            dataType
            name
          }
          ... on ProjectV2SingleSelectField {
            options { name }
            issueField {
              ... on IssueFieldSingleSelect {
                options { name }
              }
            }
          }
        }
      }
      view(number: $viewNumber) {
        filter
        groupByFields(first: 10) {
          nodes {
            ... on ProjectV2Field { databaseId name }
            ... on ProjectV2IterationField { databaseId name }
            ... on ProjectV2MultiSelectField { databaseId name }
            ... on ProjectV2SingleSelectField { databaseId name }
          }
        }
        sortByFields(first: 10) {
          nodes {
            direction
            field {
              ... on ProjectV2SingleSelectField {
                name
                options { name }
                issueField {
                  ... on IssueFieldSingleSelect {
                    options { name }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const ITEM_FIELD_VALUES_QUERY = `
query($ids: [ID!]!, $fieldName: String!) {
  nodes(ids: $ids) {
    ... on ProjectV2Item {
      id
      value: fieldValueByName(name: $fieldName) {
        ... on ProjectV2ItemFieldSingleSelectValue {
          projectName: name
        }
        ... on ProjectV2ItemIssueFieldValue {
          issueFieldValue {
            ... on IssueFieldSingleSelectValue {
              issueName: name
            }
          }
        }
      }
    }
  }
}`;

export function parseProjectViewUrl(value: string): ProjectViewLocation {
  const url = new URL(value);
  const match = url.pathname.match(
    /^\/orgs\/([^/]+)\/projects\/(\d+)\/views\/(\d+)$/,
  );
  if (url.hostname !== "github.com" || !match) {
    throw new Error("깃헙 조직 프로젝트 뷰 URL이 필요합니다.");
  }

  const sliceFieldId = url.searchParams.get("sliceBy[columnId]") ?? undefined;
  const sliceValue = url.searchParams.get("sliceBy[value]") ?? undefined;

  const sortFieldIds = url.searchParams.getAll("sortedBy[columnId]");
  const sortDirections = url.searchParams.getAll("sortedBy[direction]");
  if (sortFieldIds.length > 1 || sortDirections.length > 1) {
    throw new Error("URL의 다중 정렬은 지원하지 않습니다.");
  }
  if (sortFieldIds.length !== sortDirections.length) {
    throw new Error("URL 임시 정렬에는 필드와 방향이 모두 필요합니다.");
  }
  const sortDirection = sortDirections[0]?.toUpperCase();
  if (sortDirection && sortDirection !== "ASC" && sortDirection !== "DESC") {
    throw new Error(`지원하지 않는 정렬 방향입니다: ${sortDirections[0]}`);
  }

  const filterParameter = url.searchParams.has("filterQuery")
    ? "filterQuery"
    : url.searchParams.has("query")
    ? "query"
    : undefined;

  return {
    owner: decodeURIComponent(match[1]!),
    projectNumber: Number(match[2]),
    viewNumber: Number(match[3]),
    filter: filterParameter
      ? url.searchParams.get(filterParameter) ?? ""
      : undefined,
    sliceFieldId,
    sliceValue,
    sortFieldId: sortFieldIds[0],
    sortDirection: sortDirection as SortDirection | undefined,
  };
}

export function buildViewQuery(input: ViewQueryInput): string {
  const slice = input.sliceField && input.sliceValue
    ? `${input.sliceField.toLowerCase().replaceAll(" ", "-")}:"${
      input.sliceValue.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    }"`
    : "";
  return [input.filter.trim(), slice].filter(Boolean).join(" ");
}

export function sortViewItems<T extends SortableItem>(
  items: readonly T[],
  options: {
    options: readonly string[];
    direction: SortDirection;
  },
): T[] {
  const optionOrder = new Map(
    options.options.map((option, index) => [option, index]),
  );

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftOrder = left.item.sortValue === undefined
        ? undefined
        : optionOrder.get(left.item.sortValue);
      const rightOrder = right.item.sortValue === undefined
        ? undefined
        : optionOrder.get(right.item.sortValue);
      if (leftOrder === undefined && rightOrder === undefined) {
        return left.index - right.index;
      }
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;

      const ranked = leftOrder - rightOrder;
      return (options.direction === "ASC" ? ranked : -ranked) ||
        left.index - right.index;
    })
    .map(({ item }) => item);
}

async function runGhJson(args: string[]): Promise<unknown> {
  const command = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

async function callGh<T>(run: RunGhJson, args: string[]): Promise<T> {
  return await run(args) as T;
}

function getFilterQualifier(field: ProjectField): string {
  const builtInQualifiers: Record<string, string> = {
    ASSIGNEES: "assignee",
    CLOSED: "closed",
    CREATED: "created",
    ISSUE_TYPE: "type",
    LABELS: "label",
    MILESTONE: "milestone",
    PARENT_ISSUE: "parent-issue",
    REPOSITORY: "repo",
    REVIEWERS: "reviewers",
    TITLE: "title",
    UPDATED: "updated",
  };
  const builtIn = field.dataType && builtInQualifiers[field.dataType];
  if (builtIn) return builtIn;

  const customTypes = new Set([
    "DATE",
    "ITERATION",
    "MULTI_SELECT",
    "NUMBER",
    "SINGLE_SELECT",
    "TEXT",
  ]);
  if (!field.dataType || !customTypes.has(field.dataType)) {
    throw new Error(`${field.name} 필드는 슬라이스 필터로 지원하지 않습니다.`);
  }
  return field.name.toLowerCase().replaceAll(" ", "-");
}

async function getViewConfiguration(
  location: ProjectViewLocation,
  run: RunGhJson,
) {
  const response = await callGh<ViewConfigurationResponse>(run, [
    "api",
    "graphql",
    "-f",
    `query=${VIEW_CONFIGURATION_QUERY}`,
    "-f",
    `owner=${location.owner}`,
    "-F",
    `projectNumber=${location.projectNumber}`,
    "-F",
    `viewNumber=${location.viewNumber}`,
  ]);
  const project = response.data.organization.projectV2;
  if (!project) {
    throw new Error(`프로젝트 ${location.projectNumber}을 찾지 못했습니다.`);
  }
  if (!project.view) {
    throw new Error(`뷰 ${location.viewNumber}을 찾지 못했습니다.`);
  }

  const [savedSort, ...extraSorts] = project.view.sortByFields.nodes;
  const overriddenSortField = location.sortFieldId
    ? project.fields.nodes.find((field) =>
      field &&
      (field.name === location.sortFieldId ||
        String(field.databaseId) === location.sortFieldId)
    )
    : undefined;
  if (location.sortFieldId && !overriddenSortField) {
    throw new Error(`정렬 필드 ${location.sortFieldId}을 찾지 못했습니다.`);
  }
  const sortField = overriddenSortField ?? savedSort?.field;
  const sortDirection = location.sortDirection ?? savedSort?.direction;
  if (
    !sortField?.name || !sortDirection ||
    (!overriddenSortField && extraSorts.length > 0)
  ) {
    throw new Error("단일선택 한 필드로 정렬된 뷰만 지원합니다.");
  }
  const sortOptions = sortField.issueField?.options ?? sortField.options ?? [];
  if (sortOptions.length === 0) {
    throw new Error(`${sortField.name} 옵션 순서를 읽지 못했습니다.`);
  }

  const groupFields = project.view.groupByFields?.nodes ?? [];
  const inferredSliceField = !location.sliceFieldId && location.sliceValue
    ? groupFields.length === 1 ? groupFields[0] : undefined
    : undefined;
  if (
    !location.sliceFieldId && location.sliceValue &&
    groupFields.length !== 1
  ) {
    throw new Error(
      "sliceBy[columnId]가 없고 뷰의 단일 그룹 필드도 없어 슬라이스를 해석할 수 없습니다.",
    );
  }
  const sliceFieldId = location.sliceFieldId ??
    (inferredSliceField?.databaseId === undefined
      ? inferredSliceField?.name
      : String(inferredSliceField.databaseId));
  const sliceField = sliceFieldId
    ? project.fields.nodes.find((field) =>
      field &&
      (field.name === sliceFieldId || String(field.databaseId) === sliceFieldId)
    )
    : undefined;
  if (sliceFieldId && !sliceField) {
    throw new Error(
      `슬라이스 필드 ${sliceFieldId}을 찾지 못했습니다.`,
    );
  }

  return {
    filter: location.filter ?? project.view.filter ?? "",
    sliceField: sliceField ? getFilterQualifier(sliceField) : undefined,
    sortDirection,
    sortField: sortField.name,
    sortOptions: sortOptions.map(({ name }) => name),
  };
}

async function listFilteredItems(
  location: ProjectViewLocation,
  query: string,
  run: RunGhJson,
): Promise<ProjectItem[]> {
  const args = [
    "project",
    "item-list",
    String(location.projectNumber),
    "--owner",
    location.owner,
    "--format",
    "json",
    "--limit",
    "1000",
  ];
  if (query) args.push("--query", query);

  const response = await callGh<ProjectItemListResponse>(run, args);
  if (response.totalCount > response.items.length) {
    throw new Error(
      `프로젝트 항목 ${response.totalCount}개 중 ${response.items.length}개만 ` +
        "조회되어 순서를 확정할 수 없습니다.",
    );
  }
  return response.items;
}

async function readSortValues(
  ids: readonly string[],
  fieldName: string,
  run: RunGhJson,
): Promise<Map<string, string | undefined>> {
  const batches = Array.from(
    { length: Math.ceil(ids.length / 50) },
    (_, index) => ids.slice(index * 50, (index + 1) * 50),
  );
  const responses = await Promise.all(
    batches.map((batch) =>
      callGh<ItemFieldValuesResponse>(run, [
        "api",
        "graphql",
        "-f",
        `query=${ITEM_FIELD_VALUES_QUERY}`,
        "-f",
        `fieldName=${fieldName}`,
        ...batch.flatMap((id) => ["-f", `ids[]=${id}`]),
      ])
    ),
  );

  return new Map(
    responses.flatMap((response) =>
      response.data.nodes.flatMap((node) =>
        node
          ? [
            [
              node.id,
              node.value?.projectName ?? node.value?.issueFieldValue?.issueName,
            ] as const,
          ]
          : []
      )
    ),
  );
}

export async function listProjectViewItems(
  viewUrl: string,
  options: {
    limit?: number;
    runGhJson?: RunGhJson;
  } = {},
): Promise<ListedProjectItem[]> {
  const location = parseProjectViewUrl(viewUrl);
  const run = options.runGhJson ?? runGhJson;
  const configuration = await getViewConfiguration(location, run);
  const query = buildViewQuery({
    filter: configuration.filter,
    sliceField: configuration.sliceField,
    sliceValue: location.sliceValue,
  });
  const items = await listFilteredItems(location, query, run);
  const sortValues = await readSortValues(
    items.map(({ id }) => id),
    configuration.sortField,
    run,
  );
  const ordered = sortViewItems(
    items.map((item) => ({
      ...item,
      sortValue: sortValues.get(item.id),
    })),
    {
      options: configuration.sortOptions,
      direction: configuration.sortDirection,
    },
  );
  const limited = options.limit === undefined
    ? ordered
    : ordered.slice(0, options.limit);

  return limited.map((item, index) => ({
    position: index + 1,
    sortField: configuration.sortField,
    sortValue: item.sortValue ?? null,
    number: item.content?.number ?? null,
    title: item.title,
    url: item.content?.url ?? null,
  }));
}

/**
 * 저장된 뷰 설정과 URL의 filterQuery, query, sliceBy, sortedBy를 반영한다.
 * 프로젝트 및 조직 이슈의 단일선택 필드를 옵션 순서로 정렬하며, 같은 값에서는
 * 프로젝트 항목의 상대 순서를 유지한다. 이 동률 순서는 화면과 다를 수 있다.
 * 식별자 없는 슬라이스는 단일 그룹 필드로만 해석하고, 다중 또는 비단일선택 정렬
 * 등 확정할 수 없는 상태는 오류로 보고한다. 출력은 위치, 정렬 필드와 값, 이슈
 * 번호, 제목, URL을 담은 JSON 배열이다.
 */
async function main(args: readonly string[]): Promise<void> {
  const parsed = parseArgs(args, { string: ["limit"] });
  const [viewUrl, ...extraPositionals] = parsed._;
  if (typeof viewUrl !== "string" || extraPositionals.length > 0) {
    throw new Error(
      "사용법: list_project_view_items.ts <view-url> [--limit N]",
    );
  }

  const limit = parsed.limit === undefined ? undefined : Number(parsed.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit에는 1 이상의 정수가 필요합니다.");
  }

  const output = await listProjectViewItems(viewUrl, { limit });
  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
  await main(Deno.args);
}
