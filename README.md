# LaundryLink (WashQ)

Real-time washing machine availability for hostel students — a clean, minimal,
self-contained utility web app. No backend, no database: state lives in
`localStorage` and all timers are `Date`-based, so everything survives reloads
and background tabs.

## Features

- **Live machine dashboard** — 15 machines with `Free` / `Busy — XX min left`
  (live countdown) / `Cycle Complete — Collect Now` (pulsing) badges, progress
  bars, and a "show only free machines" filter.
- **OTP reserve & unlock** — on a free machine, *Reserve & Start* generates a
  4-digit OTP shown on screen; the wash (and timer) only starts after the code
  is re-entered, simulating entry on the machine's physical keypad. Two wrong
  attempts require generating a new code.
- **Slot booking with no-show protection** — book a future time slot
  (start time + 30/40/60 min). At slot start a popup asks *"Are you going to
  use Machine X now?"* with a 10-minute countdown; confirming proceeds to the
  OTP flow, no response releases the slot and notifies the waiting queue.
- **"Notify me when free" queue** — FIFO line on busy machines with position
  and count; the head of the line is notified when a machine frees up.
- **Machine Setup (admin)** — gear icon in the header: generate a unique QR
  code for a new machine (`/machine/{id}`), download it as SVG, and manage all
  machines (open / download / delete). Replaces the old static QR listing page.
- **Usage analytics** — washes today/this week, peak hour, and a
  "usage by hour of day" bar chart.
- **Grace period** — after a cycle completes, a 10-minute collect window with
  reminder banner, then the machine auto-reverts to free.
- **Dark mode** — true-dark theme with a sun/moon toggle, persisted per device.
- **Machine 1 has a live sensor** label (physical machine); 2–15 are simulated.

## Run it

```bash
node server.js          # serves on http://localhost:3000 (PORT env to change)
```

No dependencies to install — everything (including the QR library) is vendored.

## Routes

| Route            | Page                                        |
| ---------------- | ------------------------------------------- |
| `/`              | Machine dashboard                           |
| `/machine/:id`   | Machine detail (target of scanned QR codes) |
| `/setup`         | Machine Setup (admin, QR generation)        |
| `/analytics`     | Usage analytics (admin)                     |

`server.js` is a small static server with SPA history fallback, so deep links
like `/machine/3` work on refresh and when scanned from a QR code.

## Project structure

```
index.html        # app shell (header, nav, banner, modal/toast roots)
styles.css        # Material-inspired light/dark theming
app.js            # state, timers, router, OTP, booking, notifications, charts
server.js         # dependency-free static server with history fallback
vendor/qrcode.js  # MIT QR code generator (offline)
```
