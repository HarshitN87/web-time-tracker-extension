# Flow Tracker

A Firefox extension that tracks where your browser time goes, entirely on your own
machine.

Everything lives in `browser.storage.local`. There is no account, no sync, and no
network request of any kind — including for site icons, which are drawn locally as
monograms rather than fetched, because asking a favicon service for an icon would
tell it every domain you visit.

## What it does

- Times the active tab while a Firefox window is focused, pausing when you step away.
- Stores time by day and domain, splitting sessions that cross midnight.
- Lets you label time as productive, neutral, or distracting — with rules that
  depend on context, not just on the domain.
- Groups sites into projects with a weekly goal.
- Offers an opt-in speed bump on sites you choose.

## Structure

```
background.js          tracking, session lifecycle, label resolution, notifications
dashboard/             the main UI (one scope control, two views, a weekly review)
popup/                 current site, live tagging, project timer
content/speedbump.js   the opt-in interstitial, injected only on sites you enable
```

## How time is measured

Tracking runs only when a Firefox window is focused, a tab is active, and the URL
resolves to a domain. Losing focus finalizes the current session.

Guardrails on the stored data:

- Sessions under 1 second are dropped.
- A stored slice is capped at 2 hours. When the cap bites, the record keeps
  `capped: true` and `uncappedDuration`, and the UI marks the total as a floor —
  a long video should not silently lose an hour with no trace.
- Sessions crossing midnight are split so each day owns its own time.
- Same-domain records less than 3 minutes apart are stitched back together for
  display. Durations are summed rather than recomputed from start and end, so the
  gap between two visits is never absorbed as tracked time.
- An active session carries a `lastSeenAt` heartbeat, so sleep and shutdown gaps
  are not counted.

## Data model

History is stored under `YYYY-MM-DD` keys:

```json
{
  "2026-08-01": {
    "sessions": [
      {
        "domain": "leetcode.com",
        "start": 1785600000000,
        "end": 1785601800000,
        "duration": 1800,
        "productivityLabel": "productive",
        "projectFocus": "Interview prep"
      }
    ]
  }
}
```

`productivityLabel` and `projectFocus` are optional. A day compacted by
**Settings → Compact old history** is stored differently — per-domain totals
instead of individual visits:

```json
{
  "2026-01-04": {
    "compacted": true,
    "totals": { "leetcode.com": { "duration": 5400, "visits": 7, "label": "productive" } }
  }
}
```

Totals stay exact after compaction; what goes is the clock time of each visit, so
compacted days are excluded from the rhythm view and marked as such.

### Label rules

A label is not a property of a domain. `youtube.com` is research during a thesis
session and a sink at midnight, so rules carry a condition and the first match wins:

```json
{
  "youtube.com": [
    { "label": "productive",  "when": { "project": "Thesis" } },
    { "label": "distracting", "when": { "fromHour": 22, "toHour": 6 } },
    { "label": "neutral",     "when": {} }
  ]
}
```

A rule with an empty `when` is the domain's default. Conditions available are
`project`, `fromHour`/`toHour` (wrapping past midnight is fine), and `path`.

Resolution order for any given session: an explicitly set label wins, then the
first matching rule, then nothing. **Untagged is not neutral** — it is a gap in the
data, and the dashboard reports it as its own share rather than folding it into a
column.

A rule that depends on the clock, the path, or the active project is frozen onto
the record when the session is saved, because that context is gone afterwards. An
unconditional default is deliberately not frozen, so labelling a site later still
corrects its past sessions.

## The interface

One scope control — **Day / Week / Month / All** — governs every panel. Under it:

- **Home strip**: total, the label split, how much is still untagged, and anything
  outside your normal range.
- **Where the time went**: one ranked list, grouped by label or by project.
  Selecting a row opens the detail drawer: stats, label rules, if-then plan, speed
  bump, and per-visit relabelling.
- **When it happened**: one rhythm chart whose granularity follows the scope —
  24 hourly bars for a day, a 7×24 heatmap for a week, a calendar for a month.
- **Weekly review**: opened deliberately rather than lived in. The digest, the
  untagged inbox, what was unusual, and one question.

### What is deliberately absent

- **No productivity score.** A single composite number destroys the information
  that makes the underlying figures actionable.
- **No cost-of-switching estimate.** The switch count is measured and shown. The
  resumption figures in the literature describe interrupted tasks, not tab
  switches, and cannot be scaled down to a per-switch tax.
- **No streak pressure or leaderboards.** Reward and punishment is the family of
  intervention that most reliably turns a useful tool into a deleted one.
- **The split is marked provisional** when more than 40% of the range is untagged.
  A dashboard that admits what it does not know earns trust for what it asserts.

## Unusual-for-you detection

Deviation is measured against your own trailing 28-day median using the median
absolute deviation, not a fixed multiple of the mean. A site has to clear three
MAD from its own median, with at least 7 days of history and 15 minutes today.

MAD is exactly zero for a perfectly steady series — a site you open for the same
ten minutes daily — which is the case where a spike is most obviously unusual, so
the spread is floored at 15% of the median (minimum 60 seconds) rather than
skipped.

## The speed bump

Off by default. Enabling it for a site requests host access **for that site only**,
at that moment, from the detail drawer. It shows the day's number and your if-then
plan, then lets you through — every time, with no way to fail.

It runs in the top frame only, in a closed shadow root, so nothing the page defines
can reach it and nothing it defines can leak out. Turning it off removes the host
permission and unregisters the script.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | read the active tab's URL to know which domain to time |
| `storage` | keep history and settings locally |
| `idle` | stop the clock when you step away |
| `notifications` | weekly-goal and unusual-for-you alerts, both optional |
| `scripting` | register the speed bump on sites you opt in |
| `*://*/*` (optional) | requested per site, only when you enable a speed bump |

No host permission is granted at install.

## Browser support

Firefox only, deliberately. The manifest uses `background.scripts` and SVG icons,
both of which are Gecko-specific under MV3. A Chrome port would need a
`service_worker`, raster icons, and a different approach to the in-memory session
cache in `background.js`, which cannot survive worker suspension as written.

## Development

Load `manifest.json` via `about:debugging` → This Firefox → Load Temporary Add-on.

There is no build step and no dependencies.
