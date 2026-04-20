# Flow Tracker

Flow Tracker is a privacy-first Firefox extension for understanding how time is actually spent in the browser. It records active-tab browsing locally, turns that raw stream into sessions, and presents the result through a dark, glassy analytics dashboard focused on clarity rather than noise.

The project is designed around a few principles:

- Everything stays local in `browser.storage.local`.
- Time should be attributed as accurately as possible to the day and domain where it happened.
- Visuals should be readable quickly, not just decorative.
- Projects should be actionable, not just passive buckets.
- Historical data should remain explorable across days and weeks.

## What The Extension Does

At a high level, Flow Tracker:

- Detects the active browser tab while Firefox is focused.
- Converts tab focus into timestamped browsing sessions.
- Splits sessions that cross midnight so each day keeps correct ownership.
- Persists session history by date using a normalized `sessions` structure.
- Lets the user label domains and individual sessions as productive, distracting, neutral, or untagged.
- Aggregates domains into named projects with weekly goals.
- Provides a dedicated project focus timer that can be started from project cards.
- Builds daily, weekly, and rolling 28-day insights from the stored history.

## Architecture Overview

The codebase is split into two main runtime areas:

- `background.js`
  Handles tab tracking, active session management, session finalization, day-boundary splitting, and day-specific data retrieval for the dashboard.

- `dashboard/`
  Contains the dashboard UI and the analytics logic:
  - `dashboard.html`
    Tab layout and card structure.
  - `dashboard.css`
    The dark neon-glass visual system, layout, and chart styling.
  - `dashboard.js`
    Data fetching, rendering, interaction logic, insights generation, project tools, and view state.

## Tracking Model

### Active Tab Detection

Tracking runs in the background script and listens for:

- active tab changes
- tab URL updates
- browser focus changes

The extension tracks time only when:

- a Firefox window is focused
- a tab is active
- the current URL resolves to a domain

If the browser loses focus or there is no valid active tab, the current session is finalized.

### Session Lifecycle

The tracker keeps one in-memory and storage-backed "active session":

- `currentDomain`
- `sessionStartTime`

When the active domain changes:

1. the previous session is finalized
2. the elapsed time is calculated
3. the session is stored
4. a new active session begins for the new domain

### Session Safety Rules

Flow Tracker includes guardrails to keep the dataset usable:

- Sessions shorter than 1 second are ignored.
- Individual sessions are capped at 2 hours (`7200` seconds) to avoid runaway tracking corruption.
- Sessions spanning midnight are split into two stored entries so the daily view remains correct.
- Consecutive records on the same domain with gaps smaller than 3 minutes are stitched back into one continuous session.
- Active sessions keep a rolling `lastSeenAt` heartbeat so shutdown, sleep, or long idle gaps are not accidentally counted as tracked browser time.

### Historical Day Storage

Daily history is stored under date keys in `YYYY-MM-DD` format.

Example conceptual structure:

```json
{
  "2026-03-26": {
    "sessions": [
      {
        "domain": "leetcode.com",
        "start": 1774506600000,
        "end": 1774508400000,
        "duration": 1800
      }
    ]
  }
}
```

### Current Day Format

The extension now uses one normalized day shape:

- `sessions`

Each session can contain:

- `domain`
- `start`
- `end`
- `duration`
- optional `productivityLabel`
- optional `projectFocus`

## Data Integrity And Day Retrieval

One of the most important behaviors in the current implementation is reliable day access.

### Previous Day Access

The dashboard can request data for:

- today
- previous days
- historical days selected through the date navigator

The background script supports both:

- `getLatestData`
- `getDayData`

This matters because viewing older days should not depend on "today-only" logic.

### Ongoing Session Overlap

If a session is still in progress, the background script can project the overlapping slice of that live session into the requested day.

This prevents cases where:

- yesterday appears blank after midnight
- a cross-midnight session seems partially missing
- the selected day does not reflect the currently active session slice

## Dashboard Tabs

The dashboard is divided into five tabs:

- Trends
- Timeline
- Domains
- Projects
- Insights

Each tab answers a different question about browsing behavior.

## Trends Tab

The Trends tab is the weekly digest surface.

### Purpose

It is meant to answer:

- How much time did I spend this week?
- Is this week heavier or lighter than the last?
- Which days carried the most load?
- What changed in my domain mix?

### Components

#### Weekly Digest Header

Shows:

- current week date range
- comparison badge against last week

Rationale:

- gives immediate week-over-week context without making the user inspect multiple charts

#### Weekly Stats

Displays:

- total time
- daily average
- active days
- peak day

Each stat includes a delta against the previous week where meaningful.

Rationale:

- these are the most compact summary metrics for weekly volume and consistency

#### Day By Day

Renders each day of the current week as a relative bar.

What it shows:

- distribution of effort across the week
- which day is today
- which days are still in the future

Rationale:

- users usually care about load distribution, not just weekly totals

#### Top Domains This Week

Lists the top domains of the week and shows:

- rank
- color
- total time
- week-over-week delta

Rationale:

- turns raw browsing into a "what dominated my week?" answer

#### Highlights

Highlights surface a few highly interpretable facts:

- longest session
- peak hour
- new domain this week
- domain that dropped off
- active-day streak

Rationale:

- these give the week more texture than totals alone

## Timeline Tab

The Timeline tab focuses on a single selected day and is intentionally more visual.

### Design Goal

The current timeline avoids the old "barcode of hundreds of tiny slices" problem. Instead, it uses a small set of higher-signal visual blocks.

### Components

#### Time Distribution Summary

This section shows three compact rows:

- Focus
- Distracted
- Neutral

Each row includes:

- a color marker
- the category name
- a small progress fill
- exact duration

Rationale:

- communicates the overall composition of the day quickly without needing a donut score card

#### Hourly Distribution Timeline

The day is broken into 24 hourly columns.

Each hour becomes a block whose internal vertical gradient shows how that hour was composed:

- blue for focused time
- orange for distracted time
- purple for neutral time

Rationale:

- much calmer than a dense session strip
- preserves chronology
- still communicates the category mix inside each hour

#### Hour By Hour Usage Graph

The Timeline tab also includes a dedicated hourly usage graph.

What it shows:

- 24 vertical bars, one for each hour of the selected day
- bar height based on total tracked time in that hour
- stacked color composition inside each bar using the same focused, distracted, and neutral palette
- a short peak-hour summary below the graph

Rationale:

- makes daily rhythm easier to scan than a flat timeline alone
- shows which hours carried the most browser activity
- keeps category context visible without adding another dense table

#### Top Domains Donut

The donut chart shows:

- top 5 domains
- everything else grouped into `Other`
- a fixed, controlled palette so the card stays visually coherent across reloads
- each legend row uses the exact same color as its matching donut slice

It is interactive:

- clicking a legend row highlights that slice
- clicking a donut slice activates the matching legend row and scrolls it into view

Rationale:

- the donut works best as a controlled categorical breakdown
- limiting slices prevents unreadable fragmentation
- the hollow center keeps the card visually lighter without losing categorical clarity

#### Switching Behavior

Shows context switching intensity by hour.

What it shows:

- the busiest switch hours
- total switch count
- the hour of peak turbulence

Rationale:

- raw switch counts are not very explanatory
- hourly switching reveals when attention started to break down

#### Session Quality Cards

The day is grouped into interpreted blocks such as:

- Deep Work
- Distracted
- Quick Check
- Neutral Flow

Each card shows:

- duration
- start and end time
- involved domains
- a short qualitative note like `Low switching` or `Attention drift`

Rationale:

- easier to understand than exposing every micro-session individually

## Domains Tab

The Domains tab is the sortable and editable domain inventory.

### Purpose

It answers:

- Which domains dominate today?
- How often did I visit them?
- How are they classified?
- What happened inside each domain?

### Features

#### Domain Filters

Users can filter the list by:

- All
- Productive
- Neutral
- Distracting
- Untagged

Rationale:

- lets the user quickly isolate the emotional or productivity side of browsing

#### Sorting

The list can be sorted by:

- time spent
- visits

Rationale:

- some users care about attention share, others care about repeated checking behavior

#### Grouping By Effective Label

The renderer aggregates by:

- domain
- effective tag

where the effective tag can come from:

- the session override
- the domain default label
- fallback untagged behavior

Rationale:

- the same domain can serve different roles on different sessions

Each category header also shows the cumulative time for that category on the selected day, such as total productive time, neutral time, distracting time, or untagged time.

Rationale:

- lets the user understand each category’s total weight without manually adding individual domain rows

#### Detail View

Clicking a domain opens a detail surface with:

- today’s total time
- the selected week’s actual total time for that domain
- week visit count
- domain-level default tag controls
- per-session tag overrides

Rationale:

- lets the user correct classification at the right granularity
- gives each domain a real day-vs-week comparison instead of a guessed weekly estimate
- keeps per-session tag edits stable by saving them against the underlying session timestamps

## Projects Tab

Projects turn domains into goal-oriented groupings.

### Core Model

A project is not a separate tracking entity. It is built by mapping one or more domains to a shared project name.

The dashboard then computes:

- all-time project total
- this-week project total
- active days
- day streak
- attached domains
- weekly goal progress

### Project Storage

Project mapping is stored in:

- `projectMappings`

Weekly goals are stored in:

- `projectGoals`

as seconds.

Rationale:

- one canonical mapping key keeps project state consistent and predictable

### New Project Flow

The new project modal supports:

- project name
- domain URL
- weekly goal in hours

The domain is normalized before saving so:

- full URLs
- plain domains
- `www.` variants

resolve into a consistent hostname key.

Rationale:

- avoids duplicate mappings caused by inconsistent domain input

### Project Cards

Each project card shows:

- this week
- all time
- day streak
- weekly goal progress
- attached domains
- on-track or over-budget state
- a collapsible this-week session list

Rationale:

- gives projects both a time-history identity and a planning identity

### Project Goal Editing

The weekly goal is editable from the card, but the control is intentionally subtle.

Instead of a permanent large input and button, the card shows:

- a compact goal chip

Clicking the chip reveals a small inline editor with:

- hours input
- save
- cancel

Rationale:

- weekly goal editing should be available without visually dominating the card

### Project-Specific Focus Mode

The old passive auto-tagging card has been replaced with a project action surface.

#### Focus Mode Card

This card shows:

- the currently active project session, if any
- elapsed time
- a stop control
- a hint when no project session is running

#### Start Session Button

Every project card includes a `Start session` button.

When clicked:

- the project becomes the active focus project
- a dedicated timer begins
- the top focus-mode card updates
- clicking another project switches focus to that project
- clicking the running project button again stops the focus session

Stored key:

- `activeProjectFocus`

While `activeProjectFocus` is running, every tracked browser session is attributed to that project through the session’s `projectFocus` field. This is intentional: the project focus timer is meant to represent "I am working on this project now," not "count only domains already mapped to this project."

Rationale:

- projects should not only summarize work
- they should help the user intentionally enter work

Important note:

- the focus-mode timer is separate from the browser tab tracker
- it represents intentional project focus state, not tab activity replacement

#### Project Session List

Each project card includes a compact `View sessions` control.

When opened, it shows recent sessions from the current week that belong to that project, including:

- date and start time
- a named project block such as `Study Session 1`
- a compact summary of the domains inside that block
- duration

Sessions count toward this list when:

- the session was recorded while that project’s focus timer was active
- the session’s domain is mapped to that project

Rationale:

- lets the user audit what actually contributed to a project total
- presents project work as human-readable work blocks instead of raw individual website rows
- keeps detailed rows hidden until the user asks for them

## Insights Tab

The Insights tab looks across the last 28 days.

### Purpose

It answers:

- What is my broader working rhythm?
- How fragmented is my attention?
- What trends repeat over time?
- What simple recommendations fall out of the data?

### Weekly Heatmap

The heatmap lays out:

- days of week
- 24-hour columns
- intensity of tracked time

Rationale:

- this is the clearest way to spot repeat temporal patterns

### Pattern Cards

Pattern cards summarize:

- focus share
- average session length
- deep-session count
- quick-check count

Rationale:

- these are interpretable metrics that can be compared mentally from week to week

### Anomalies

The anomaly list calls out unusual situations such as:

- today being far above average
- switching being unusually elevated
- distracted share being unusually large

Rationale:

- anomalies draw attention to behavior worth investigating immediately

### Recommendations

Recommendations are simple suggestions derived from the current metrics, such as:

- protect your strongest work hour
- batch low-value quick checks
- improve productive tagging quality
- push one more session beyond a deep-work threshold

Rationale:

- insights should lead to an action, not just a statistic

### Correlations

The correlations grid looks at:

- strongest time of day
- long sessions vs short sessions
- strongest day of week
- most common domain pairing

Rationale:

- gives a broader behavioral fingerprint rather than a single-day snapshot
- turns rolling history into interpretable patterns the user can act on

## Labels And Interpretation Logic

Session interpretation is built on domain and session tagging.

### Available Labels

- productive
- distracting
- neutral
- untagged

Internally, some renderers normalize those into:

- focused
- distracted
- neutral

### How Focus Vs Scattered Is Determined

The app does not store a separate raw `scattered` label. Instead it derives that idea from the stored session labels and switching behavior.

A session is treated as `focused` when:

- it has a session-level `productivityLabel` of `productive` or `focused`, or
- its domain-level default label resolves to `productive` or `focused`

A session is treated as `distracted` or effectively scattered when:

- it has a session-level `productivityLabel` of `distracting` or `distraction`, or
- its domain-level default label resolves to one of those values

A session is treated as `neutral` when:

- no explicit productive or distracting label exists

Insights then interpret scattering from patterns on top of those labels:

- quick checks under 3 minutes suggest fragmented browsing
- elevated context switching suggests scattered attention even when labels are neutral
- longer low-switching focused sessions are interpreted as deeper work

### Domain Detail Stitching

The Domains tab applies one extra presentation rule for revisit behavior:

- if you leave a site and return to that same site in under 3 minutes, the detail view shows that as one grouped visit instead of two separate rows

This keeps the detail list closer to how people experience a quick detour in practice while still summing only the domain’s real tracked duration.

### Why This Exists

Raw browser duration is not enough. Two users can spend the same amount of time on the same site for completely different reasons.

Tagging allows the app to distinguish:

- intentional work
- passive drift
- ambiguous browsing

## Settings And Data Control

The settings modal provides:

- dark mode toggle
- export JSON
- export CSV
- clear history by range

### CSV Export

CSV export writes:

- date
- domain
- start
- end
- duration
- label

If a session has no explicit override, the export falls back to the domain’s default label.

### Clear History

Users can remove:

- last 7 days
- last 30 days
- all time

Rationale:

- gives the user full control over retention without needing external tooling

## Privacy

Flow Tracker is intentionally local-first.

- No analytics are sent to external servers.
- No cloud sync is required.
- No user account is required.
- All tracking data lives in browser local storage.

This choice is central to the product rationale:

- browsing history is sensitive
- attention data is personal
- focus tools should not become surveillance tools

## Notifications

The Settings modal now drives real notification behavior instead of placeholder toggles.

### Budget Alerts

- enabled through `Budget alerts`
- currently notifies when a project reaches or exceeds its weekly goal
- deduplicated per project per week so the same threshold crossing does not spam repeatedly

### Daily Summary

- enabled through `Daily summary`
- scheduled with the selected time in the settings modal
- sends one end-of-day notification with today’s total tracked time and top domain

### Anomaly Alerts

- enabled through `Anomaly alerts`
- notifies when a domain appears for the first time in your recent local history
- also notifies when a domain’s tracked time for today is significantly above its recent baseline

## Visual Design Rationale

The dashboard uses a dark, neon-adjacent glass aesthetic because the extension is meant to feel:

- calm
- premium
- focused
- readable in low-light conditions

The design avoids:

- loud rainbow dashboards
- sterile spreadsheet aesthetics
- default chart-library visual language

Instead it leans on:

- soft borders
- gentle glows
- restrained gradients
- compact typography
- high-contrast value hierarchies

## Current Important Storage Keys

The extension commonly uses these local-storage keys:

- `activeSession`
  Current tracked browser tab session.
  Includes `currentDomain`, `sessionStartTime`, and `lastSeenAt`.
- `activeProjectFocus`
  Current dedicated project focus timer.
- `projectMappings`
  Canonical domain-to-project mapping store.
- `projectGoals`
  Project weekly goals in seconds.
- `notificationPrefs`
  Stores settings for budget alerts, daily summaries, anomaly alerts, and daily summary time.
- `notificationState`
  Keeps track of already-sent summaries and alert deduplication markers.
- `productivityLabels`
  Default domain labels.
- `energyTags`
  Qualitative overrides for grouped session interpretation.
- `YYYY-MM-DD`
  Per-day stored session history.

## Why The Product Is Structured This Way

Flow Tracker is not just a stopwatch for domains.

The app is intentionally split into layers:

- Trends for weekly context
- Timeline for daily narrative
- Domains for classification and correction
- Projects for goal-driven grouping
- Insights for pattern recognition

That separation matters because each question requires a different representation:

- totals for overview
- blocks for chronology
- lists for editability
- projects for accountability
- rolling metrics for habit change

## Summary

Flow Tracker combines accurate browser activity tracking with structured interpretation:

- precise day-aware session storage
- editable domain classification
- project grouping with weekly goals
- actionable project focus timers
- daily visual storytelling
- weekly summaries
- rolling long-term insights

The result is a browser time tracker built not just to record activity, but to help the user understand and steer attention with minimal friction and no cloud dependency.
