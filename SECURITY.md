# Security & privacy design

This extension handles a logged-in social account and, optionally, an API key. These are the rules the code follows.

## Threat model

- **No backend.** There is no server, no analytics, no telemetry, no crash reporting. Nothing leaves the browser except
  (a) the user's own clicks on x.com and (b) bios the user explicitly chooses to send to Anthropic with their own key.
- **Least privilege.** Host access is limited to `x.com` / `twitter.com`. `api.anthropic.com` is an *optional* host
  permission requested only when the user enables AI labelling. No `tabs`, `history`, `cookies` or `<all_urls>`.
- **Secrets stay local.** The Anthropic key is stored in `chrome.storage.local` (never `sync`), is only ever sent from
  the extension's service worker to `api.anthropic.com`, is masked in the UI, and is never logged.
- **No X credentials.** The extension never reads cookies, tokens or passwords. It drives X's own UI inside the user's
  logged-in tab, exactly as the user could by hand, and never calls X's private API.
- **User-initiated, reversible-where-possible actions.** Every destructive action requires an explicit click, has a
  5-second undo, and bulk actions require a confirmation with a preview-only mode. A per-hour cap and randomised
  pacing protect the account; the queue pauses itself on any rate-limit response.
- **Content is data, not instructions.** Bios and names scraped from X are rendered with HTML escaping and passed to
  the model as JSON data inside a fixed prompt with a strict output schema (an enum of label ids), so a hostile bio
  cannot inject markup into the panel or steer the classifier outside the allowed labels.
- **Minimal data retention.** Only public profile fields are stored, locally, and the user can delete everything from
  Options in one click or by uninstalling.

## Code hygiene

- TypeScript `strict` with `noUncheckedIndexedAccess`; no `eval`, no remote code, CSP-compatible module scripts (MV3).
- All X DOM selectors live in one file (`src/content/selectors.ts`) so a layout change is a one-file fix, and a
  failed selector produces a visible, named error rather than a silent wrong action.
- Unit tests cover the keyword matcher, bot scoring, scan diffing, queue reducer and request building.

## Reporting

Please open a GitHub issue for anything that looks like a security or privacy problem. Do not include your API key
or account details in the report.
