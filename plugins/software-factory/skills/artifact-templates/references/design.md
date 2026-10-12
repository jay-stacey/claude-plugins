# Design template

README cap: S 30 lines, M 60, L 120. HTML screens: at most S 1, M 3, L 8.

## design/README.md

```markdown
# Design: <goal title> (<G-id>)

## Task statement
<What the user needs to do on these screens, in 2-4 sentences. PRD ACs covered: AC-1, AC-3.>

## Screens and states
| Screen | File | States | ACs |
|---|---|---|---|
| <name> | `design/<screen>.html` | empty, loading, error, populated, <other> | AC-1, AC-2 |

## Decisions
- <decision>: <why; which existing component or pattern it reuses, with path>

## Accessibility
- Labels: <how inputs are labelled>
- Keyboard path: <tab order through the main task>
- Focus: <visible focus style from the repo tokens>
- Contrast: AA for text and controls; no meaning carried by colour alone.
- Errors: <how error text is tied to its field and announced>

## Handoff notes
- Reuse: <existing components and token files, with paths>
- New pieces: <anything new and why existing ones do not fit>
- Widths checked: 375, 768, 1440.
```

## design/<screen>.html skeleton

Single file. Inline `<style>`. No remote scripts, fonts, images or stylesheets. The only script is
the state switcher. It must render inside a sandboxed iframe.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><Screen name></title>
<style>
  :root { /* copy the repo's tokens: colours, spacing, radius, type scale */ }
  [data-state] { display: none; }
  body[data-show="empty"] [data-state="empty"],
  body[data-show="loading"] [data-state="loading"],
  body[data-show="error"] [data-state="error"],
  body[data-show="populated"] [data-state="populated"] { display: block; }
  /* layout for 375 first, then @media (min-width: 768px) and (min-width: 1440px) */
</style>
</head>
<body data-show="populated">
<nav aria-label="Mockup states">
  <button type="button" onclick="document.body.dataset.show='empty'">Empty</button>
  <button type="button" onclick="document.body.dataset.show='loading'">Loading</button>
  <button type="button" onclick="document.body.dataset.show='error'">Error</button>
  <button type="button" onclick="document.body.dataset.show='populated'">Populated</button>
</nav>
<main>
  <section data-state="empty">...</section>
  <section data-state="loading" aria-busy="true">...</section>
  <section data-state="error" role="alert">...</section>
  <section data-state="populated">...</section>
</main>
</body>
</html>
```
Use invented sample data only.
