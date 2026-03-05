export function getStudioHtml(options: { readOnly: boolean }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Espalier Studio</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
  --text: #e1e4ed; --muted: #8b8fa3; --accent: #6366f1;
  --accent-hover: #818cf8; --danger: #ef4444;
  --success: #22c55e; --warning: #f59e0b;
}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }
#app { display: flex; height: 100vh; }
.sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-header { padding: 16px; border-bottom: 1px solid var(--border); }
.sidebar-header h1 { font-size: 16px; font-weight: 600; color: var(--accent); }
.sidebar-header small { color: var(--muted); font-size: 11px; }
.table-list { flex: 1; overflow-y: auto; padding: 8px; }
.table-item { padding: 8px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-bottom: 2px; transition: background .15s; }
.table-item:hover { background: var(--border); }
.table-item.active { background: var(--accent); color: #fff; }
.table-item .count { float: right; color: var(--muted); font-size: 11px; }
.table-item.active .count { color: rgba(255,255,255,.7); }
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.toolbar { padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
.toolbar h2 { font-size: 15px; font-weight: 500; }
.toolbar .badge { background: var(--border); padding: 2px 8px; border-radius: 4px; font-size: 11px; color: var(--muted); }
.nav-tabs { display: flex; gap: 0; margin-left: auto; }
.nav-tab { padding: 6px 14px; cursor: pointer; font-size: 12px; color: var(--muted); border: 1px solid var(--border); background: transparent; transition: all .15s; }
.nav-tab:first-child { border-radius: 6px 0 0 6px; }
.nav-tab:last-child { border-radius: 0 6px 6px 0; }
.nav-tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.content { flex: 1; overflow: auto; padding: 0; }
.grid-wrap { overflow: auto; height: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead { position: sticky; top: 0; z-index: 1; }
th { background: var(--surface); border-bottom: 2px solid var(--border); padding: 8px 12px; text-align: left; font-weight: 500; cursor: pointer; white-space: nowrap; user-select: none; }
th:hover { color: var(--accent); }
th .sort-icon { margin-left: 4px; font-size: 10px; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
tr:hover td { background: rgba(99,102,241,.06); }
.fk-link { color: var(--accent); cursor: pointer; text-decoration: underline; }
.fk-link:hover { color: var(--accent-hover); }
.pagination { padding: 12px 16px; background: var(--surface); border-top: 1px solid var(--border); display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--muted); }
.pagination button { background: var(--border); color: var(--text); border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.pagination button:disabled { opacity: .4; cursor: default; }
.pagination button:hover:not(:disabled) { background: var(--accent); color: #fff; }
.empty { padding: 40px; text-align: center; color: var(--muted); }
.read-only-badge { background: var(--warning); color: #000; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.write-badge { background: var(--danger); color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.schema-view { padding: 16px; font-size: 13px; }
.schema-view pre { background: var(--surface); padding: 16px; border-radius: 8px; overflow: auto; max-height: calc(100vh - 120px); }
.diagram-view { padding: 16px; }
.diagram-view pre { background: var(--surface); padding: 16px; border-radius: 8px; overflow: auto; font-size: 12px; max-height: calc(100vh - 120px); }
.query-view { padding: 16px; display: flex; flex-direction: column; height: 100%; }
.query-editor { width: 100%; min-height: 120px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-family: "SF Mono", Menlo, monospace; font-size: 13px; resize: vertical; }
.query-btn { margin-top: 8px; background: var(--accent); color: #fff; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 13px; align-self: flex-start; }
.query-btn:hover { background: var(--accent-hover); }
.query-results { margin-top: 16px; flex: 1; overflow: auto; }
.error { background: rgba(239,68,68,.15); border: 1px solid var(--danger); color: var(--danger); padding: 12px; border-radius: 8px; font-size: 13px; }
</style>
</head>
<body>
<div id="app">
  <div class="sidebar">
    <div class="sidebar-header">
      <h1>Espalier Studio</h1>
      <small>${options.readOnly ? '<span class="read-only-badge">READ ONLY</span>' : '<span class="write-badge">WRITE MODE</span>'}</small>
    </div>
    <div class="table-list" id="tableList"></div>
  </div>
  <div class="main">
    <div class="toolbar" id="toolbar">
      <h2 id="tableTitle">Select a table</h2>
      <div class="nav-tabs">
        <button class="nav-tab active" data-view="data" onclick="switchView('data')">Data</button>
        <button class="nav-tab" data-view="schema" onclick="switchView('schema')">Schema</button>
        <button class="nav-tab" data-view="diagram" onclick="switchView('diagram')">Diagram</button>
        <button class="nav-tab" data-view="query" onclick="switchView('query')">Query</button>
      </div>
    </div>
    <div class="content" id="content">
      <div class="empty">Select a table from the sidebar to browse data.</div>
    </div>
  </div>
</div>
<script>
const READ_ONLY = ${options.readOnly};
let tables = [];
let currentTable = null;
let currentPage = 0;
let pageSize = 50;
let sortCol = null;
let sortDir = "ASC";
let currentView = "data";
let schema = null;

async function init() {
  const res = await fetch("/api/tables");
  tables = await res.json();
  renderTableList();
  const sRes = await fetch("/api/schema");
  schema = await sRes.json();
}

function renderTableList() {
  const el = document.getElementById("tableList");
  el.innerHTML = tables.map(t =>
    '<div class="table-item' + (currentTable === t.tableName ? ' active' : '') +
    '" onclick="selectTable(\\'' + t.tableName + '\\')">' +
    t.tableName + '<span class="count">' + t.columnCount + ' cols</span></div>'
  ).join("");
}

async function selectTable(name) {
  currentTable = name;
  currentPage = 0;
  sortCol = null;
  sortDir = "ASC";
  renderTableList();
  if (currentView === "data") await loadRows();
  else if (currentView === "schema") renderSchema();
  else if (currentView === "diagram") renderDiagram();
  document.getElementById("tableTitle").textContent = name;
}

async function loadRows() {
  if (!currentTable) return;
  let url = "/api/tables/" + encodeURIComponent(currentTable) + "/rows?page=" + currentPage + "&size=" + pageSize;
  if (sortCol) url += "&sort=" + encodeURIComponent(sortCol + "," + sortDir);
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) { document.getElementById("content").innerHTML = '<div class="error">' + escHtml(data.error) + '</div>'; return; }
  renderDataGrid(data);
}

function escHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }

function renderDataGrid(data) {
  if (!data.rows || data.rows.length === 0) {
    document.getElementById("content").innerHTML = '<div class="empty">No rows found.</div>' + renderPagination(data);
    return;
  }
  const cols = Object.keys(data.rows[0]);
  const tableInfo = schema ? schema.tables.find(t => t.tableName === currentTable) : null;
  const fkCols = new Map();
  if (tableInfo) {
    for (const rel of tableInfo.relations) {
      if (rel.type === "ManyToOne" && rel.joinColumn) fkCols.set(rel.joinColumn, rel.targetTable);
    }
  }
  let html = '<div class="grid-wrap"><table><thead><tr>';
  for (const col of cols) {
    const icon = sortCol === col ? (sortDir === "ASC" ? " &#9650;" : " &#9660;") : "";
    html += '<th onclick="toggleSort(\\'' + col + '\\')">' + escHtml(col) + '<span class="sort-icon">' + icon + '</span></th>';
  }
  html += '</tr></thead><tbody>';
  for (const row of data.rows) {
    html += '<tr>';
    for (const col of cols) {
      const val = row[col];
      if (fkCols.has(col) && val != null) {
        const target = fkCols.get(col);
        html += '<td><span class="fk-link" onclick="navigateFK(\\'' + target + '\\', \\'' + escHtml(String(val)) + '\\')">' + escHtml(val) + '</span></td>';
      } else {
        html += '<td>' + escHtml(val) + '</td>';
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += renderPagination(data);
  document.getElementById("content").innerHTML = html;
}

function renderPagination(data) {
  return '<div class="pagination">' +
    '<button onclick="prevPage()" ' + (currentPage === 0 ? 'disabled' : '') + '>Prev</button>' +
    '<span>Page ' + (data.page + 1) + ' of ' + Math.max(1, data.totalPages) + ' (' + data.total + ' rows)</span>' +
    '<button onclick="nextPage()" ' + (currentPage >= data.totalPages - 1 ? 'disabled' : '') + '>Next</button>' +
    '</div>';
}

function toggleSort(col) {
  if (sortCol === col) sortDir = sortDir === "ASC" ? "DESC" : "ASC";
  else { sortCol = col; sortDir = "ASC"; }
  loadRows();
}

function prevPage() { if (currentPage > 0) { currentPage--; loadRows(); } }
function nextPage() { currentPage++; loadRows(); }

function navigateFK(targetTable, id) {
  currentTable = targetTable;
  currentPage = 0;
  sortCol = null;
  renderTableList();
  document.getElementById("tableTitle").textContent = targetTable;
  fetch("/api/tables/" + encodeURIComponent(targetTable) + "/rows/" + encodeURIComponent(id))
    .then(r => r.json())
    .then(row => {
      if (row.error) { document.getElementById("content").innerHTML = '<div class="error">' + escHtml(row.error) + '</div>'; return; }
      const cols = Object.keys(row);
      let html = '<div class="grid-wrap"><table><thead><tr>';
      for (const c of cols) html += '<th>' + escHtml(c) + '</th>';
      html += '</tr></thead><tbody><tr>';
      for (const c of cols) html += '<td>' + escHtml(row[c]) + '</td>';
      html += '</tr></tbody></table></div>';
      html += '<div class="pagination"><button onclick="loadRows()">Back to list</button></div>';
      document.getElementById("content").innerHTML = html;
    });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  if (view === "data") loadRows();
  else if (view === "schema") renderSchema();
  else if (view === "diagram") renderDiagram();
  else if (view === "query") renderQueryView();
}

function renderSchema() {
  if (!schema) { document.getElementById("content").innerHTML = '<div class="empty">Loading schema...</div>'; return; }
  const tableData = currentTable ? schema.tables.find(t => t.tableName === currentTable) : schema;
  document.getElementById("content").innerHTML = '<div class="schema-view"><pre>' + escHtml(JSON.stringify(tableData, null, 2)) + '</pre></div>';
}

function renderDiagram() {
  if (!schema) return;
  let lines = ["erDiagram"];
  for (const t of schema.tables) {
    lines.push("    " + t.tableName + " {");
    for (const c of t.columns) lines.push("        " + (c.type || "string") + " " + c.columnName + (c.isPrimaryKey ? ' "PK"' : ''));
    lines.push("    }");
  }
  for (const r of schema.relations) {
    if (r.type === "ManyToOne") lines.push("    " + r.sourceTable + " }o--|| " + r.targetTable + ' : "' + r.fieldName + '"');
    else if (r.type === "OneToMany") lines.push("    " + r.sourceTable + " ||--o{ " + r.targetTable + ' : "' + r.fieldName + '"');
    else if (r.type === "ManyToMany") lines.push("    " + r.sourceTable + " }o--o{ " + r.targetTable + ' : "' + r.fieldName + '"');
    else if (r.type === "OneToOne") lines.push("    " + r.sourceTable + " ||--|| " + r.targetTable + ' : "' + r.fieldName + '"');
  }
  document.getElementById("content").innerHTML = '<div class="diagram-view"><pre>' + escHtml(lines.join("\\n")) + '</pre></div>';
}

function renderQueryView() {
  document.getElementById("content").innerHTML =
    '<div class="query-view">' +
    '<textarea class="query-editor" id="sqlInput" placeholder="SELECT * FROM ...">' + (currentTable ? 'SELECT * FROM ' + currentTable + ' LIMIT 20' : '') + '</textarea>' +
    '<button class="query-btn" onclick="runQuery()">Run Query</button>' +
    '<div class="query-results" id="queryResults"></div>' +
    '</div>';
}

async function runQuery() {
  const sql = document.getElementById("sqlInput").value.trim();
  if (!sql) return;
  const el = document.getElementById("queryResults");
  el.innerHTML = '<div class="empty">Running...</div>';
  const res = await fetch("/api/query", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({sql}) });
  const data = await res.json();
  if (data.error) { el.innerHTML = '<div class="error">' + escHtml(data.error) + '</div>'; return; }
  if (!data.rows || data.rows.length === 0) { el.innerHTML = '<div class="empty">Query returned no rows. Affected: ' + (data.affected ?? 0) + '</div>'; return; }
  const cols = Object.keys(data.rows[0]);
  let html = '<table><thead><tr>';
  for (const c of cols) html += '<th>' + escHtml(c) + '</th>';
  html += '</tr></thead><tbody>';
  for (const row of data.rows) {
    html += '<tr>';
    for (const c of cols) html += '<td>' + escHtml(row[c]) + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

init();
</script>
</body>
</html>`;
}
