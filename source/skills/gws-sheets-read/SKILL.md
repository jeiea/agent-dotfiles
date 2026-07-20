---
name: gws-sheets-read
description: "Google Sheets: Read values from a spreadsheet."
metadata:
  openclaw:
    category: "productivity"
    requires:
      bins: ["gws"]
    cliHelp: "gws sheets +read --help"
---

# sheets +read

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth, global flags, and security rules. If missing, run `gws generate-skills` to create it.

Read values from a spreadsheet

## Usage

```bash
gws sheets +read --spreadsheet <ID> --range <RANGE>
```

## Flags

| Flag            | Required | Default | Description                         |
| --------------- | -------- | ------- | ----------------------------------- |
| `--spreadsheet` | ✓        | —       | Spreadsheet ID                      |
| `--range`       | ✓        | —       | Range to read (e.g. 'Sheet1!A1:B2') |

## Examples

```bash
gws sheets +read --spreadsheet ID --range 'Sheet1!A1:D10'
gws sheets +read --spreadsheet ID --range Sheet1
```

## Tips

- Read-only — never modifies the spreadsheet.
- For advanced options, use the raw values.get API.

### URL의 `gid` → 탭 이름 매핑

공유 URL에 `#gid=2049372008`가 있으면 탭을 이름으로 조회할 수 없으므로 먼저 메타데이터에서 매핑합니다.

```bash
gws sheets spreadsheets get --params '{"spreadsheetId":"<ID>"}' \
  | tail -n +2 \
  | jq '.sheets[] | {title: .properties.title, sheetId: .properties.sheetId}'
```

- `sheetId`가 URL의 `gid`
- 출력 첫 줄(`Using keyring backend: keyring`)을 `tail -n +2`로 버려야 jq가 파싱
- 찾은 `title`로 `--range '<title>!A1:Z'` 또는 전체 `--range <title>` 지정

## See Also

- [gws-shared](../gws-shared/SKILL.md) — Global flags and auth
- [gws-sheets](../gws-sheets/SKILL.md) — All read and write spreadsheets commands
