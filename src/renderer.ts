import type { ActivationFunction, OutputItem } from 'vscode-notebook-renderer';

type SchemaField = {
  name: string;
  type?: string;
  nullable?: boolean;
  metadata?: any;
};

type SynapsePayload = {
  data?: any[]; // array of row arrays (aligned with fields)
  schema?: {
    fields?: SchemaField[];
    type?: string; // usually "struct"
  };
};

// Persisted state kept by VS Code per output item (iframe state)
type PersistedState = {
  colWidths?: Record<string, number>; // px widths per column key
};

export const activate: ActivationFunction = (context) => {
  const state = (context.getState?.() ?? {}) as PersistedState;

  function setState(next: PersistedState) {
    context.setState?.(next);
  }

  return {
    renderOutputItem(data: OutputItem, element: HTMLElement) {
      // Clear container
      element.replaceChildren();

      // --- Parse JSON payload safely ---
      let payload: SynapsePayload | any;
      try {
        payload = data.json();
      } catch {
        element.appendChild(info('Invalid JSON payload for Synapse SparkSQL renderer.'));
        return;
      }

      // The renderer is invoked for a single mimetype; expect: { data: [...], schema:{ fields:[...] } }
      const fields = payload?.schema?.fields as SchemaField[] | undefined;
      const rows = payload?.data as any[] | undefined;

      if (!Array.isArray(fields) || !Array.isArray(rows)) {
        // Fallback: pretty-print whatever we got
        const container = div('ssr-root');
        container.appendChild(styleTag());
        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.textContent = JSON.stringify(payload, null, 2);
        container.appendChild(pre);
        element.appendChild(container);
        return;
      }

      // --- Build UI ---
      const container = div('ssr-root');
      container.appendChild(styleTag());

      // Wrapper with scrollbars; height adjusted later if >20 rows
      const tableWrap = div('ssr-table-wrap');
      const table = document.createElement('table');
      table.className = 'ssr-table';

      // Columns (keys = index-based since rows are arrays)
      const columns = fields.map((f, i) => ({
        key: `c${i}`,
        index: i,
        header: f.name ?? `col_${i + 1}`,
        type: humanType(f.type),
      }));

      // THEAD with sticky header, type badges, resizers
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');

      const widths = (state.colWidths ?? {}) as Record<string, number>;

      for (const col of columns) {
        const th = document.createElement('th');
        th.className = 'ssr-th';
        th.dataset.colKey = col.key;

        // Persisted width
        const w = widths[col.key];
        if (typeof w === 'number' && w > 24) {
          th.style.width = `${w}px`;
          th.style.minWidth = `${w}px`;
          th.style.maxWidth = `${w}px`;
        }

        // Header title
        const title = div('ssr-th-title', col.header);
        th.appendChild(title);

        // Type badge (if available)
        if (col.type) {
          const badge = span('ssr-th-type', col.type);
          th.appendChild(badge);
        }

        // Resizer handle
        const resizer = div('ssr-resizer');
        th.appendChild(resizer);
        enableColumnResize(resizer, th, col.key, () => {
          const rect = th.getBoundingClientRect();
          widths[col.key] = Math.round(rect.width);
          setState({ ...state, colWidths: { ...widths } });
        });

        headRow.appendChild(th);
      }
      thead.appendChild(headRow);

      // TBODY from array-of-arrays rows
      const tbody = document.createElement('tbody');

      for (const r of rows) {
        const tr = document.createElement('tr');
        tr.className = 'ssr-tr';

        if (Array.isArray(r)) {
          for (const col of columns) {
            tr.appendChild(td(stringifyCell(r[col.index])));
          }
        } else {
          // Unexpected (not array), still render something
          tr.appendChild(td(stringifyCell(r)));
        }

        tbody.appendChild(tr);
      }

      table.appendChild(thead);
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      container.appendChild(tableWrap);
      element.appendChild(container);

      // --- Vertical scrollbar only when > 20 rows ---
      // After table is in DOM, measure row/header height to fit exactly 20 rows.
      requestAnimationFrame(() => {
        try {
          const rowCount = rows.length;
          if (rowCount > 20) {
            const headerH = thead.getBoundingClientRect().height || 32;
            const firstRow = tbody.rows[0] as HTMLTableRowElement | undefined;
            const rowH = firstRow ? firstRow.getBoundingClientRect().height : 28;

            // Height = header + 20 rows + tiny padding
            const maxH = Math.round(headerH + rowH * 20 + 6);
            (tableWrap as HTMLDivElement).style.maxHeight = `${maxH}px`;
            (tableWrap as HTMLDivElement).style.overflowY = 'auto';
          } else {
            // No cap if 20 or fewer rows
            (tableWrap as HTMLDivElement).style.maxHeight = '';
            (tableWrap as HTMLDivElement).style.overflowY = 'visible';
          }
        } catch {
          // If measuring fails, leave defaults
        }
      });
    },
  };
};

// ---------- Helpers & UI ----------

function styleTag(): HTMLStyleElement {
  const s = document.createElement('style');
  s.textContent = `
  :root { color-scheme: light dark; }
  .ssr-root {
    font-family: var(--vscode-editor-font-family, ui-sans-serif, system-ui);
    font-size: 13px;
    color: var(--vscode-editor-foreground);
  }
  .ssr-table-wrap {
    overflow-x: auto;       /* always allow horizontal scroll for wide tables */
    overflow-y: visible;    /* becomes auto if >20 rows (set in JS) */
    border: 1px solid var(--vscode-editorWidget-border, #4443);
    border-radius: 4px;
  }
  table.ssr-table {
    border-collapse: collapse;
    width: max-content;   /* shrink to content, but not less than 100% */
    min-width: 100%;
  }
  .ssr-th, .ssr-td {
    border: 1px solid var(--vscode-editorWidget-border, #4443);
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
    position: relative;
  }
  thead .ssr-th {
    background: var(--vscode-editor-inactiveSelectionBackground, #00000010);
    position: sticky;
    top: 0;
    z-index: 2;
    white-space: nowrap;
  }
  .ssr-th-title {
    font-weight: 600;
  }
  .ssr-th-type {
    display: inline-block;
    margin-left: 6px;
    font-size: 11px;
    opacity: 0.8;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    background: var(--vscode-textBlockQuote-background, #00000010);
    border: 1px solid var(--vscode-editorWidget-border, #4443);
    border-radius: 3px;
    padding: 1px 4px;
  }
  .ssr-resizer {
    position: absolute;
    right: 0; top: 0;
    width: 6px; height: 100%;
    cursor: col-resize;
    user-select: none;
    touch-action: none;
  }
  tbody tr:nth-child(even) {
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-editor-foreground) 10%);
  }
  .ssr-td {
    white-space: nowrap;  /* prevent huge multi-line cells by default */
  }
  `;
  return s;
}

function div(cls?: string, text?: string) {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function span(cls?: string, text?: string) {
  const el = document.createElement('span');
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function td(text?: string) {
  const el = document.createElement('td');
  el.className = 'ssr-td';
  if (text !== undefined) el.textContent = text;
  return el;
}

function info(text: string) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

function humanType(t: any): string | undefined {
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  try { return JSON.stringify(t); } catch { return String(t); }
}

function stringifyCell(val: any): string {
  if (val === null) return '∅';
  if (val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// ---------- Column Resizing ----------

function enableColumnResize(resizer: HTMLDivElement, th: HTMLTableCellElement, colKey: string, onDone: () => void) {
  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  const onMouseDown = (e: MouseEvent) => {
    dragging = true;
    startX = e.clientX;
    startWidth = th.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(24, Math.round(startWidth + delta));
    th.style.width = `${newW}px`;
    th.style.minWidth = `${newW}px`;
    th.style.maxWidth = `${newW}px`;
  };

  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    onDone();
  };

  resizer.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}
