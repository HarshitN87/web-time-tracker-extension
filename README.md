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
    Data fetching, migration, rendering, interaction logic, insights generation, project tools, and view state.

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

### Legacy Data Migration

Older formats are still recognized. The dashboard and background script both contain migration logic that upgrades legacy shapes such as:

- `chunks`
- `aggregates`

into the current:

- `sessions`

model at read time.

This lets old installs continue working without a hard reset.

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

#### Top Domains Pie

The pie chart shows:

- top 5 domains
- everything else grouped into `Other`

It is interactive:

- clicking a legend row highlights that slice
- clicking the pie cycles the active slice
- the center label updates to show the selected domain and share

Rationale:

- the pie works best as a controlled categorical breakdown
- limiting slices prevents unreadable fragmentation

#### 3D Pie Aesthetic

The chart is styled to feel dimensional through:

- gloss overlays
- shadow depth
- slight tilt and scale on interaction
- under-shadow beneath the chart body

Rationale:

- keeps the chart aligned with the extension’s current neon/dark aesthetic instead of feeling flat

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

#### Detail View

Clicking a domain opens a detail surface with:

- today’s total time
- proxy weekly time
- session count
- domain-level default tag controls
- per-session tag overrides

Rationale:

- lets the user correct classification at the right granularity

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

and also mirrored to:

- `projectsMap`

for compatibility with earlier inconsistent saves.

Weekly goals are stored in:

- `projectGoals`

as seconds.

Rationale:

- compatibility storage prevents existing users from losing project definitions

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

Rationale:

- projects should not only summarize work
- they should help the user intentionally enter work

Important note:

- the focus-mode timer is separate from the browser tab tracker
- it represents intentional project focus state, not tab activity replacement

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
- `activeProjectFocus`
  Current dedicated project focus timer.
- `projectMappings`
  Canonical domain-to-project mapping store.
- `projectsMap`
  Legacy compatibility mirror for project mappings.
- `projectGoals`
  Project weekly goals in seconds.
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
