---
name: artifact-pages
description: Design, write, and publish polished web pages and documents as shareable GitHub Pages links with the artifact_publish tool. Use when the user asks for something to open in a browser or share by link, such as a report, dashboard, chart, interactive demo, slide-style page, or long-form document, or asks to publish, update, list, or delete a published artifact.
---

# Publishing artifacts on GitHub Pages

An artifact is one HTML page (with optional asset files) or one Markdown document, published at a stable public URL. The `artifact_*` tools handle the GitHub side. Your job is to make the page worth opening.

## Pick the kind

- **Markdown document** (`.md`): prose-first content such as reports, write-ups, notes, guides, and READMEs. The plugin renders GitHub-flavored Markdown (tables, task lists, footnotes, code blocks) into a clean, readable page with light and dark themes. Raw HTML inside Markdown is escaped, so use plain Markdown.
- **HTML page** (`.html`): anything visual or interactive, such as dashboards, charts, calculators, explorable explanations, slide-style pages, and landing pages. The file is served as-is.

## Workflow

1. Write the page to a workspace file, e.g. `report.md` or `dashboard.html`. Do not paste long sources into `content`.
2. Check it before publishing. Render-check HTML mentally or with available tools, make sure every asset path resolves, and read the text once for accuracy.
3. Publish: `artifact_publish({ description, title, path })`. Add `assets` for images or data files the page references by relative URL.
4. Reply with the link as Markdown: `[Title](url)`. Mention that it can take about a minute to go live.
5. To change it later, edit the file and call `artifact_publish({ description, id, path })` with the same `id`, so the URL stays the same. If you did not write the current version yourself, `artifact_read` it first and pass `baseRev`.

Use `artifact_status` with `id` and `wait: true` when the user wants confirmation that the page is live, or when something looks wrong (missing token, Pages disabled, failed build).

## Privacy and safety

- Everything published is public, and the repository history keeps old versions even after deletion. Never include credentials, tokens, personal data, internal URLs, or private conversation content unless the user explicitly asked to publish exactly that.
- Never ask the user to paste a GitHub token into the chat. The token is configured outside the conversation (see the plugin README).
- Do not publish pages that imitate a real organization's or person's site, or forms that collect passwords or payment details.

## HTML pages that look good

Prefer one self-contained file: inline `<style>` and `<script>`, plus a few external libraries from a CDN when they genuinely help (for example a charting library from cdn.jsdelivr.net or cdnjs.cloudflare.com, pinned to an exact version).

Structure:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clear, specific title</title>
  <style>
    :root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --muted: #59636e; --accent: #0969da; --border: #d1d9e0; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --accent: #4493f8; --border: #3d444d; } }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
    main { max-width: 64rem; margin: 0 auto; padding: 2rem 1rem; }
  </style>
</head>
<body>
  <main>...</main>
</body>
</html>
```

Design rules:

- Define colors once as CSS variables and support dark mode with `prefers-color-scheme`. Give `body` an explicit background.
- Make it responsive. It must work at 360 px wide with no horizontal page scroll: use fluid widths, `max-width`, CSS grid or flex with wrapping, and `overflow-x: auto` on wide tables and code.
- Use a clear hierarchy: one `h1`, short intro, sections with headings, generous whitespace, and a readable line length (60-80 characters).
- Charts need titles, labeled axes with units, legends when there is more than one series, and accessible colors. Embed the data in the page (a JSON block or a JS constant) so it works offline from the CDN cache.
- Use system fonts, or one web font if the design needs it.
- Accessibility: semantic elements (`main`, `nav`, `section`, `button`), alt text on images, visible focus states, sufficient contrast, and keyboard-operable controls.
- Interactive state should live in the page. Do not rely on server endpoints: GitHub Pages serves static files only.
- Keep it fast: no huge images (compress or resize first), no autoplaying media, and lazy-load below-the-fold images.

## Markdown documents that read well

- Start with one `# Title` that matches the artifact title, then a one-paragraph summary.
- Use `##` sections, short paragraphs, lists for parallel items, and tables for comparisons.
- Use fenced code blocks with a language tag.
- Put images in `assets` and reference them relatively: `![Revenue by month](chart.png)`.
- End with sources or next steps when relevant.

## Assets

`assets: [{ path: "out/chart.png" }, { path: "data.json", name: "data/data.json" }]` publishes files next to the page. Reference them with relative URLs (`chart.png`, `data/data.json`). On update, listed assets are added or replaced and the others are kept. Use `removeAssets` to delete one. The total size of one publish is limited (10 MiB by default).

## Managing artifacts

- `artifact_list`: find ids and URLs, with an optional text `query`.
- `artifact_read`: fetch the current source in windows (`offset`/`limit`) before editing someone else's version.
- `artifact_delete`: remove a page when the user asks. The id is never reused.
