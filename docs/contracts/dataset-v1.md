# Dataset Plain

Open a **Dataset** in Space and choose **Open CSV or TSV** or **Paste table**. In the preview, choose comma or tab, confirm whether the first row contains headers, and set each column's type. Preview shows the first eight data rows. Validation checks the full input and gives physical source row and column numbers for the first twenty issues.

Select **Import table** or **Replace table** after the preview passes. Use a column heading to sort, and **Filter rows** to apply a case-insensitive substring search across raw cells. Use the numbered row's cell button to edit its value. Forge keeps the draft when validation fails and identifies the stored row and column.

## Data and limits

| Field | Contract |
| --- | --- |
| String | Exact decoded text |
| Number | Finite binary64 number with a decimal point if needed. The stored text also preserves formatting such as leading zeros. |
| Boolean | True or false, matched without regard to ASCII letter case |
| Date | Gregorian date in YYYY-MM-DD |
| Empty cell | Empty raw string and null typed value |
| Size | 512 KiB of UTF-8 input, 2,000 data rows, 32 columns, 4,096 UTF-8 bytes per cell and a 1 MiB serialized Plain |

CSV and TSV read optional UTF-8 BOM, CRLF and LF line endings, quoted cells with doubled quotes and multiline quoted values. Short rows get empty cells. Extra cells are reported as an issue. Forge supplies a name for each blank header. Headerless imports receive generated column names.

The **forge.dataset** schema 1 Portal stores ordered columns, typed column declarations, and rows with UUIDs and raw cell strings. A cell edit retains its row UUID. Replacement and Clipboard duplication assign new UUIDs. The **rows** port publishes **TabularData**. **datasetPage** returns raw and typed values with the column definitions, original row ordinals, a total, and a next offset. A page supports up to 100 records, up to 240 characters of filter text, and one optional sort column. Empty values sort last in both directions. The source revision is the SHA-256 of the canonical Portal payload.

## Spreadsheet export

**Export CSV** and **Export TSV** write the complete saved table in stored order through the OS save picker. Forge quotes each field and doubles embedded double quotes. If a String cell or column header begins with a formula-like character, including after common whitespace or formatting characters, the exported field starts with the visible prefix **text: **. This prefix also protects leading tabs and line breaks. The stored raw value stays available in Forge. The numeric field -2 is exported with that numeric value. Spreadsheet applications have different CSV import behavior. [OWASP CSV injection guidance](https://community.owasp.org/attacks/CSV_Injection)

Forge verifies the Dataset revision after the picker and publishes a completed file at a new path. A concurrent edit, existing destination or canceled picker ends the current export.
