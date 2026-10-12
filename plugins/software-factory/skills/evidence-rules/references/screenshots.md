# Screenshots as evidence

Screenshots prove a UI state exists in the running app. They never prove behaviour on their own.

## How to make them
- Use the overlay's e2e or screenshot command through `evidence run`. The command (usually a browser
  test in `files_owned`) saves images to a path the log prints.
- Labels: `screenshot-375`, `screenshot-768`, `screenshot-1440`. One entry per width, or one entry
  whose log lists all three files.
- File names: `<task_id>-<screen>-<state>-<width>.png`, for example `T-0042-list-empty-375.png`.
- If the overlay has no e2e or screenshot command, do not invent one outside `commands`. Add a
  non-blocking question for `cto` ("overlay has no screenshot command") and rely on component tests.
- Browser tools (for example a browser MCP server) may help QA explore. An observation from them
  becomes evidence only when a recorded command reproduces it.

## What each set must show
- Every state the design names: empty, loading, error, populated, and any task-specific state.
- All three widths: 375 (phone), 768 (tablet), 1440 (desktop). No horizontal scroll at 375.
- Real app data from the local run, never the mockup HTML file.

## What reviewers and QA check
- Images come from a recorded run at the head SHA.
- Layout matches the approved mockup in structure, order and states. Pixel equality is not required.
- Text is not clipped, focus is visible, and error messages are readable.
- Contrast and keyboard checks are separate rows in the QA matrix; a screenshot does not prove them.

## Never
- Hand-edited images, images from another branch, or crops that hide part of the screen.
- Screenshots of production or shared environments the overlay does not name.
- Images that contain personal data or secrets. Use seeded local test data.
