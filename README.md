# X Follower Filter

![CI](https://github.com/saumya-st/x-follower-filter/actions/workflows/ci.yml/badge.svg)

Chrome extension (Manifest V3) that scans your X / Twitter **followers** and **following** lists, groups accounts by keywords in their bio (tech, crypto, marketing, memes, news, spam…), optionally asks Claude to label the rest, and lets you review and then **remove followers** or **unfollow** the ones you pick, one at a time with human-like pacing.

Nothing leaves your browser except, optionally, bios you choose to send to Anthropic with your own API key.

## Develop

```bash
npm install
npm run build        # one-off build to dist/
npm run watch        # rebuild on change
npm run typecheck
npm test
npm run zip          # dist/ -> release/x-follower-filter-<version>.zip for the Web Store
```

Load it: `chrome://extensions` → Developer mode → **Load unpacked** → pick the `dist/` folder. Open x.com, click the extension icon to open the side panel.

## How it works

| Piece | File | Job |
|---|---|---|
| Selectors | `src/content/selectors.ts` | Every X DOM selector. Fix here when X changes its markup. |
| Scraper | `src/content/scraper.ts` | Auto-scrolls a followers/following page and parses each user cell. |
| Actions | `src/content/actions.ts` | Performs one Remove-follower / Unfollow on the profile page that is loaded (clicks X's own menu + confirm). |
| Worker | `src/background/worker.ts` | Hidden background tab + queue loop with pacing, hourly cap and keepalive. |
| Scoring | `src/shared/score.ts`, `src/shared/history.ts` | Bot-likelihood score; scan-to-scan diffs (new / unfollowed / non-mutuals). |
| Rules | `src/shared/rules.ts` | Keyword matcher (word boundaries, unicode folding) and free-text search. |
| Claude | `src/background/claude.ts` | Batched bio classification with structured output. |
| Service worker | `src/background/service-worker.ts` | Message router, snapshot storage, scan diffing, AI run. |
| Panel | `src/ui/panel/` | Side panel: onboarding, scan, quick views + filter drawer, one-click remove with undo, selection bar, queue strip, Changes dashboard, built-in help. |
| Options | `src/ui/options/` | Labels, API key, pacing, protected accounts. |

Flow: **Scan** → narrow the list with a **Quick view** (Likely bots, Spam, Crypto…) or the **Filters** drawer (categories + traits + search) → click **Remove** on a row (5 s Undo), or tick rows and use the action bar at the bottom → items go to a queue that a hidden background x.com tab works through, one profile at a time. Your own tab is never touched. The **Changes** tab is a small dashboard: new followers, who unfollowed you, who does not follow back, and who you don't follow back. The **?** button in the panel explains all of this in-app.

## Safety notes

- Single-row actions have a 5 s Undo. Bulk actions confirm first and offer a Preview-only mode.
- Pacing defaults to 4–9 s between actions and 60 actions per hour (Options); the queue pauses itself when the cap is reached and resumes automatically. X rate-limits aggressive accounts; the queue also pauses when X shows a rate-limit or error toast.
- Protected accounts (Options) are never touched.
- X's terms restrict automation. This is a personal tool that drives X's own UI on your own account; use it at your own risk.

## Security & privacy

No backend, no telemetry, least-privilege permissions, API key kept in local extension storage and only ever sent to Anthropic, no use of X's private API. Full design notes in [SECURITY.md](SECURITY.md) and the user-facing [privacy policy](public/PRIVACY.html).

## Publishing checklist

- Bump `version` in `package.json` and `public/manifest.json`.
- `npm run zip`, upload `release/*.zip`.
- Listing: screenshots of the panel, the privacy policy (`dist/PRIVACY.html`, also host it somewhere public and link it in the listing), and a clear note that the tool clicks X's own menus in a background tab, with undo and preview.
- Permission justifications: `x.com`/`twitter.com` (read lists, click menus), `storage`, `sidePanel`, `activeTab`, optional `api.anthropic.com` (AI labelling with the user's own key).
