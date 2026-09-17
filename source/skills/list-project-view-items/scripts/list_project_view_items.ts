interface ProjectViewLocation {
  owner: string;
  projectNumber: number;
  viewNumber: number;
  sliceValue?: string;
}

interface ViewQueryInput {
  filter: string;
  sliceField?: string;
  sliceValue?: string;
}

type SortDirection = "ASC" | "DESC";

interface PrioritizedItem {
  priority?: string;
}

interface ProjectItem extends PrioritizedItem {
  id: string;
  title: string;
  content?: {
    number?: number;
    url?: string;
  };
}

interface ViewConfigurationResponse {
  data: {
    organization: {
      projectV2: {
        views: {
          nodes: Array<{
            number: number;
            filter: string;
            groupByFields: {
              nodes: Array<{ name: string }>;
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
          }>;
        };
      };
    };
  };
}

interface ProjectItemListResponse {
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

const VIEW_CONFIGURATION_QUERY = `
query($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      views(first: 100) {
        nodes {
          number
          filter
          groupByFields(first: 10) {
            nodes {
              ... on ProjectV2Field { name }
              ... on ProjectV2SingleSelectField { name }
              ... on ProjectV2IterationField { name }
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

  return {
    owner: decodeURIComponent(match[1]!),
    projectNumber: Number(match[2]),
    viewNumber: Number(match[3]),
    sliceValue: url.searchParams.get("sliceBy[value]") ?? undefined,
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

export function sortViewItems<T extends PrioritizedItem>(
  items: readonly T[],
  priorities: readonly string[],
  direction: SortDirection,
): T[] {
  const priorityOrder = new Map(
    priorities.map((priority, index) => [priority, index]),
  );
  const missingOrder = priorities.length;

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftOrder = left.item.priority === undefined
        ? missingOrder
        : priorityOrder.get(left.item.priority) ?? missingOrder;
      const rightOrder = right.item.priority === undefined
        ? missingOrder
        : priorityOrder.get(right.item.priority) ?? missingOrder;
      const ranked = direction === "ASC"
        ? leftOrder - rightOrder
        : rightOrder === missingOrder || leftOrder === missingOrder
        ? leftOrder - rightOrder
        : rightOrder - leftOrder;
      return ranked || left.index - right.index;
    })
    .map(({ item }) => item);
}

async function runGhJson<T>(args: string[]): Promise<T> {
  const command = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return JSON.parse(new TextDecoder().decode(result.stdout)) as T;
}

async function getViewConfiguration(location: ProjectViewLocation) {
  const response = await runGhJson<ViewConfigurationResponse>([
    "api",
    "graphql",
    "-f",
    `query=${VIEW_CONFIGURATION_QUERY}`,
    "-F",
    `owner=${location.owner}`,
    "-F",
    `projectNumber=${location.projectNumber}`,
  ]);
  const view = response.data.organization.projectV2.views.nodes.find(
    ({ number }) => number === location.viewNumber,
  );
  if (!view) throw new Error(`뷰 ${location.viewNumber}을 찾지 못했습니다.`);

  const [sort, ...extraSorts] = view.sortByFields.nodes;
  if (!sort || extraSorts.length > 0 || sort.field?.name !== "Priority") {
    throw new Error("Priority 한 필드로 정렬된 뷰만 지원합니다.");
  }
  const priorityOptions = sort.field.issueField?.options ?? sort.field.options;
  if (priorityOptions.length === 0) {
    throw new Error("Priority 옵션 순서를 읽지 못했습니다.");
  }

  const groupFields = view.groupByFields.nodes;
  if (location.sliceValue && groupFields.length !== 1) {
    throw new Error("슬라이스 필드를 하나로 확정할 수 없습니다.");
  }

  return {
    filter: view.filter,
    sliceField: location.sliceValue ? groupFields[0]?.name : undefined,
    sortDirection: sort.direction,
    priorityOptions: priorityOptions.map(({ name }) => name),
  };
}

async function listFilteredItems(
  location: ProjectViewLocation,
  query: string,
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
  return (await runGhJson<ProjectItemListResponse>(args)).items;
}

async function readPriorities(
  ids: readonly string[],
  fieldName: string,
): Promise<Map<string, string | undefined>> {
  const batches = Array.from(
    { length: Math.ceil(ids.length / 50) },
    (_, index) => ids.slice(index * 50, (index + 1) * 50),
  );
  const responses = await Promise.all(
    batches.map((batch) =>
      runGhJson<ItemFieldValuesResponse>([
        "api",
        "graphql",
        "-f",
        `query=${ITEM_FIELD_VALUES_QUERY}`,
        "-F",
        `fieldName=${fieldName}`,
        ...batch.flatMap((id) => ["-F", `ids[]=${id}`]),
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

function parseLimit(args: readonly string[]): number | undefined {
  const index = args.indexOf("--limit");
  if (index === -1) return undefined;
  const limit = Number(args[index + 1]);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit에는 1 이상의 정수가 필요합니다.");
  }
  return limit;
}

async function main(args: readonly string[]): Promise<void> {
  const url = args.find((arg) => !arg.startsWith("--") && /^https:/.test(arg));
  if (!url) {
    throw new Error(
      "사용법: list_project_view_items.ts <view-url> [--limit N]",
    );
  }
  const location = parseProjectViewUrl(url);
  const limit = parseLimit(args);
  const configuration = await getViewConfiguration(location);
  const query = buildViewQuery({
    filter: configuration.filter,
    sliceField: configuration.sliceField,
    sliceValue: location.sliceValue,
  });
  const items = await listFilteredItems(location, query);
  const priorities = await readPriorities(
    items.map(({ id }) => id),
    "Priority",
  );
  const ordered = sortViewItems(
    items.map((item) => ({ ...item, priority: priorities.get(item.id) })),
    configuration.priorityOptions,
    configuration.sortDirection,
  ).slice(0, limit);

  const output = ordered.map((item, index) => ({
    position: index + 1,
    priority: item.priority ?? null,
    number: item.content?.number ?? null,
    title: item.title,
    url: item.content?.url ?? null,
  }));
  console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
  await main(Deno.args);
}
