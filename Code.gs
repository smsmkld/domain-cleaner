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
 *  Handles folders too large to scan in one go: set RESUMABLE to true and the
 *  script checkpoints its progress, schedules itself to continue a minute
 *  later, and keeps going until the whole folder is scanned. Results are only
 *  written once every spreadsheet has been read, so a half-finished scan can
 *  never mark an already-contacted domain as NEW.
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

  // Write a full report to its own tab in the NEW domains spreadsheet. The
  // report carries every column from your input sheet across, so any extra
  // data you keep beside the domains (company, contact, notes...) travels
  // with the verdict. Cleared and rewritten on every run.
  WRITE_RESULTS_SHEET: true,
  RESULTS_SHEET_NAME: "Results",

  // Also write status / found_in / duplicate_in_list columns directly to the
  // right of your input data, on the same rows. Re-used on later runs rather
  // than appended again. Set to false to leave your input tab untouched.
  WRITE_STATUS_NEXT_TO_INPUT: true,

  // Scan Google Sheets in sub-folders of FOLDER_ID as well.
  INCLUDE_SUBFOLDERS: false,

  // --- Big folders: automatic resume -------------------------------------
  // Google stops any single Apps Script run at about 6 minutes. With
  // RESUMABLE turned on, the script scans for RUN_BUDGET_MS, saves its place,
  // schedules itself to continue, and repeats until the folder is finished.
  // Leave it false if your folder scans comfortably in one run.
  RESUMABLE: false,

  // Scanning time per run. The remainder of the 6 minutes is left free for
  // saving the checkpoint and, on the final run, writing the results.
  RUN_BUDGET_MS: 4 * 60 * 1000,

  // How long to wait before the next run in the chain. 1 is the minimum.
  RESUME_DELAY_MINUTES: 1,

  // Safety stop: give up after this many runs in one chain rather than
  // scheduling triggers forever. 12 runs is roughly an hour of scanning.
  MAX_RESUME_RUNS: 12,

  // Abandon a checkpoint older than this and start fresh, so an interrupted
  // chain can never resume days later against stale data.
  CHECKPOINT_MAX_AGE_MS: 6 * 60 * 60 * 1000,

  // --- Tuning (safe to leave alone) --------------------------------------

  // Rows read per batch call. Lower this only if you hit memory errors.
  READ_CHUNK_ROWS: 20000,

  // Rows written per batch call.
  WRITE_CHUNK_ROWS: 5000,

  // Max spreadsheet names listed in the found_in cell before it is truncated.
  MAX_FOUND_IN_LISTED: 25
};


/* ============================================================================
 *  CONSTANTS
 * ==========================================================================*/

const STATUS = {
  DUPLICATE: "DUPLICATE",                 // already exists in the Drive folder
  DUPLICATE_IN_LIST: "DUPLICATE IN LIST", // not in the folder, repeated in the new list
  NEW: "NEW",                             // safe to contact
  INVALID: "INVALID"                      // cell held something that is not a domain
};

// PropertiesService keys used to track an in-progress scan.
const PROP_CHECKPOINT_FILE = "DOMAIN_CLEANER_CHECKPOINT_FILE_ID";
const PROP_RESUME_TRIGGER = "DOMAIN_CLEANER_RESUME_TRIGGER_ID";

const CHECKPOINT_FILE_NAME = "domain-cleaner-checkpoint.json";

// The columns this script adds. Kept in one place because they are both
// written and recognised again on the next run.
const STATUS_HEADERS = ["status", "found_in", "duplicate_in_list"];


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
    .addSeparator()
    .addItem("Cancel a running scan", "cancelRun")
    .addToUi();
}


/* ============================================================================
 *  MAIN
 * ==========================================================================*/

/**
 * Entry point. Safe to call from the menu, the editor, or a trigger.
 * A script lock keeps a scheduled run from colliding with a manual one.
 */
function checkNewDomains() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log("Another Domain Cleaner run is already in progress — skipping this one.");
    return;
  }
  try {
    runCheck_();
  } finally {
    lock.releaseLock();
  }
}


/**
 * One run of the check. Scans as much of the folder as fits in the time
 * budget; either finishes and writes results, or checkpoints and reschedules.
 */
function runCheck_() {
  const runStartedAt = Date.now();
  const deadline = runStartedAt + CONFIG.RUN_BUDGET_MS;

  const targetSs = openNewDomainsSpreadsheet_();
  const input = readNewDomains_(targetSs);

  if (input.rows.length === 0) {
    const msg = 'No domains found in column "' + input.headerName + '" of sheet "' +
                CONFIG.NEW_DOMAINS_SHEET_NAME + '".';
    Logger.log(msg);
    notify_("Domain Cleaner", msg);
    return;
  }

  const fingerprint = fingerprintNewDomains_(input.rows);
  const checkpoint = resolveCheckpoint_(fingerprint, targetSs.getId());

  if (checkpoint.chunk === 1) {
    Logger.log("=== Domain Cleaner started ===");
    Logger.log("Read " + fmt_(input.rows.length) + " non-empty domain cells from the new list.");
    Logger.log(fmt_(checkpoint.files.length) + " Google Sheets to scan.");
  } else {
    Logger.log("=== Domain Cleaner resuming (run " + checkpoint.chunk + " of at most " +
               CONFIG.MAX_RESUME_RUNS + ") ===");
    Logger.log("Resuming at spreadsheet " + (checkpoint.cursor + 1) + " of " +
               fmt_(checkpoint.files.length) + ".");
  }

  // Only the new domains need to be recognised, so the scan records matches
  // instead of every existing domain. Memory and the checkpoint stay small
  // no matter how many domains sit in the folder.
  const targets = new Set();
  for (let i = 0; i < input.rows.length; i++) {
    if (input.rows[i].domain) targets.add(input.rows[i].domain);
  }

  const matches = new Map(checkpoint.matches);
  const finished = scanFiles_(checkpoint, matches, targets, deadline);

  if (!finished) {
    checkpoint.matches = mapToPairs_(matches);
    saveCheckpoint_(checkpoint);
    scheduleResume_();
    const progress = "Paused after " + fmt_(checkpoint.cursor) + " of " +
                     fmt_(checkpoint.files.length) + " spreadsheets (" +
                     percent_(checkpoint.cursor, checkpoint.files.length) +
                     "). Continuing in " + CONFIG.RESUME_DELAY_MINUTES + " min.";
    Logger.log(progress);
    notify_("Domain Cleaner — still scanning", progress);
    return;
  }

  const results = compareAgainstMatches_(input.rows, matches, checkpoint.files);

  if (CONFIG.WRITE_RESULTS_SHEET) {
    writeResultsSheet_(targetSs, input, results.rows);
  }
  if (CONFIG.WRITE_STATUS_NEXT_TO_INPUT) {
    writeStatusNextToInput_(input, results.rows);
  }

  clearCheckpoint_();
  cancelResume_();

  const summary = buildSummary_(results, checkpoint, input, Date.now() - checkpoint.chainStartedAt);
  Logger.log(summary);
  notify_("Domain Cleaner — finished", summary);
}


/**
 * Clears any in-progress scan and cancels its scheduled continuation.
 * Does not touch a daily trigger created by createDailyTrigger().
 */
function cancelRun() {
  cancelResume_();
  clearCheckpoint_();
  const msg = "Any in-progress scan has been cancelled. The next run starts from scratch.";
  Logger.log(msg);
  notify_("Domain Cleaner", msg);
}


/* ============================================================================
 *  SCANNING
 * ==========================================================================*/

/**
 * Scans spreadsheets from the checkpoint cursor onwards until the folder is
 * finished or the deadline is reached.
 *
 * A spreadsheet's matches are merged only once it has been read completely,
 * so a run that stops early never leaves half a spreadsheet recorded.
 *
 * @param {!Object} checkpoint Mutated: cursor and stats advance as files finish.
 * @param {!Map<string, string>} matches domain -> "0,3,7" indexes into checkpoint.files.
 * @param {!Set<string>} targets Normalized domains we are looking for.
 * @param {number} deadline Timestamp to stop scanning at.
 * @return {boolean} True if every spreadsheet has now been scanned.
 */
function scanFiles_(checkpoint, matches, targets, deadline) {
  while (checkpoint.cursor < checkpoint.files.length) {

    if (Date.now() >= deadline) {
      if (!CONFIG.RESUMABLE) {
        throw new Error(
          "Stopped after " + Math.round(CONFIG.RUN_BUDGET_MS / 1000) + "s having scanned " +
          checkpoint.cursor + " of " + checkpoint.files.length + " spreadsheets. Google stops " +
          "any run at about 6 minutes, and a partial scan would wrongly mark already-contacted " +
          'domains as NEW. Set RESUMABLE: true in CONFIG to have the script save its place and ' +
          "continue automatically, or split the folder and run the check once per folder."
        );
      }
      return false; // checkpoint and resume
    }

    const file = checkpoint.files[checkpoint.cursor];
    const fileMatches = new Map();
    let domainsSeen = 0;
    let tabsSeen = 0;

    try {
      Logger.log("Scanning spreadsheet: " + file.name);
      const sheets = SpreadsheetApp.openById(file.id).getSheets();

      for (let s = 0; s < sheets.length; s++) {
        tabsSeen++;
        try {
          domainsSeen += readDomainColumns_(sheets[s], function (domain) {
            if (targets.has(domain)) fileMatches.set(domain, true);
          });
        } catch (tabErr) {
          const msg = file.name + ' → tab "' + sheets[s].getName() + '": ' + tabErr.message;
          checkpoint.errors.push(msg);
          Logger.log("  ERROR " + msg);
        }
      }

      Logger.log("  Found " + fmt_(domainsSeen) + " domains, " +
                 fmt_(fileMatches.size) + " of them on your new list");

    } catch (err) {
      const msg = file.name + ": " + err.message;
      checkpoint.errors.push(msg);
      Logger.log("  ERROR — could not open " + msg + " (continuing)");
    }

    // The spreadsheet is done: fold its matches in and advance past it.
    const sourceIdx = String(checkpoint.cursor);
    const matchedDomains = Array.from(fileMatches.keys());
    for (let m = 0; m < matchedDomains.length; m++) {
      addSource_(matches, matchedDomains[m], sourceIdx);
    }
    checkpoint.domainsScanned += domainsSeen;
    checkpoint.tabsScanned += tabsSeen;
    checkpoint.cursor++;
  }

  Logger.log("Finished. " + fmt_(checkpoint.files.length) + " spreadsheets scanned, " +
             fmt_(checkpoint.tabsScanned) + " tabs, " + fmt_(checkpoint.domainsScanned) +
             " domain cells read.");
  return true;
}


/**
 * Reads every domain column of a tab and streams normalized values to a
 * callback. Reads in batches, never cell by cell.
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
 * @param {!Map<string, string>} matches
 * @param {string} domain Already normalized.
 * @param {string} sourceIdx
 */
function addSource_(matches, domain, sourceIdx) {
  const existing = matches.get(domain);
  if (existing === undefined) {
    matches.set(domain, sourceIdx);
    return;
  }
  if (existing.split(",").indexOf(sourceIdx) === -1) {
    matches.set(domain, existing + "," + sourceIdx);
  }
}


/**
 * Lists every Google Sheet in the folder, once, so the scan works from a
 * stable file list even when it spans several runs.
 *
 * @param {string} folderId
 * @param {string} skipSpreadsheetId Excluded so the new list cannot match itself.
 * @return {!Array<{id: string, name: string}>}
 */
function listSpreadsheets_(folderId, skipSpreadsheetId) {
  if (!folderId || folderId === "PASTE_FOLDER_ID_HERE") {
    throw new Error("CONFIG.FOLDER_ID is not set. Open the script and paste your Drive folder ID.");
  }

  let rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(folderId);
  } catch (e) {
    throw new Error('Could not open the Drive folder "' + folderId + '". ' +
                    "Check the ID and make sure your account has access. (" + e.message + ")");
  }

  Logger.log('Listing Google Sheets in folder: "' + rootFolder.getName() + '"' +
             (CONFIG.INCLUDE_SUBFOLDERS ? " (including sub-folders)" : ""));

  const out = [];
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
      out.push({ id: file.getId(), name: file.getName() });
    }

    if (CONFIG.INCLUDE_SUBFOLDERS) {
      const subFolders = folder.getFolders();
      while (subFolders.hasNext()) folders.push(subFolders.next());
    }
  }

  if (out.length === 0) {
    throw new Error('No Google Sheets found in folder "' + rootFolder.getName() +
                    '". Check CONFIG.FOLDER_ID' +
                    (CONFIG.INCLUDE_SUBFOLDERS ? "." : ", or set INCLUDE_SUBFOLDERS: true."));
  }
  return out;
}


/* ============================================================================
 *  CHECKPOINTS — surviving the 6 minute limit
 * ==========================================================================*/

/**
 * Returns the checkpoint to work from: a saved one when a chain is genuinely
 * in progress, otherwise a fresh one.
 *
 * A saved checkpoint is discarded when the new domain list has changed under
 * it, or when it is too old to trust. Both would otherwise produce a result
 * built partly from a scan of a different question.
 *
 * @param {string} fingerprint Of the current new-domain list.
 * @param {string} skipSpreadsheetId
 * @return {!Object}
 */
function resolveCheckpoint_(fingerprint, skipSpreadsheetId) {
  const saved = CONFIG.RESUMABLE ? loadCheckpoint_() : null;

  if (saved) {
    if (saved.fingerprint !== fingerprint) {
      Logger.log("The new-domain list changed since the last run — discarding the saved " +
                 "progress and starting a fresh scan.");
      clearCheckpoint_();
    } else if (Date.now() - saved.chainStartedAt > CONFIG.CHECKPOINT_MAX_AGE_MS) {
      Logger.log("Saved progress is older than " +
                 Math.round(CONFIG.CHECKPOINT_MAX_AGE_MS / 3600000) +
                 "h — discarding it and starting a fresh scan.");
      clearCheckpoint_();
    } else if (saved.chunk >= CONFIG.MAX_RESUME_RUNS) {
      clearCheckpoint_();
      cancelResume_();
      throw new Error(
        "Gave up after " + CONFIG.MAX_RESUME_RUNS + " runs with " +
        (saved.files.length - saved.cursor) + " of " + saved.files.length +
        " spreadsheets still unscanned. Raise CONFIG.MAX_RESUME_RUNS, or split the folder."
      );
    } else {
      saved.chunk++;
      return saved;
    }
  }

  return {
    chunk: 1,
    chainStartedAt: Date.now(),
    fingerprint: fingerprint,
    files: listSpreadsheets_(CONFIG.FOLDER_ID, skipSpreadsheetId),
    cursor: 0,
    matches: [],
    errors: [],
    tabsScanned: 0,
    domainsScanned: 0
  };
}


/**
 * @return {?Object} The saved checkpoint, or null if there is none.
 */
function loadCheckpoint_() {
  const fileId = PropertiesService.getScriptProperties().getProperty(PROP_CHECKPOINT_FILE);
  if (!fileId) return null;
  try {
    return JSON.parse(DriveApp.getFileById(fileId).getBlob().getDataAsString());
  } catch (e) {
    Logger.log("Could not read the saved progress (" + e.message + ") — starting fresh.");
    clearCheckpoint_();
    return null;
  }
}


/**
 * Writes the checkpoint to a small JSON file in Drive. Script Properties cap
 * out at 9KB per value, which the match list can exceed, so the file holds the
 * data and Properties just remembers its ID.
 *
 * @param {!Object} checkpoint
 */
function saveCheckpoint_(checkpoint) {
  const props = PropertiesService.getScriptProperties();
  const json = JSON.stringify(checkpoint);
  const existingId = props.getProperty(PROP_CHECKPOINT_FILE);

  if (existingId) {
    try {
      DriveApp.getFileById(existingId).setContent(json);
      return;
    } catch (e) {
      Logger.log("Could not update the progress file (" + e.message + ") — creating a new one.");
    }
  }
  const file = DriveApp.createFile(CHECKPOINT_FILE_NAME, json, MimeType.PLAIN_TEXT);
  props.setProperty(PROP_CHECKPOINT_FILE, file.getId());
}


/**
 * Deletes the checkpoint file and forgets it.
 */
function clearCheckpoint_() {
  const props = PropertiesService.getScriptProperties();
  const fileId = props.getProperty(PROP_CHECKPOINT_FILE);
  if (fileId) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {
      Logger.log("Could not remove the progress file (" + e.message + ").");
    }
  }
  props.deleteProperty(PROP_CHECKPOINT_FILE);
}


/**
 * Schedules the next run in the chain, replacing any earlier one.
 */
function scheduleResume_() {
  cancelResume_();
  const trigger = ScriptApp.newTrigger("checkNewDomains")
    .timeBased()
    .after(Math.max(1, CONFIG.RESUME_DELAY_MINUTES) * 60 * 1000)
    .create();
  PropertiesService.getScriptProperties().setProperty(PROP_RESUME_TRIGGER, trigger.getUniqueId());
}


/**
 * Cancels a pending continuation. Matches on the stored trigger ID so a daily
 * trigger for the same function is never removed by accident.
 */
function cancelResume_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_RESUME_TRIGGER);
  if (!id) return;

  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === id) {
      ScriptApp.deleteTrigger(triggers[i]);
      break;
    }
  }
  props.deleteProperty(PROP_RESUME_TRIGGER);
}


/**
 * A cheap signature of the new-domain list, used to notice that the list was
 * edited part-way through a multi-run scan.
 *
 * @param {!Array<!Object>} rows
 * @return {string}
 */
function fingerprintNewDomains_(rows) {
  let hash = 5381;
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].domain;
    for (let c = 0; c < d.length; c++) {
      hash = ((hash * 33) ^ d.charCodeAt(c)) | 0; // djb2, kept in int32
    }
  }
  return rows.length + ":" + (hash >>> 0).toString(36);
}


/** @return {!Array<!Array<string>>} A Map as [key, value] pairs for JSON. */
function mapToPairs_(map) {
  const out = [];
  map.forEach(function (value, key) { out.push([key, value]); });
  return out;
}


/* ============================================================================
 *  READING THE NEW DOMAIN LIST
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
    throw new Error('Could not open the new-domains spreadsheet "' + id + '". (' + e.message + ")");
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
    throw new Error("No column named " + CONFIG.DOMAIN_HEADERS.join(" or ") + ' was found in row 1 of "' +
                    sheet.getName() + '". Add a header cell named "' + CONFIG.DOMAIN_HEADERS[0] + '".');
  }
  if (columns.length > 1) {
    Logger.log("Note: the new-domains sheet has " + columns.length +
               " domain columns. Using the first one (column " + (columns[0] + 1) + ").");
  }

  const col = columns[0];
  const dataRows = lastRow - 1;
  const rows = [];

  // The report copies your other columns across, so read the whole row when
  // it is going to be written; otherwise read just the domain column.
  const wide = CONFIG.WRITE_RESULTS_SHEET;
  const readFrom = wide ? 1 : col + 1;
  const readWidth = wide ? lastCol : 1;
  const domainAt = wide ? col : 0;

  for (let offset = 0; offset < dataRows; offset += CONFIG.READ_CHUNK_ROWS) {
    const numRows = Math.min(CONFIG.READ_CHUNK_ROWS, dataRows - offset);
    const values = sheet.getRange(2 + offset, readFrom, numRows, readWidth).getValues();
    for (let r = 0; r < values.length; r++) {
      const cell = values[r][domainAt];
      const raw = String(cell === null || cell === undefined ? "" : cell).trim();
      if (!raw) continue; // blank cell / blank row
      rows.push({
        row: 2 + offset + r,
        raw: raw,
        domain: normalizeDomain_(raw),
        cells: wide ? values[r] : null
      });
    }
  }

  return {
    rows: rows,
    sheet: sheet,
    column: col + 1,
    headerName: String(headers[col]).trim(),
    headers: headers,
    lastColumn: lastCol,
    statusBlockAt: findStatusBlock_(headers)
  };
}


/**
 * Finds the status / found_in / duplicate_in_list block this script wrote on a
 * previous run, so those columns are overwritten instead of a fresh set being
 * appended every time the check runs.
 *
 * @param {!Array<*>} headerRow
 * @return {number} 0-based column of "status", or -1 if the block is not there.
 */
function findStatusBlock_(headerRow) {
  for (let i = 0; i + STATUS_HEADERS.length <= headerRow.length; i++) {
    let hit = true;
    for (let j = 0; j < STATUS_HEADERS.length; j++) {
      const h = headerRow[i + j];
      if (String(h === null || h === undefined ? "" : h).trim().toLowerCase() !== STATUS_HEADERS[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}


/* ============================================================================
 *  COMPARING
 * ==========================================================================*/

/**
 * Turns the scan's matches into one result row per new domain, and flags
 * domains that repeat inside the new list itself.
 *
 * @param {!Array<!Object>} newRows
 * @param {!Map<string, string>} matches
 * @param {!Array<{name: string}>} files
 * @return {{rows: !Array<!Array<*>>, counts: !Object, uniqueNew: number}}
 */
function compareAgainstMatches_(newRows, matches, files) {
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
      const sources = matches.get(item.domain);
      const repeats = occurrences.get(item.domain);
      const isRepeat = repeats.length > 1;

      if (isRepeat) {
        inList = "YES — rows " + joinCapped_(repeats, CONFIG.MAX_FOUND_IN_LISTED);
      }

      if (sources !== undefined) {
        status = STATUS.DUPLICATE;
        foundIn = resolveSourceNames_(sources, files);
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
 * @param {!Array<{name: string}>} files
 * @return {string}
 */
function resolveSourceNames_(sources, files) {
  const idxs = sources.split(",");
  const names = [];
  for (let i = 0; i < idxs.length && i < CONFIG.MAX_FOUND_IN_LISTED; i++) {
    names.push(files[Number(idxs[i])].name);
  }
  let out = names.join(", ");
  if (idxs.length > CONFIG.MAX_FOUND_IN_LISTED) {
    out += " … (+" + (idxs.length - CONFIG.MAX_FOUND_IN_LISTED) + " more)";
  }
  return out;
}


/* ============================================================================
 *  NORMALIZING
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
 *  WRITING RESULTS
 * ==========================================================================*/

/**
 * Rewrites the results tab: every column from your input sheet, in its
 * original order, followed by the verdict. Extra columns you keep beside the
 * domains — company, contact, notes — come across untouched.
 *
 * Status columns left in the input by an earlier run are not copied, so the
 * report does not accumulate a stale verdict beside the current one.
 *
 * @param {!Spreadsheet} ss
 * @param {!Object} input Result of readNewDomains_.
 * @param {!Array<!Array<*>>} rows Result rows, [sourceRow, raw, norm, status, foundIn, inList].
 */
function writeResultsSheet_(ss, input, rows) {
  let sheet = ss.getSheetByName(CONFIG.RESULTS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.RESULTS_SHEET_NAME);
  sheet.clear();

  // Which input columns to carry over: all of them, minus a previous verdict.
  const carried = [];
  for (let c = 0; c < input.headers.length; c++) {
    const inOldBlock = input.statusBlockAt !== -1 &&
                       c >= input.statusBlockAt &&
                       c < input.statusBlockAt + STATUS_HEADERS.length;
    if (!inOldBlock) carried.push(c);
  }

  const headers = carried.map(function (c) {
    const h = String(input.headers[c] === null || input.headers[c] === undefined ? "" : input.headers[c]).trim();
    return h || "column_" + (c + 1);
  }).concat(["normalized_domain"], STATUS_HEADERS, ["source_row"]);

  const grid = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = input.rows[i].cells;
    const out = [];
    for (let c = 0; c < carried.length; c++) {
      const v = cells[carried[c]];
      out.push(v === null || v === undefined ? "" : v);
    }
    grid.push(out.concat([rows[i][2], rows[i][3], rows[i][4], rows[i][5], rows[i][0]]));
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
  sheet.setFrozenRows(1);

  for (let offset = 0; offset < grid.length; offset += CONFIG.WRITE_CHUNK_ROWS) {
    const chunk = grid.slice(offset, offset + CONFIG.WRITE_CHUNK_ROWS);
    sheet.getRange(2 + offset, 1, chunk.length, headers.length).setValues(chunk);
  }

  sheet.autoResizeColumns(1, headers.length);
  Logger.log("Results written to the \"" + CONFIG.RESULTS_SHEET_NAME + '" tab (' +
             carried.length + " of your columns carried across).");
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
  const lastRow = sheet.getLastRow();

  // Overwrite the block from a previous run if it is there; only append when
  // there is none, so repeated runs cannot pile up column after column.
  const firstCol = input.statusBlockAt !== -1 ? input.statusBlockAt + 1 : input.lastColumn + 1;

  // Blank grid so rows with empty domain cells stay empty.
  const grid = [];
  for (let r = 0; r < lastRow - 1; r++) grid.push(["", "", ""]);
  for (let i = 0; i < rows.length; i++) {
    grid[rows[i][0] - 2] = [rows[i][3], rows[i][4], rows[i][5]];
  }

  sheet.getRange(1, firstCol, 1, STATUS_HEADERS.length).setValues([STATUS_HEADERS]).setFontWeight("bold");
  for (let offset = 0; offset < grid.length; offset += CONFIG.WRITE_CHUNK_ROWS) {
    const chunk = grid.slice(offset, offset + CONFIG.WRITE_CHUNK_ROWS);
    sheet.getRange(2 + offset, firstCol, chunk.length, STATUS_HEADERS.length).setValues(chunk);
  }
  Logger.log("Status columns " + (input.statusBlockAt !== -1 ? "updated" : "added") +
             " next to the input data (columns " + firstCol + "\u2013" +
             (firstCol + STATUS_HEADERS.length - 1) + ").");
}


/* ============================================================================
 *  SUMMARY + HELPERS
 * ==========================================================================*/

/**
 * @return {string} A human readable run summary.
 */
function buildSummary_(results, checkpoint, input, elapsedMs) {
  const lines = [
    "",
    "=== SUMMARY ===",
    "Total new domains checked: " + fmt_(input.rows.length),
    "Unique new domains:        " + fmt_(results.uniqueNew),
    "NEW:                       " + fmt_(results.counts.new),
    "DUPLICATE (in folder):     " + fmt_(results.counts.duplicate),
    "DUPLICATE IN LIST:         " + fmt_(results.counts.duplicateInList),
    "Invalid values:            " + fmt_(results.counts.invalid),
    "Google Sheets scanned:     " + fmt_(checkpoint.files.length),
    "Tabs scanned:              " + fmt_(checkpoint.tabsScanned),
    "Existing domains read:     " + fmt_(checkpoint.domainsScanned),
    "Errors:                    " + fmt_(checkpoint.errors.length),
    "Runs used:                 " + checkpoint.chunk,
    "Time:                      " + (elapsedMs / 1000).toFixed(1) + "s"
  ];
  if (checkpoint.errors.length > 0) {
    lines.push("", "Errors (skipped, the rest of the scan continued):");
    for (let i = 0; i < checkpoint.errors.length; i++) lines.push("  - " + checkpoint.errors[i]);
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


/** @return {string} 3 of 4 -> "75%" */
function percent_(done, total) {
  if (!total) return "0%";
  return Math.floor((done / total) * 100) + "%";
}


/* ============================================================================
 *  OPTIONAL — automatic nightly run
 * ==========================================================================*/

/**
 * Run this once to schedule checkNewDomains() every night at 2am.
 * Running it again replaces the existing schedule rather than stacking one up.
 *
 * With RESUMABLE turned on, a scan too big for one run continues itself
 * through the night until the whole folder is done.
 */
function createNightlyTrigger() {
  deleteTriggers();
  ScriptApp.newTrigger("checkNewDomains").timeBased().atHour(2).everyDays(1).create();
  Logger.log("Nightly trigger created — checkNewDomains() will run every day around 2am.");
}


/**
 * Removes every schedule this script created, including any pending
 * continuation, and clears an in-progress scan.
 */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkNewDomains") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  PropertiesService.getScriptProperties().deleteProperty(PROP_RESUME_TRIGGER);
  Logger.log("All Domain Cleaner schedules removed.");
}
