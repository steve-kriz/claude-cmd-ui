# File Explorer, editor & search

## What it does and why

The File Explorer is an in-app project browser: a lazy-loading file tree, an
inline text editor with save/rename, three search scopes, and a safe Markdown
preview. It lets you read and tweak files without leaving the app or switching to
an external editor.

## How it works

The UI is in [`renderer/renderer.js`](../renderer/renderer.js); the privileged
filesystem work is main-process IPC in [`main.js`](../main.js); Markdown
rendering is [`lib/markdown.js`](../lib/markdown.js).

- **Tree** — `fs:readDir` returns directory entries (dirs first, then files,
  sorted). The tree skips `node_modules`/`.git` by default and expands lazily.
- **Editor** — `fs:readFile` returns file content; binary files (by extension in
  `BINARY_EXT`, or a NUL byte in the first 8 KB) and files over
  `FILE_READ_LIMIT` (5 MB) return a placeholder instead of garbage. `fs:writeFile`
  saves (`Ctrl+S`); a "● unsaved" chip tracks dirty state and warns before
  discarding; **Reload** re-reads from disk.
- **Rename** — `fs:rename` renames in place and refuses if the target already
  exists.
- **Filters** — quick **Readme** (Markdown only) and **Changes** (git-modified
  files) filters.
- **Search** (`Ctrl+F`), three scopes:
  - **Tree** — live name filter (renderer-side).
  - **Content** — full-text search across the folder via `fs:grep`, which walks
    the tree (skipping `GREP_SKIP_DIRS`), sniffs out binary files, and caps
    results (`GREP_MAX_RESULTS = 500`, `GREP_MAX_HITS_PER_FILE = 5`,
    `GREP_MAX_FILE_BYTES = 1.5 MB`), returning `{ path, name, nameMatches, hits[] }`
    with line/column/snippet.
  - **File** — find within the open file, with match count and prev/next.
- **Markdown preview** — when the open file is a `.md` file, a **Show preview**
  toggle renders the source as formatted HTML (headings, bold/italic, lists,
  inline/fenced code, links, images, blockquotes) and toggles straight back to
  the raw source. Rendering uses the in-repo, dependency-free
  [`lib/markdown.js`](../lib/markdown.js) — **no new npm dependency**. The source
  is HTML-escaped *before* any transform and link/image URLs are scheme-checked
  (`sanitizeUrl`), so raw HTML or a `javascript:` URL can never execute — it is
  only ever shown as visible text. The renderer keeps a verbatim mirror of
  `renderMarkdown` because it cannot `require()` the module.

## Usage

From the UI: click a folder to expand, a file to open; edit and `Ctrl+S` to save;
`Ctrl+F` to search. For a `.md` file, click **Show preview** to render it and
click again to return to raw source.

Bridge calls (see [`ipc-bridge.md`](ipc-bridge.md)):

```js
const dir = await window.api.fs.readDir('C:/projects/my-app');       // { ok, entries }
const file = await window.api.fs.readFile('C:/projects/my-app/README.md');
await window.api.fs.writeFile('C:/projects/my-app/notes.txt', 'hello');
const hits = await window.api.fs.grep('C:/projects/my-app', 'TODO'); // { ok, results, truncated }
```

Render Markdown directly (Node):

```bash
node -e "console.log(require('./lib/markdown').renderMarkdown('# Hi\n\n**bold** and \`code\`'))"
# -> <h1>Hi</h1>\n<p><strong>bold</strong> and <code>code</code></p>
```

## Configuration

None (no env vars). Limits are constants in `main.js`: `FILE_READ_LIMIT` (5 MB),
`GREP_MAX_RESULTS` (500), `GREP_MAX_HITS_PER_FILE` (5), `GREP_MAX_FILE_BYTES`
(1.5 MB), plus the `BINARY_EXT` and `GREP_SKIP_DIRS` sets. The default tree skip
list is `['node_modules', '.git']`.

## API reference (`fs` IPC)

| Channel | `window.api.fs` | Result |
|---------|------------------|--------|
| `fs:readDir` | `readDir(path)` | `{ ok, entries: [{ name, isDir }] }` |
| `fs:readFile` | `readFile(path)` | `{ ok, content, size, binary?, truncated? }` |
| `fs:writeFile` | `writeFile(path, content)` | `{ ok, size }` |
| `fs:mkdir` | `mkdir(path)` | `{ ok }` (recursive) |
| `fs:rename` | `rename(oldPath, newPath)` | `{ ok }` or `{ ok:false, error:'Target already exists' }` |
| `fs:findByExt` | `findByExt(root, ext, excludeDirs)` | `{ ok, files, dirs }` |
| `fs:grep` | `grep(root, query)` | `{ ok, results, truncated }` |
| `fs:exists` | `exists(path)` | `{ ok, exists, isDir? }` |

`lib/markdown.js` exports: `renderMarkdown(src)`, `escapeHtml(s)`,
`sanitizeUrl(url)`, `renderInline(escaped)`.

## Edge cases, limitations & troubleshooting

- **Binary / oversized files** show a placeholder, never raw bytes.
- **`writeFile` requires a string** — non-string content is rejected.
- **`sanitizeUrl`** collapses `javascript:`, `vbscript:`, `data:text/html` (and
  scheme-hidden variants like `java\tscript:`) to `#`; only http(s), mailto, tel,
  relative URLs and `data:image/...` pass.
- **Content search is capped** — very large trees stop at 500 results
  (`truncated: true`); binary files are skipped.
- **Keep the two Markdown copies in sync** — `lib/markdown.js` and its renderer
  mirror must match; unit tests in `test/task-015-markdown.unit.test.js` cover
  the module.
