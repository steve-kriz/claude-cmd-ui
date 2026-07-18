---
id: TASK-015
title: viewing md files
status: done
created: 2026-07-18T10:03:11.575Z
updated: 2026-07-18T10:51:51.884Z
startedAt: 2026-07-18T10:33:53.000Z
finishedAt: 2026-07-18T10:51:51.884Z
---

## Description
In the app's Files viewer (renderer), when the currently open file has a `.md` extension, add a **"Show preview"** toggle button to the Files toolbar. Clicking it renders the markdown as formatted HTML (headings, bold/italic, ordered/unordered lists, inline code and fenced code blocks, links, images, blockquotes) in place of the raw editor. Toggling again returns to the raw source in the editable `textarea`. The button appears **only** for `.md` files and is hidden/absent for every other file type and when no file is open. Rendering must be done with an in-repo markdown renderer or existing capability — **no new npm dependency** — and must be safe: raw HTML/script in the markdown source must not execute (no script injection). The file-viewer UI lives in `renderer/index.html` (`.view-toolbar` inside `data-view="files"`, the `.fileEditor` textarea, and `.fileBinaryMsg`) and `renderer/renderer.js` (`loadFile`, `resetFileEditor`, and the toolbar button wiring). Preview is read-only; while previewing, editing is not expected, and switching back to source restores the editable textarea with its current content.

## Acceptance Criteria
- [ ] A "Show preview" button exists in the Files toolbar and is visible/enabled only when the open file's path ends in `.md` (case-insensitive).
- [ ] The preview button is hidden or disabled when no file is open, when the file is binary/truncated, and for any non-`.md` file extension.
- [ ] Clicking "Show preview" hides the raw `.fileEditor` textarea and shows a rendered-HTML preview of the current markdown content; the button label/state reflects that preview is active (e.g. toggles to "Show source" or a pressed state).
- [ ] Clicking the button again (or "Show source") returns to the raw editable source view showing the same content.
- [ ] The renderer produces correct HTML for headings, bold/italic, unordered and ordered lists, inline code, fenced code blocks, links, images, and blockquotes.
- [ ] Rendering is safe against injection: any raw `<script>` (or other active HTML) in the markdown source does not execute and is not injected as live script in the preview.
- [ ] No new npm dependency is added (markdown rendering uses in-repo code or existing capability); `package.json` dependencies are unchanged.
- [ ] Opening a different file, or switching the viewer away, resets the preview back to source mode so a newly opened non-`.md` file never shows a stale preview or an orphaned preview button.

## Cucumber Tests
```gherkin
Feature: Markdown preview toggle in the file viewer

  Scenario: Preview button appears for markdown files
    Given the Files viewer is open
    When I open a file named "README.md"
    Then a "Show preview" button is visible and enabled in the Files toolbar

  Scenario: Preview button hidden for non-markdown files
    Given the Files viewer is open
    When I open a file named "renderer.js"
    Then the "Show preview" button is hidden or disabled

  Scenario: No file open means no preview button
    Given the Files viewer is open
    And no file is currently open
    Then the "Show preview" button is hidden or disabled

  Scenario: Toggling to preview renders formatted HTML
    Given I have opened "README.md" containing a level-1 heading and a bullet list
    When I click "Show preview"
    Then the raw text editor is hidden
    And a rendered preview shows an "h1" element and an unordered list
    And the button now offers returning to source

  Scenario: Toggling back shows the raw source
    Given "README.md" is shown in preview mode
    When I click the toggle to return to source
    Then the editable text area is shown again with the original markdown content

  Scenario Outline: Common markdown constructs render correctly
    Given "doc.md" containing "<markdown>"
    When I view it in preview mode
    Then the rendered HTML contains a "<element>" element

    Examples:
      | markdown                     | element    |
      | # Title                      | h1         |
      | **bold**                     | strong     |
      | 1. first                     | ol         |
      | `code`                       | code       |
      | [link](https://example.com)  | a          |
      | ![alt](img.png)              | img        |
      | > quote                      | blockquote |

  Scenario: Script in markdown does not execute (edge)
    Given "evil.md" containing a raw "<script>window.__pwned = true</script>" tag
    When I view it in preview mode
    Then no script from the markdown runs
    And "window.__pwned" is not set

  Scenario: Switching files resets preview mode (edge)
    Given "README.md" is shown in preview mode
    When I open a different file "notes.txt"
    Then the viewer shows raw source, not a markdown preview
    And the "Show preview" button is hidden or disabled

  Scenario: No new dependency is introduced (edge)
    Given the diff for this ticket
    When I inspect "package.json"
    Then no new runtime dependency was added
```

## Additional Context
(User-owned. Read it before building. Never overwrite it.)
