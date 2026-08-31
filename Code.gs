/**
 * ============================================================================
 *  DOMAIN CLEANER — duplicate checker for Google Sheets
 * ============================================================================
 *
 *  Checks a list of new domains against every Google Sheet inside a Google
 *  Drive folder, and reports which domains you have already scraped/contacted
 *  and which spreadsheet(s) they came from.
 *
 *  Read-only against your lead spreadsheets. Nothing is ever written to them.
 *
 *  Setup: fill in the CONFIG block below, then run checkNewDomains()
 *         (or use the "Domain Cleaner" menu that appears in the spreadsheet).
 * ============================================================================
 */


/* ============================================================================
 *  CONFIGURATION — this is the only part you need to edit
 * ==========================================================================*/

const CONFIG = {

  // The Google Drive folder that holds all your existing lead spreadsheets.
  // Get it from the folder URL:
  // https://drive.google.com/drive/folders/THIS_LONG_ID_HERE
  FOLDER_ID: "PASTE_FOLDER_ID_HERE",

  // The spreadsheet holding your NEW domains.
  // Leave "" to use the spreadsheet this script is attached to (recommended,
  // since the script lives in your "domain cleaner" spreadsheet).
  NEW_DOMAINS_SPREADSHEET_ID: "",

  // The tab inside that spreadsheet that holds the new domains.
  NEW_DOMAINS_SHEET_NAME: "Sheet1",

  // Header names that mark a domain column. Matched case-insensitively
  // against the first row of every tab, after trimming whitespace.
  DOMAIN_HEADERS: ["domain", "domains"],

  // Where the results are written (a tab in the NEW domains spreadsheet).
  // It is cleared and rewritten on every run.
  RESULTS_SHEET_NAME: "Results",

  // Also write status / found_in / duplicate_in_list columns directly to the
  // right of your input data, on the same rows. Set to false to leave your
  // input tab completely untouched.
  WRITE_STATUS_NEXT_TO_INPUT: true,

  // Scan Google Sheets in sub-folders of FOLDER_ID as well.
  INCLUDE_SUBFOLDERS: false,

  // Rows read per batch call. Lower this only if you hit memory errors.
  READ_CHUNK_ROWS: 20000,

  // Rows written per batch call.
  WRITE_CHUNK_ROWS: 5000,

  // Max spreadsheet names listed in the found_in cell before it is truncated.
  MAX_FOUND_IN_LISTED: 25,

  // Apps Script kills a script at 6 minutes. If indexing is still running
  // after this many milliseconds we stop with a clear message instead of
  // producing a half-scanned (and therefore unsafe) result.
  MAX_INDEXING_MS: 5 * 60 * 1000
};


/* ============================================================================
 *  STATUS VALUES
 * ==========================================================================*/

const STATUS = {
  DUPLICATE: "DUPLICATE",              // already exists in the Drive folder
  DUPLICATE_IN_LIST: "DUPLICATE IN LIST", // not in the folder, but repeated in the new list
  NEW: "NEW",                          // safe to contact
  INVALID: "INVALID"                   // cell had something that is not a domain
};


/* ============================================================================
 *  MENU
 * ==========================================================================*/

/**
 * Adds a "Domain Cleaner" menu when the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Domain Cleaner")
    .addItem("Check new domains", "checkNewDomains")
    .addToUi();
}


/* ============================================================================
 *  MAIN
 * ==========================================================================*/

/**
 * Entry point. Scans the Drive folder once, builds an in-memory index of every
 * existing domain, then checks the new domain list against it.
 */
function checkNewDomains() {
  const startedAt = Date.now();
  Logger.log("=== Domain Cleaner started ===");

  const targetSs = openNewDomainsSpreadsheet_();
  const input = readNewDomains_(targetSs);

  if (input.rows.length === 0) {
    const msg = 'No domains found in column "' + input.headerName + '" of sheet "' +
                CONFIG.NEW_DOMAINS_SHEET_NAME + '".';
    Logger.log(msg);
    notify_("Domain Cleaner", msg);
    return;
  }
  Logger.log("Read " + fmt_(input.rows.length) + " non-empty domain cells from the new list.");

  // Never scan the new-domains spreadsheet itself, even if it lives in the folder.
  const index = buildDomainIndex_(CONFIG.FOLDER_ID, targetSs.getId());

  const results = compareAgainstIndex_(input.rows, index);

  writeResultsSheet_(targetSs, results.rows);
  if (CONFIG.WRITE_STATUS_NEXT_TO_INPUT) {
    writeStatusNextToInput_(input, results.rows);
  }

  const summary = buildSummary_(results, index, input, Date.now() - startedAt);
  Logger.log(summary);
  notify_("Domain Cleaner — finished", summary);
}


/* ============================================================================
 *  STEP 1 — INDEX EVERY EXISTING DOMAIN IN THE DRIVE FOLDER
 * ==========================================================================*/

/**
 * Walks the Drive folder once and builds a lookup of every normalized domain.
 *
 * The lookup is a Map<domain, "0,3,7"> where the numbers are indexes into
 * sourceNames. Storing small index strings instead of name arrays keeps memory
 * flat when there are hundreds of thousands of domains.
 *
 * @param {string} folderId Drive folder to scan.
 * @param {string} skipSpreadsheetId Spreadsheet to ignore (the new domain list).
 * @return {{map: !Map, sourceNames: !Array<string>, filesScanned: number,
 *           tabsScanned: number, errors: !Array<string>, startedAt: number}}
 */
function buildDomainIndex_(folderId, skipSpreadsheetId) {
  if (!folderId || folderId === "PASTE_FOLDER_ID_HERE") {
    throw new Error('CONFIG.FOLDER_ID is not set. Open the script and paste your Drive folder ID.');
  }

  let rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(folderId);
  } catch (e) {
    throw new Error('Could not open the Drive folder "' + folderId + '". ' +
                    'Check the ID and make sure your account has access. (' + e.message + ')');
  }

  const index = {
    map: new Map(),
    sourceNames: [],
    filesScanned: 0,
    tabsScanned: 0,
    errors: [],
    startedAt: Date.now()
  };

  Logger.log('Scanning Drive folder: "' + rootFolder.getName() + '"' +
             (CONFIG.INCLUDE_SUBFOLDERS ? " (including sub-folders)" : ""));

  const folders = [rootFolder];
  while (folders.length > 0) {
    const folder = folders.shift();

    const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (files.hasNext()) {
      const file = files.next();
      if (file.getId() === skipSpreadsheetId) {
        Logger.log('Skipping "' + file.getName() + '" (this is the new-domains spreadsheet).');
        continue;
      }
      scanOneSpreadsheet_(file, index);
    }

    if (CONFIG.INCLUDE_SUBFOLDERS) {
      const subFolders = folder.getFolders();
      while (subFolders.hasNext()) {
        folders.push(subFolders.next());
      }
    }
  }

  Logger.log("Finished. " + fmt_(index.filesScanned) + " spreadsheets scanned, " +
             fmt_(index.tabsScanned) + " tabs, " + fmt_(index.map.size) +
             " unique existing domains indexed.");
  return index;
}


/**
 * Reads every domain column of every tab of one spreadsheet into the index.
 * Failures are logged and swallowed so one broken file cannot stop the run.
 *
 * @param {!DriveApp.File} file
 * @param {!Object} index
 */
function scanOneSpreadsheet_(file, index) {
  const name = file.getName();
  checkTimeBudget_(index.startedAt, name);

  let found = 0;
  const sourceIdx = index.sourceNames.length;

  try {
    Logger.log("Scanning spreadsheet: " + name);
    const ss = SpreadsheetApp.openById(file.getId());
    const sheets = ss.getSheets();

    for (let s = 0; s < sheets.length; s++) {
      const sheet = sheets[s];
      index.tabsScanned++;
      try {
        found += readDomainColumns_(sheet, function (domain) {
          addToIndex_(index, domain, sourceIdx);
        });
      } catch (tabErr) {
        const msg = name + " → tab \"" + sheet.getName() + "\": " + tabErr.message;
        index.errors.push(msg);
        Logger.log("  ERROR " + msg);
      }
    }

    index.sourceNames.push(name);
    index.filesScanned++;
    Logger.log("  Found " + fmt_(found) + " domains");

  } catch (err) {
    const msg = name + ": " + err.message;
    index.errors.push(msg);
    Logger.log("  ERROR — could not open " + msg + " (continuing)");
  }
}


/**
 * Finds every column in a tab whose header is a domain header and streams the
 * normalized values to a callback. Reads in batches, never cell by cell.
 *
 * @param {!Sheet} sheet
 * @param {function(string)} onDomain Called once per non-empty, valid domain.
 * @return {number} How many domain values were passed to the callback.
 */
function readDomainColumns_(sheet, onDomain) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const columns = findDomainColumns_(headers);
  if (columns.length === 0) return 0;

  const dataRows = lastRow - 1;
  let count = 0;

  // One batch call per column per chunk — reads only the columns we need.
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c] + 1; // 1-based for getRange
    for (let offset = 0; offset < dataRows; offset += CONFIG.READ_CHUNK_ROWS) {
      const numRows = Math.min(CONFIG.READ_CHUNK_ROWS, dataRows - offset);
      const values = sheet.getRange(2 + offset, col, numRows, 1).getValues();
      for (let r = 0; r < values.length; r++) {
        const domain = normalizeDomain_(values[r][0]);
        if (domain) {
          onDomain(domain);
          count++;
        }
      }
    }
  }
  return count;
}


/**
 * Returns the 0-based indexes of EVERY column whose header is a domain header.
 * A tab may legitimately have several columns with the same header.
 *
 * @param {!Array<*>} headerRow
 * @return {!Array<number>}
 */
function findDomainColumns_(headerRow) {
  const wanted = CONFIG.DOMAIN_HEADERS.map(function (h) {
    return String(h).trim().toLowerCase();
  });
  const columns = [];
  for (let i = 0; i < headerRow.length; i++) {
    const header = String(headerRow[i] === null || headerRow[i] === undefined ? "" : headerRow[i])
      .trim().toLowerCase();
    if (header && wanted.indexOf(header) !== -1) columns.push(i);
  }
  return columns;
}


/**
 * Records that a domain was seen in the spreadsheet at sourceIdx.
 *
 * @param {!Object} index
 * @param {string} domain Already normalized.
 * @param {number} sourceIdx
 */
function addToIndex_(index, domain, sourceIdx) {
  const existing = index.map.get(domain);
  if (existing === undefined) {
    index.map.set(domain, String(sourceIdx));
    return;
  }
  const key = String(sourceIdx);
  const parts = existing.split(",");
  if (parts.indexOf(key) === -1) {
    index.map.set(domain, existing + "," + key);
  }
}


/**
 * Stops with a helpful message rather than letting Apps Script kill the run
 * mid-scan, which would produce dangerously incomplete "NEW" results.
 *
 * @param {number} startedAt
 * @param {string} currentFile
 */
function checkTimeBudget_(startedAt, currentFile) {
  if (Date.now() - startedAt < CONFIG.MAX_INDEXING_MS) return;
  throw new Error(
    "Stopped after " + Math.round((Date.now() - startedAt) / 1000) + "s while scanning \"" +
    currentFile + "\". Apps Script allows about 6 minutes per run, and a partial scan " +
    "would wrongly mark existing domains as NEW. Split the lead spreadsheets across two " +
    "folders and run the check once per folder, or archive older sheets."
  );
}


/* ============================================================================
 *  STEP 2 — READ THE NEW DOMAIN LIST
 * ==========================================================================*/

/**
 * @return {!Spreadsheet} The spreadsheet holding the new domains.
 */
function openNewDomainsSpreadsheet_() {
  const id = String(CONFIG.NEW_DOMAINS_SPREADSHEET_ID || "").trim();
  if (!id || id === "PASTE_SPREADSHEET_ID_HERE") {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) {
      throw new Error("CONFIG.NEW_DOMAINS_SPREADSHEET_ID is empty and there is no active " +
                      "spreadsheet. Paste the ID of your new-domains spreadsheet.");
    }
    return active;
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error('Could not open the new-domains spreadsheet "' + id + '". (' + e.message + ')');
  }
}


/**
 * Reads the new domains, keeping the original text and the row it came from.
 * Empty cells are skipped and never treated as domains.
 *
 * @param {!Spreadsheet} ss
 * @return {{rows: !Array<{row: number, raw: string, domain: string}>,
 *           sheet: !Sheet, column: number, headerName: string, lastColumn: number}}
 */
function readNewDomains_(ss) {
  const sheet = ss.getSheetByName(CONFIG.NEW_DOMAINS_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + CONFIG.NEW_DOMAINS_SHEET_NAME + '" was not found in "' +
                    ss.getName() + '". Check CONFIG.NEW_DOMAINS_SHEET_NAME.');
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return { rows: [], sheet: sheet, column: 1, headerName: CONFIG.DOMAIN_HEADERS[0], lastColumn: lastCol };
  }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const columns = findDomainColumns_(headers);
  if (columns.length === 0) {
    throw new Error('No column named ' + CONFIG.DOMAIN_HEADERS.join(" or ") + ' was found in row 1 of "' +
                    sheet.getName() + '". Add a header cell named "' + CONFIG.DOMAIN_HEADERS[0] + '".');
  }
  if (columns.length > 1) {
    Logger.log("Note: the new-domains sheet has " + columns.length +
               " domain columns. Using the first one (column " + (columns[0] + 1) + ").");
  }

  const col = columns[0];
  const dataRows = lastRow - 1;
  const rows = [];

  for (let offset = 0; offset < dataRows; offset += CONFIG.READ_CHUNK_ROWS) {
    const numRows = Math.min(CONFIG.READ_CHUNK_ROWS, dataRows - offset);
    const values = sheet.getRange(2 + offset, col + 1, numRows, 1).getValues();
    for (let r = 0; r < values.length; r++) {
      const raw = String(values[r][0] === null || values[r][0] === undefined ? "" : values[r][0]).trim();
      if (!raw) continue; // blank cell / blank row
      rows.push({ row: 2 + offset + r, raw: raw, domain: normalizeDomain_(raw) });
    }
  }

  return {
    rows: rows,
    sheet: sheet,
    column: col + 1,
    headerName: String(headers[col]).trim(),
    lastColumn: lastCol
  };
}


/* ============================================================================
 *  STEP 3 — COMPARE
 * ==========================================================================*/

/**
 * Checks every new domain against the index and against the rest of the list.
 *
 * @param {!Array<!Object>} newRows
 * @param {!Object} index
 * @return {{rows: !Array<!Array<*>>, counts: !Object, uniqueNew: number}}
 */
function compareAgainstIndex_(newRows, index) {
  // Which rows of the new list share each normalized domain.
  const occurrences = new Map();
  for (let i = 0; i < newRows.length; i++) {
    const d = newRows[i].domain;
    if (!d) continue;
    const list = occurrences.get(d);
    if (list) list.push(newRows[i].row);
    else occurrences.set(d, [newRows[i].row]);
  }

  const counts = { duplicate: 0, duplicateInList: 0, new: 0, invalid: 0 };
  const seen = new Set();
  const rows = [];

  for (let i = 0; i < newRows.length; i++) {
    const item = newRows[i];
    let status;
    let foundIn = "";
    let inList = "";

    if (!item.domain) {
      status = STATUS.INVALID;
      foundIn = "Not a valid domain";
      counts.invalid++;
    } else {
      const sources = index.map.get(item.domain);
      const repeats = occurrences.get(item.domain);
      const isRepeat = repeats.length > 1;

      if (isRepeat) {
        inList = "YES — rows " + joinCapped_(repeats, CONFIG.MAX_FOUND_IN_LISTED);
      }

      if (sources !== undefined) {
        status = STATUS.DUPLICATE;
        foundIn = resolveSourceNames_(sources, index.sourceNames);
        counts.duplicate++;
      } else if (isRepeat && seen.has(item.domain)) {
        status = STATUS.DUPLICATE_IN_LIST;
        foundIn = "Earlier row in this list";
        counts.duplicateInList++;
      } else {
        status = STATUS.NEW;
        foundIn = "Not found";
        counts.new++;
      }
      seen.add(item.domain);
    }

    rows.push([item.row, item.raw, item.domain, status, foundIn, inList]);
  }

  return { rows: rows, counts: counts, uniqueNew: occurrences.size };
}


/**
 * Turns "0,3,7" into "Leads January, Apollo SaaS, Old Leads".
 *
 * @param {string} sources
 * @param {!Array<string>} sourceNames
 * @return {string}
 */
function resolveSourceNames_(sources, sourceNames) {
  const idxs = sources.split(",");
  const names = [];
  for (let i = 0; i < idxs.length && i < CONFIG.MAX_FOUND_IN_LISTED; i++) {
    names.push(sourceNames[Number(idxs[i])]);
  }
  let out = names.join(", ");
  if (idxs.length > CONFIG.MAX_FOUND_IN_LISTED) {
    out += " … (+" + (idxs.length - CONFIG.MAX_FOUND_IN_LISTED) + " more)";
  }
  return out;
}


/* ============================================================================
 *  STEP 4 — NORMALIZE
 * ==========================================================================*/

/**
 * Normalizes any of these to "example.com":
 *   https://example.com   http://example.com   https://www.example.com
 *   www.example.com   example.com/   EXAMPLE.COM   example.com/path?q=1#top
 *
 * Strips the scheme, any user:pass@ prefix, the path, query string, fragment,
 * the port, a leading "www." and trailing dots, then lowercases the result.
 *
 * @param {*} value Raw cell value.
 * @return {string} The normalized domain, or "" if the value is not a domain.
 */
function normalizeDomain_(value) {
  if (value === null || value === undefined) return "";

  let s = String(value).trim().toLowerCase();
  if (!s) return "";

  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, ""); // http:// https:// ftp:// …
  s = s.replace(/^\/\//, "");                    // //example.com
  s = s.split(/[\/?#]/)[0];                      // path, query string, fragment
  if (s.indexOf("@") !== -1) {                   // user:pass@host or an email
    s = s.substring(s.lastIndexOf("@") + 1);
  }
  s = s.split(":")[0];                           // port
  s = s.replace(/^www\./, "");
  s = s.replace(/\.+$/, "");                     // trailing dot(s)
  s = s.trim();

  if (!s) return "";
  if (s.indexOf(".") === -1) return "";          // no TLD — not a domain
  if (/[\s,;'"()<>\\]/.test(s)) return "";       // stray text, not a hostname
  if (/^[.\-]|[.\-]$/.test(s)) return "";        // cannot start or end with . or -

  return s;
}


/* ============================================================================
 *  STEP 5 — WRITE RESULTS
 * ==========================================================================*/

/**
 * Rewrites the results tab in the new-domains spreadsheet.
 *
 * @param {!Spreadsheet} ss
 * @param {!Array<!Array<*>>} rows
 */
function writeResultsSheet_(ss, rows) {
  let sheet = ss.getSheetByName(CONFIG.RESULTS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.RESULTS_SHEET_NAME);
  sheet.clear();

  const headers = ["source_row", "domain", "normalized_domain", "status", "found_in", "duplicate_in_list"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  sheet.setFrozenRows(1);

  for (let offset = 0; offset < rows.length; offset += CONFIG.WRITE_CHUNK_ROWS) {
    const chunk = rows.slice(offset, offset + CONFIG.WRITE_CHUNK_ROWS);
    sheet.getRange(2 + offset, 1, chunk.length, headers.length).setValues(chunk);
  }

  sheet.autoResizeColumns(1, headers.length);
  Logger.log('Results written to the "' + CONFIG.RESULTS_SHEET_NAME + '" tab.');
}


/**
 * Adds status / found_in / duplicate_in_list columns beside the input rows so
 * you can read the verdict next to the original data.
 *
 * @param {!Object} input Result of readNewDomains_.
 * @param {!Array<!Array<*>>} rows Result rows, [sourceRow, raw, norm, status, foundIn, inList].
 */
function writeStatusNextToInput_(input, rows) {
  const sheet = input.sheet;
  const firstCol = input.lastColumn + 1;
  const lastRow = sheet.getLastRow();
  const headers = ["status", "found_in", "duplicate_in_list"];

  // Blank grid so rows with empty domain cells stay empty.
  const grid = [];
  for (let r = 0; r < lastRow - 1; r++) grid.push(["", "", ""]);
  for (let i = 0; i < rows.length; i++) {
    grid[rows[i][0] - 2] = [rows[i][3], rows[i][4], rows[i][5]];
  }

  sheet.getRange(1, firstCol, 1, headers.length).setValues([headers]).setFontWeight("bold");
  for (let offset = 0; offset < grid.length; offset += CONFIG.WRITE_CHUNK_ROWS) {
    const chunk = grid.slice(offset, offset + CONFIG.WRITE_CHUNK_ROWS);
    sheet.getRange(2 + offset, firstCol, chunk.length, headers.length).setValues(chunk);
  }
  Logger.log("Status columns written next to the input data (columns " +
             firstCol + "–" + (firstCol + headers.length - 1) + ").");
}


/* ============================================================================
 *  SUMMARY + HELPERS
 * ==========================================================================*/

/**
 * @return {string} A human readable run summary.
 */
function buildSummary_(results, index, input, elapsedMs) {
  const lines = [
    "",
    "=== SUMMARY ===",
    "Total new domains checked: " + fmt_(input.rows.length),
    "Unique new domains:        " + fmt_(results.uniqueNew),
    "NEW:                       " + fmt_(results.counts.new),
    "DUPLICATE (in folder):     " + fmt_(results.counts.duplicate),
    "DUPLICATE IN LIST:         " + fmt_(results.counts.duplicateInList),
    "Invalid values:            " + fmt_(results.counts.invalid),
    "Google Sheets scanned:     " + fmt_(index.filesScanned),
    "Tabs scanned:              " + fmt_(index.tabsScanned),
    "Existing domains indexed:  " + fmt_(index.map.size),
    "Errors:                    " + fmt_(index.errors.length),
    "Time:                      " + (elapsedMs / 1000).toFixed(1) + "s"
  ];
  if (index.errors.length > 0) {
    lines.push("", "Errors (skipped, the rest of the scan continued):");
    for (let i = 0; i < index.errors.length; i++) lines.push("  - " + index.errors[i]);
  }
  return lines.join("\n");
}


/**
 * Shows a toast when run from the spreadsheet UI; silent when run from a
 * trigger or the script editor.
 */
function notify_(title, message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) ss.toast(message.split("\n").slice(0, 8).join("\n"), title, 15);
  } catch (e) {
    // No UI available (time-based trigger) — the log already has everything.
  }
}


/** @return {string} 12345 -> "12,345" */
function fmt_(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}


/** @return {string} Joins a list, capping how many entries are shown. */
function joinCapped_(list, cap) {
  if (list.length <= cap) return list.join(", ");
  return list.slice(0, cap).join(", ") + " … (+" + (list.length - cap) + " more)";
}


/* ============================================================================
 *  OPTIONAL — automatic daily run
 * ==========================================================================*/

/**
 * Run this once to schedule checkNewDomains() every day at 8am.
 * Running it again replaces the existing schedule rather than stacking one up.
 */
function createDailyTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger("checkNewDomains").timeBased().atHour(8).everyDays(1).create();
  Logger.log("Daily trigger created — checkNewDomains() will run every day around 8am.");
}


/**
 * Removes every trigger this script created.
 */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkNewDomains") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  Logger.log("Existing checkNewDomains triggers removed.");
}
