import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  Globe,
  Loader2,
  Play,
  Trash2,
  X,
} from "lucide-react";

export const GOOGLE_APPS_SCRIPT_SNIPPET = `function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function resolveSpreadsheet_(reqId) {
  var id = reqId ? String(reqId).trim() : "";
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function readSheetSummary_(ss, datasetName, limitParam) {
  var sheet = ss.getSheetByName(datasetName);
  if (!sheet) {
    return {
      exists: false,
      dataset: datasetName,
      columns: [],
      rowCount: 0,
      duplicateIds: 0,
      rows: []
    };
  }
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return {
      exists: true,
      dataset: datasetName,
      columns: [],
      rowCount: 0,
      duplicateIds: 0,
      rows: []
    };
  }
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var columns = values[0] ? values[0].map(function(c) { return String(c == null ? "" : c); }) : [];
  var seen = {};
  var dupCount = 0;
  for (var i = 1; i < values.length; i++) {
    var id = String(values[i][0] == null ? "" : values[i][0]).trim();
    if (!id) continue;
    if (seen[id]) {
      dupCount += 1;
    } else {
      seen[id] = true;
    }
  }
  var maxRows = Math.max(0, Math.min(200, Number(limitParam || 25) || 25));
  var sampleRows = [];
  for (var r = 1; r < values.length && sampleRows.length < maxRows; r++) {
    sampleRows.push(values[r].map(function(cell) {
      if (cell instanceof Date) return cell.toISOString();
      return cell == null ? "" : cell;
    }));
  }
  return {
    exists: true,
    dataset: datasetName,
    columns: columns,
    rowCount: Math.max(0, values.length - 1),
    duplicateIds: dupCount,
    rows: sampleRows
  };
}

function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var ss = resolveSpreadsheet_(params.spreadsheetId);
    if (!ss) {
      return jsonOutput_({
        status: "error",
        ok: false,
        success: false,
        error: "No active spreadsheet bound. Open this Apps Script from Extensions -> Apps Script inside a Google Sheet or pass spreadsheetId."
      });
    }
    var action = params.action ? String(params.action).trim().toLowerCase() : "status";
    var tabOrder = [
      "Startups",
      "Products",
      "Research Papers",
      "Jobs",
      "News",
      "Entity Mapping Log"
    ];
    if (action === "read" && params.dataset) {
      var datasetName = String(params.dataset).trim();
      var summary = readSheetSummary_(ss, datasetName, params.limit);
      return jsonOutput_({
        status: "ok",
        ok: true,
        success: true,
        message: summary.exists ? "Read completed" : "Worksheet not found",
        action: "read",
        dataset: datasetName,
        exists: summary.exists,
        columns: summary.columns,
        rowCount: summary.rowCount,
        duplicateIds: summary.duplicateIds,
        rows: summary.rows,
        spreadsheetId: ss.getId(),
        spreadsheetUrl: ss.getUrl()
      });
    }
    var tabRowCounts = {};
    tabOrder.forEach(function(tabName) {
      var sh = ss.getSheetByName(tabName);
      tabRowCounts[tabName] = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
    });
    return jsonOutput_({
      status: "ok",
      ok: true,
      success: true,
      message: "Apps Script Web App verified",
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      tabs: tabOrder,
      tabRowCounts: tabRowCounts
    });
  } catch (err) {
    return jsonOutput_({
      status: "error",
      ok: false,
      success: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function normalizeTabData_(rawTab) {
  if (!rawTab) return { columns: [], rows: [] };
  if (Array.isArray(rawTab)) {
    if (rawTab.length === 0) return { columns: [], rows: [] };
    if (Array.isArray(rawTab[0])) {
      return { columns: rawTab[0], rows: rawTab.slice(1) };
    }
    if (typeof rawTab[0] === "object" && rawTab[0] !== null) {
      var cols = Object.keys(rawTab[0]);
      var objRows = rawTab.map(function(obj) {
        return cols.map(function(c) { return obj[c] == null ? "" : obj[c]; });
      });
      return { columns: cols, rows: objRows };
    }
    return { columns: [], rows: [] };
  }
  if (typeof rawTab === "object") {
    return {
      columns: Array.isArray(rawTab.columns) ? rawTab.columns : [],
      rows: Array.isArray(rawTab.rows) ? rawTab.rows : []
    };
  }
  return { columns: [], rows: [] };
}

function formatCellValue_(val) {
  if (val == null) return "";
  if (val instanceof Date) return val.toISOString();
  return val;
}

function normalizeRowValues_(row, colCount) {
  var out = [];
  for (var c = 0; c < colCount; c++) {
    out.push(formatCellValue_(c < row.length ? row[c] : ""));
  }
  return out;
}

function writeValuesInChunks_(sheet, startRow, rows, colCount) {
  var chunkSize = 1500;
  for (var offset = 0; offset < rows.length; offset += chunkSize) {
    var chunk = rows.slice(offset, offset + chunkSize).map(function(r) {
      return normalizeRowValues_(r, colCount);
    });
    sheet.getRange(startRow + offset, 1, chunk.length, colCount).setValues(chunk);
  }
}

function syncSingleSheet_(ss, tab, mode, batchIndex, preserveExisting) {
  var sheet = ss.getSheetByName(tab.tabName) || ss.insertSheet(tab.tabName);
  var columns = tab.columns || [];
  var rows = tab.rows || [];
  if (!columns.length) {
    return {
      tabName: tab.tabName,
      status: "failed",
      rowsWritten: 0,
      rowsAdded: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      verifiedRows: 0,
      error: "Missing column headers for " + tab.tabName
    };
  }

  var rowsAdded = 0;
  var rowsUpdated = 0;
  var rowsUnchanged = 0;

  var shouldFullReplace = mode === "full" && !preserveExisting && Number(batchIndex || 0) === 0;
  var lastExistingRow = sheet.getLastRow();

  if (shouldFullReplace || lastExistingRow === 0) {
    sheet.clearContents();
    var dedupedMap = {};
    var dedupedRows = [];
    rows.forEach(function(r) {
      var norm = normalizeRowValues_(r, columns.length);
      var id = String(norm[0] || "").trim();
      if (!id || dedupedMap[id]) return;
      dedupedMap[id] = true;
      dedupedRows.push(norm);
    });
    var allValues = [columns].concat(dedupedRows);
    writeValuesInChunks_(sheet, 1, allValues, columns.length);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, columns.length).setFontWeight("bold");
    rowsAdded += dedupedRows.length;
  } else {
    var lastCol = Math.max(columns.length, sheet.getLastColumn() || columns.length);
    var existing = sheet.getRange(1, 1, lastExistingRow, lastCol).getValues();
    var headerMatches = existing.length > 0 &&
      String(existing[0][0] || "") === String(columns[0] || "") &&
      existing[0].length >= columns.length;

    var existingById = {};
    var hasDuplicatesInSheet = false;
    var preservedUniqueRows = [];
    for (var i = 1; i < existing.length; i++) {
      var idVal = String(existing[i][0] == null ? "" : existing[i][0]).trim();
      if (!idVal) continue;
      if (existingById[idVal]) {
        hasDuplicatesInSheet = true;
        continue;
      }
      var normExisting = normalizeRowValues_(existing[i], columns.length);
      existingById[idVal] = {
        rowNum: i + 1,
        idx: preservedUniqueRows.length,
        cells: normExisting
      };
      preservedUniqueRows.push(normExisting);
    }

    if (hasDuplicatesInSheet || !headerMatches) {
      var incomingById = {};
      rows.forEach(function(r) {
        var norm = normalizeRowValues_(r, columns.length);
        var id = String(norm[0] || "").trim();
        if (id) incomingById[id] = norm;
      });
      var mergedRows = [];
      var seenMerged = {};
      preservedUniqueRows.forEach(function(prevRow) {
        var id = String(prevRow[0] || "").trim();
        if (!id || seenMerged[id]) return;
        seenMerged[id] = true;
        if (incomingById[id]) {
          var nextRow = incomingById[id];
          var changed = false;
          for (var c = 0; c < columns.length; c++) {
            if (String(nextRow[c]) !== String(prevRow[c])) {
              changed = true;
              break;
            }
          }
          if (changed) rowsUpdated += 1;
          else rowsUnchanged += 1;
          mergedRows.push(nextRow);
        } else {
          mergedRows.push(prevRow);
        }
      });
      rows.forEach(function(r) {
        var norm = normalizeRowValues_(r, columns.length);
        var id = String(norm[0] || "").trim();
        if (!id || seenMerged[id]) return;
        seenMerged[id] = true;
        mergedRows.push(norm);
        rowsAdded += 1;
      });
      sheet.clearContents();
      writeValuesInChunks_(sheet, 1, [columns].concat(mergedRows), columns.length);
    } else {
      var toAppend = [];
      var seenIncoming = {};
      rows.forEach(function(r) {
        var norm = normalizeRowValues_(r, columns.length);
        var id = String(norm[0] || "").trim();
        if (!id || seenIncoming[id]) return;
        seenIncoming[id] = true;
        var found = existingById[id];
        if (found) {
          var changed = false;
          for (var c = 0; c < columns.length; c++) {
            if (String(norm[c]) !== String(found.cells[c])) {
              changed = true;
              break;
            }
          }
          if (changed) {
            sheet.getRange(found.rowNum, 1, 1, columns.length).setValues([norm]);
            rowsUpdated += 1;
          } else {
            rowsUnchanged += 1;
          }
        } else {
          toAppend.push(norm);
        }
      });
      if (toAppend.length > 0) {
        var startRow = Math.max(2, sheet.getLastRow() + 1);
        writeValuesInChunks_(sheet, startRow, toAppend, columns.length);
        rowsAdded += toAppend.length;
      }
    }
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, columns.length).setFontWeight("bold");
  }

  var verifiedRows = Math.max(0, sheet.getLastRow() - 1);
  return {
    tabName: tab.tabName,
    status: "success",
    rowsWritten: rows.length,
    rowsAdded: rowsAdded,
    rowsUpdated: rowsUpdated,
    rowsUnchanged: rowsUnchanged,
    verifiedRows: verifiedRows,
    error: null
  };
}

function doPost(e) {
  try {
    var rawBody = (e && e.postData && typeof e.postData.contents === "string" && e.postData.contents.trim())
      ? e.postData.contents
      : "{}";
    var payload = JSON.parse(rawBody);
    var ss = resolveSpreadsheet_(payload && payload.spreadsheetId);
    if (!ss) {
      return jsonOutput_({
        status: "error",
        ok: false,
        success: false,
        error: "No active spreadsheet bound. Create this script via Extensions -> Apps Script inside a Google Sheet or pass spreadsheetId."
      });
    }
    var mode = payload && payload.mode === "incremental" ? "incremental" : "full";
    var batchIndex = payload && typeof payload.batchIndex === "number" ? payload.batchIndex : 0;
    var preserveExisting = Boolean(payload && payload.preserveExisting) || mode === "incremental" || batchIndex > 0;
    var tabOrder = [
      "Startups",
      "Products",
      "Research Papers",
      "Jobs",
      "News",
      "Entity Mapping Log"
    ];

    var entries = [];
    if (payload && typeof payload.dataset === "string" && payload.dataset.trim()) {
      entries.push({
        tabName: payload.dataset.trim(),
        columns: Array.isArray(payload.columns) ? payload.columns : [],
        rows: Array.isArray(payload.rows) ? payload.rows : []
      });
    } else if (payload && payload.datasets && typeof payload.datasets === "object") {
      tabOrder.forEach(function(tabName) {
        if (payload.datasets[tabName]) {
          var parsedTab = normalizeTabData_(payload.datasets[tabName]);
          entries.push({ tabName: tabName, columns: parsedTab.columns, rows: parsedTab.rows });
        }
      });
      Object.keys(payload.datasets).forEach(function(tabName) {
        if (tabOrder.indexOf(tabName) === -1) {
          var parsedExtra = normalizeTabData_(payload.datasets[tabName]);
          entries.push({ tabName: tabName, columns: parsedExtra.columns, rows: parsedExtra.rows });
        }
      });
    } else if (payload && Array.isArray(payload.tabs)) {
      entries = payload.tabs;
    }

    if (!entries.length) {
      return jsonOutput_({
        status: "error",
        ok: false,
        success: false,
        error: "No dataset or datasets payload provided."
      });
    }

    var tabRowCounts = {};
    var tabStatuses = {};
    var rowsWritten = 0;
    var rowsAdded = 0;
    var rowsUpdated = 0;
    var rowsUnchanged = 0;
    var failedTabs = [];

    entries.forEach(function(tab) {
      try {
        var resTab = syncSingleSheet_(ss, tab, mode, batchIndex, preserveExisting);
        tabRowCounts[tab.tabName] = resTab.verifiedRows;
        tabStatuses[tab.tabName] = resTab;
        rowsWritten += resTab.rowsWritten;
        rowsAdded += resTab.rowsAdded;
        rowsUpdated += resTab.rowsUpdated;
        rowsUnchanged += resTab.rowsUnchanged;
        if (resTab.status !== "success") {
          failedTabs.push(tab.tabName);
        }
      } catch (tabErr) {
        var errMsg = tabErr && tabErr.message ? tabErr.message : String(tabErr);
        tabStatuses[tab.tabName] = {
          tabName: tab.tabName,
          status: "failed",
          rowsWritten: 0,
          rowsAdded: 0,
          rowsUpdated: 0,
          rowsUnchanged: 0,
          verifiedRows: 0,
          error: errMsg
        };
        failedTabs.push(tab.tabName);
      }
    });

    var defaultSheet = ss.getSheetByName("Sheet1");
    if (defaultSheet && ss.getSheets().length > 1 && defaultSheet.getLastRow() <= 1) {
      ss.deleteSheet(defaultSheet);
    }

    var publicViewerVerified = false;
    var publicAccessError = null;
    try {
      DriveApp.getFileById(ss.getId()).setSharing(
        DriveApp.Access.ANYONE_WITH_LINK,
        DriveApp.Permission.VIEW
      );
      publicViewerVerified = true;
    } catch (shareErr) {
      publicAccessError = shareErr && shareErr.message ? shareErr.message : String(shareErr);
    }

    var allOk = failedTabs.length === 0;
    var singleDatasetName = entries.length === 1 ? entries[0].tabName : undefined;
    var singleVerified = singleDatasetName ? (tabRowCounts[singleDatasetName] || 0) : undefined;

    return jsonOutput_({
      status: allOk ? "ok" : "error",
      ok: allOk,
      success: allOk,
      message: allOk ? "Sync completed" : ("Failed tabs: " + failedTabs.join(", ")),
      dataset: singleDatasetName,
      rowsWritten: rowsWritten,
      verifiedRows: singleVerified,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      tabRowCounts: tabRowCounts,
      tabStatuses: tabStatuses,
      rowsAdded: rowsAdded,
      rowsUpdated: rowsUpdated,
      rowsUnchanged: rowsUnchanged,
      publicViewerVerified: publicViewerVerified,
      publicAccessError: publicAccessError,
      error: allOk ? null : ("Worksheet sync failed for: " + failedTabs.join(", "))
    });
  } catch (err) {
    return jsonOutput_({
      status: "error",
      ok: false,
      success: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}`;

interface AppsScriptSetupModalProps {
  open: boolean;
  webhookUrlInput: string;
  onWebhookUrlInputChange: (value: string) => void;
  savedWebhookUrl: string | null | undefined;
  spreadsheetUrl: string | null | undefined;
  totalRowsCount: number;
  savingWebhookUrl: boolean;
  syncingNow: boolean;
  errorMessage: string | null;
  onClose: () => void;
  onSaveOnly: () => Promise<boolean>;
  onSaveAndSyncNow: () => Promise<boolean>;
  onRemoveWebhookUrl: () => void;
}

export function AppsScriptSetupModal({
  open,
  webhookUrlInput,
  onWebhookUrlInputChange,
  savedWebhookUrl,
  spreadsheetUrl,
  totalRowsCount,
  savingWebhookUrl,
  syncingNow,
  errorMessage,
  onClose,
  onSaveOnly,
  onSaveAndSyncNow,
  onRemoveWebhookUrl,
}: AppsScriptSetupModalProps) {
  const [copiedScript, setCopiedScript] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !savingWebhookUrl && !syncingNow) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, savingWebhookUrl, syncingNow, onClose]);

  if (!open) return null;

  const busy = savingWebhookUrl || syncingNow;
  const hasInput = webhookUrlInput.trim().length > 0;

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_SNIPPET);
      setCopiedScript(true);
      window.setTimeout(() => setCopiedScript(false), 2500);
    } catch {
      setShowCode(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-xl bg-[#0E172B] border border-slate-800 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-sky-400 shrink-0" />
              <h2 className="font-display text-lg font-semibold text-slate-100">
                Setup Google Apps Script Webhook
              </h2>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Publish all {totalRowsCount.toLocaleString()} SQLite rows across all 6 worksheets directly to a public Google Sheet without GCP Service Account JSON keys or browser OAuth popups.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close modal"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Step 1: Copy Apps Script */}
        <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-100">
                1. Copy &amp; Deploy Apps Script in Your Google Sheet
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Creates all 6 tabs, deletes blank <code className="text-slate-300">Sheet1</code>, sets{" "}
                <strong className="text-slate-200">Anyone with the link — Viewer</strong> sharing, and returns <code className="text-slate-300">spreadsheetUrl</code>.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleCopyCode()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors"
              >
                {copiedScript ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedScript ? "Copied Code!" : "Copy Google Apps Script Code"}</span>
              </button>
              <button
                type="button"
                onClick={() => setShowCode((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                {showCode ? "Hide Code" : "View Code"}
              </button>
            </div>
          </div>

          <ol className="list-decimal list-inside space-y-1 text-xs text-slate-300">
            <li>
              Open a blank sheet at{" "}
              <a
                href="https://sheets.new"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 hover:underline inline-flex items-center gap-1"
              >
                <span>sheets.new</span>
                <ExternalLink className="w-3 h-3" />
              </a>{" "}
              then open <strong className="text-slate-100">Extensions &rarr; Apps Script</strong>.
            </li>
            <li>
              Click <strong className="text-slate-100">Copy Google Apps Script Code</strong> above, replace <code className="text-sky-300">Code.gs</code>, and click <strong className="text-slate-100">Deploy &rarr; New deployment &rarr; Web app</strong>.
            </li>
            <li>
              Choose <strong className="text-slate-100">Execute as: Me</strong> and <strong className="text-slate-100">Who has access: Anyone</strong>, authorize once, and copy the generated <code className="text-sky-300">/exec</code> Web App URL.
            </li>
          </ol>

          {showCode && (
            <pre className="rounded-lg bg-[#0B1324] border border-slate-800 p-3 text-[11px] font-mono text-slate-300 max-h-56 overflow-y-auto whitespace-pre-wrap">
              {GOOGLE_APPS_SCRIPT_SNIPPET}
            </pre>
          )}
        </div>

        {/* Step 2: Paste Web App URL */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="modal-apps-script-webhook-url" className="text-xs font-semibold text-slate-200 block">
              2. Paste Google Apps Script Web App URL
            </label>
            {savedWebhookUrl && (
              <button
                type="button"
                onClick={onRemoveWebhookUrl}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear Saved URL</span>
              </button>
            )}
          </div>
          <input
            id="modal-apps-script-webhook-url"
            type="text"
            inputMode="url"
            value={webhookUrlInput}
            onChange={(e) => onWebhookUrlInputChange(e.target.value)}
            placeholder="https://script.google.com/macros/s/AKfycb.../exec"
            className="w-full px-3.5 py-2.5 rounded-lg bg-[#070D1A] border border-slate-700 text-xs font-mono text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>
              Automatically trimmed and saved in SQLite; subsequent collection runs and scheduled updates sync automatically.
            </span>
          </div>
        </div>

        {errorMessage && (
          <div className="rounded-lg bg-rose-950/40 border border-rose-800/60 p-3 text-xs text-rose-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span className="leading-relaxed">{errorMessage}</span>
          </div>
        )}

        {spreadsheetUrl && !errorMessage && (
          <div className="rounded-lg bg-emerald-950/30 border border-emerald-800/60 p-3 text-xs text-emerald-200 flex flex-wrap items-center justify-between gap-2">
            <span className="truncate font-mono">{spreadsheetUrl}</span>
            <a
              href={spreadsheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-medium shrink-0 transition-colors"
            >
              <span>Open Google Sheet</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        {/* Modal Footer */}
        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2 border-t border-slate-800/80">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-xs font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSaveOnly()}
            disabled={busy || !hasInput}
            className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-xs font-medium transition-colors"
          >
            {savingWebhookUrl && !syncingNow ? "Saving..." : "Save URL"}
          </button>
          <button
            type="button"
            onClick={() => void onSaveAndSyncNow()}
            disabled={busy || !hasInput}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {syncingNow ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>
              {syncingNow
                ? `Syncing ${totalRowsCount.toLocaleString()} Rows...`
                : "Save & Sync Now"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
