# Domain Cleaner

A Google Apps Script that checks a list of new domains against **every Google Sheet
inside a Google Drive folder**, so you never scrape or contact the same domain twice.

For each new domain it tells you whether it already exists and **which spreadsheet(s)**
it was found in. It also catches duplicates *inside* the new list itself.

The full script is in **[`Code.gs`](Code.gs)**. Only the `CONFIG` block at the top
needs editing.

---

## 1. Where you paste the code

1. Open your **domain cleaner** spreadsheet (the one holding your new domains).
2. Menu: **Extensions → Apps Script**.
3. Delete whatever is in `Code.gs` (usually an empty `myFunction`).
4. Paste the entire contents of [`Code.gs`](Code.gs).
5. Click the **save** icon (or `Ctrl/Cmd + S`).

Attaching the script to the spreadsheet — rather than creating a standalone project —
is what gives you the **Domain Cleaner** menu inside the sheet.

---

## 2. What IDs you need to enter

Edit the `CONFIG` block at the top of the script:

```js
const CONFIG = {
  FOLDER_ID: "PASTE_FOLDER_ID_HERE",   // ← required
  NEW_DOMAINS_SPREADSHEET_ID: "",      // ← leave blank to use this spreadsheet
  NEW_DOMAINS_SHEET_NAME: "Sheet1",    // ← the tab with your new domains
  DOMAIN_HEADERS: ["domain", "domains"],
  ...
};
```

| Setting | Where to get it |
| --- | --- |
| `FOLDER_ID` | Open the Drive folder with your lead sheets. The URL is `https://drive.google.com/drive/folders/`**`1AbC...XyZ`** — the bold part is the ID. |
| `NEW_DOMAINS_SPREADSHEET_ID` | Leave as `""` if the script lives in the same spreadsheet as your new domains. Otherwise: `https://docs.google.com/spreadsheets/d/`**`1AbC...XyZ`**`/edit`. |
| `NEW_DOMAINS_SHEET_NAME` | The exact tab name at the bottom of the spreadsheet, e.g. `Sheet1`. |
| `DOMAIN_HEADERS` | Headers that mark a domain column. Matched case-insensitively after trimming, so `domain`, `Domain` and `DOMAINS ` all work. |

Your new-domains tab needs a header cell named `domain` in **row 1**, with the domains
below it. If that spreadsheet happens to live inside the scanned folder, the script
skips it automatically so it never matches itself.

Other settings you can leave alone:

| Setting | Default | What it does |
| --- | --- | --- |
| `RESULTS_SHEET_NAME` | `"Results"` | Tab the full report is written to. Cleared and rewritten each run. |
| `WRITE_STATUS_NEXT_TO_INPUT` | `true` | Also writes `status` / `found_in` / `duplicate_in_list` to the right of your input rows. Set to `false` to leave the input tab untouched. |
| `INCLUDE_SUBFOLDERS` | `false` | Set to `true` to scan sub-folders of `FOLDER_ID` too. |
| `READ_CHUNK_ROWS` | `20000` | Rows per batch read. Lower it only if you hit memory errors. |

---

## 3. How you run it

**From the spreadsheet (easiest):** reload the spreadsheet, then use
**Domain Cleaner → Check new domains** in the menu bar. A toast in the bottom-right
shows the summary when it finishes.

**From the editor:** pick `checkNewDomains` in the function dropdown and press **Run**.
Open **Execution log** (`Ctrl/Cmd + Enter`) to watch progress:

```
Scanning spreadsheet: Leads January
  Found 12,430 domains
Scanning spreadsheet: Apollo SaaS
  Found 8,921 domains
Finished. 47 spreadsheets scanned, 112 tabs, 84,203 unique existing domains indexed.
```

Your lead spreadsheets are only ever **read** — nothing is written back to them.

---

## 4. What permissions Google will ask for

The first run shows *"Authorization required"*. Click **Review permissions**, pick your
account, then — because the script is unpublished — click **Advanced → Go to
Domain Cleaner (unsafe)**. That warning is normal for your own scripts.

You will be asked to allow:

- **See, edit, create, and delete all your Google Sheets spreadsheets** — to read your
  lead sheets and write the results tab.
- **See, edit, create, and delete all of your Google Drive files** — to list the Google
  Sheets inside the folder.
- **Display and run third-party web content in prompts and sidebars** — for the menu
  and the toast notification.
- **Run as you, even when you are not present** — only if you set up the automatic
  trigger in step 6.

You grant these once. Nothing leaves your Google account: no external APIs, no paid
services.

---

## 5. How the output looks

A **Results** tab, rewritten on every run:

| source_row | domain | normalized_domain | status | found_in | duplicate_in_list |
| --- | --- | --- | --- | --- | --- |
| 2 | https://example.com | example.com | DUPLICATE | Leads January, Apollo SaaS, Old Leads | YES — rows 2, 4 |
| 3 | test.com | test.com | NEW | Not found | YES — rows 3, 5 |
| 4 | www.example.com | example.com | DUPLICATE | Leads January, Apollo SaaS, Old Leads | YES — rows 2, 4 |
| 5 | TEST.com/ | test.com | DUPLICATE IN LIST | Earlier row in this list | YES — rows 3, 5 |
| 6 | ABC.com | abc.com | DUPLICATE | Apollo SaaS | |
| 7 | garbage value | | INVALID | Not a valid domain | |

**Statuses**

| Status | Meaning |
| --- | --- |
| `DUPLICATE` | Already exists in the Drive folder. `found_in` lists **every** spreadsheet it appears in. |
| `NEW` | Not in the folder, and this is its first appearance in your list — safe to contact. |
| `DUPLICATE IN LIST` | Not in the folder, but a row above it in the same list is the same domain. |
| `INVALID` | The cell held something that is not a domain. Blank cells are skipped entirely, never counted. |

`duplicate_in_list` is filled in on **all** rows sharing a normalized domain — including
the first — so `example.com`, `www.example.com` and `https://example.com` are visibly
the same domain.

With `WRITE_STATUS_NEXT_TO_INPUT: true` the same three columns are also appended beside
your input rows, aligned row-for-row.

And a summary in the log (and as a toast):

```
=== SUMMARY ===
Total new domains checked: 5,000
Unique new domains:        4,910
NEW:                       3,800
DUPLICATE (in folder):     1,150
DUPLICATE IN LIST:         50
Invalid values:            0
Google Sheets scanned:     47
Tabs scanned:              112
Existing domains indexed:  84,203
Errors:                    2
Time:                      74.3s
```

A spreadsheet that cannot be opened is logged, counted under **Errors**, and listed by
name at the end of the summary — the scan carries on through the rest.

---

## 6. Setting up an automatic run

In the Apps Script editor, select **`createDailyTrigger`** from the function dropdown and
press **Run** once. `checkNewDomains()` then runs every day around 8am. Running it again
replaces the schedule instead of stacking up a second one.

To change the time, edit `.atHour(8)`. To stop it, run **`deleteTriggers`**. You can also
manage schedules by hand under the **clock icon (Triggers)** in the left sidebar.

Triggered runs have no UI, so read their outcome under **Executions** in the sidebar.

---

## How the matching works

Every value on both sides is normalized before comparison, so these all collapse to
`example.com`:

```
https://example.com    http://example.com    https://www.example.com
www.example.com        example.com/          EXAMPLE.COM
example.com:8443       example.com/path?utm_source=x#top
```

Normalization strips the scheme, any `user:pass@` prefix, the path, query string,
fragment and port, a leading `www.` and trailing dots, then lowercases the result.
Anything left without a dot, or containing spaces or stray punctuation, is treated as
`INVALID` rather than as a domain.

**Every** column headed `domain` or `domains` is read, on **every tab**, of **every**
Google Sheet in the folder — a sheet may legitimately have several columns with the same
header:

| Company | domain | Name | domain | Email |
| --- | --- | --- | --- | --- |
| ABC | abc.com | John | abc.com | john@abc.com |

Non-Sheets files (PDFs, CSVs, Docs) in the folder are ignored.

## Performance

The folder is scanned **once**, into an in-memory lookup, and the new domains are then
checked against it — no reopening a spreadsheet per domain. Reads are batched
`getValues()` calls over whole columns, never cell by cell, and domain sources are stored
as compact indexes so memory stays flat at hundreds of thousands of domains.

Apps Script stops any script at ~6 minutes. If indexing is still running at 5 minutes the
script stops with an explanatory error rather than writing a half-scanned result, because
a partial scan would mark already-contacted domains as `NEW`. If you hit that, split the
lead spreadsheets across two folders and run the check once per folder, or archive older
sheets. Adjust the limit with `CONFIG.MAX_INDEXING_MS`.
