import type { ActivationFunction, OutputItem } from 'vscode-notebook-renderer';

type SparkSqlLike =
  | {
      schema?: { fields?: { name: string }[] } | { columns?: string[] };
      data?: any[];
      rows?: any[];
    }
  | any;

function toElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function renderTableFromData(data: any): HTMLElement | null {
  // Try patterns in order:
  // 1) { schema:{fields:[{name}]}, data:[{...}] or [ [..] ] }
  // 2) { schema:{columns:[...]}, data:[...] }
  // 3) array of objects
  // 4) array of arrays

  let columns: string[] | undefined;
  let rows: any[] | undefined;

  const obj = data as SparkSqlLike;

  if (obj && typeof obj === 'object') {
    const schema = (obj as any).schema;
    const hasFields = schema && Array.isArray(schema.fields);
    const hasColumns = schema && Array.isArray(schema.columns);

    const rawRows = (obj as any).data ?? (obj as any).rows;

    if (hasFields && Array.isArray(rawRows)) {
      columns = schema.fields.map((f: any) => String(f.name ?? ''));
      rows = rawRows;
    } else if (hasColumns && Array.isArray(rawRows)) {
      columns = schema.columns.map((c: any) => String(c));
      rows = rawRows;
    }
  }

  // If not found via schema, try structural inference
  if (!columns || !rows) {
    if (Array.isArray(data) && data.length > 0) {
      if (typeof data[0] === 'object' && !Array.isArray(data[0])) {
        // Array of objects
        const cols = new Set<string>();
        for (const r of data) Object.keys(r).forEach(k => cols.add(k));
        columns = [...cols];
        rows = data;
      } else if (Array.isArray(data[0])) {
        // Array of arrays
        const maxLen = Math.max(...data.map((r: any[]) => r.length));
        columns = Array.from({ length: maxLen }, (_, i) => `col_${i + 1}`);
        rows = data;
      }
    }
  }

  if (!columns || !rows) return null;

  // Build table
  const container = toElement('div', 'ssr-container');
  const table = toElement('table', 'ssr-table');

  const thead = toElement('thead');
  const trHead = toElement('tr');
  for (const c of columns) {
    trHead.appendChild(toElement('th', 'ssr-th', c));
  }
  thead.appendChild(trHead);

  const tbody = toElement('tbody');
  for (const r of rows) {
    const tr = toElement('tr');
    if (Array.isArray(r)) {
      // array row
      for (let i = 0; i < columns.length; i++) {
        tr.appendChild(toElement('td', 'ssr-td', stringifyCell(r[i])));
      }
    } else if (r && typeof r === 'object') {
      // object row
      for (const c of columns) {
        tr.appendChild(toElement('td', 'ssr-td', stringifyCell((r as any)[c])));
      }
    } else {
      // primitive row
      tr.appendChild(toElement('td', 'ssr-td', stringifyCell(r)));
    }
    tbody.appendChild(tr);
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(styleTag());
  container.appendChild(table);
  return container;
}

function stringifyCell(val: any): string {
  if (val === null) return '∅';
  if (val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function styleTag(): HTMLStyleElement {
  const s = document.createElement('style');
  s.textContent = `
  :root { color-scheme: light dark; }
  .ssr-container { font-family: var(--vscode-editor-font-family, ui-sans-serif, system-ui); }
  .ssr-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  .ssr-th, .ssr-td {
    border: 1px solid var(--vscode-editorWidget-border, #4443);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }
  .ssr-th {
    background: var(--vscode-editor-inactiveSelectionBackground, #00000010);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  tbody tr:nth-child(even) {
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-editor-foreground) 10%);
  }
  `;
  return s;
}

export const activate: ActivationFunction = _context => {
  return {
    renderOutputItem(data: OutputItem, element: HTMLElement) {
      // Clear previous content for re-render
      while (element.firstChild) element.removeChild(element.firstChild);

      let parsed: any;
      try {
        // OutputItem#json() convenience parses JSON (or converts from bytes)
        parsed = data.json();
      } catch {
        // Fallback: show as text
        const pre = toElement('pre', undefined, 'Invalid JSON payload for Synapse SparkSQL renderer.');
        element.appendChild(pre);
        return;
      }

      const table = renderTableFromData(parsed);
      if (table) {
        element.appendChild(table);
      } else {
        // Fallback: raw JSON pretty-print
        const pre = toElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.textContent = JSON.stringify(parsed, null, 2);
        element.appendChild(styleTag());
        element.appendChild(pre);
      }
    }
  };
};