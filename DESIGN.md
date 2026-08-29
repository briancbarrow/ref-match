# Ref Match — design

An on-wrist match-control app for soccer referees: time, score, cards,
substitutions and sin bins, with a match summary exported to the phone.

Scope note: this is deliberately *not* a RefSix clone. Career trends, video
analysis, heatmaps and cloud sync are phone/backend products. This is the part
a Pebble is genuinely good at — glanceable time and one-press event capture,
driven by buttons and vibration rather than a touchscreen.

Sibling project: `ref-timer`, a plain count-down/stoppage timer for coaching.
That one stays simple and stable; this one is where the complexity goes.

## Constraints that shape everything

- **Four buttons, no touchscreen.** Every interaction is scroll-and-confirm.
- **~130KB free heap** (measured on emery). No large in-memory tracks.
- **Mods cannot contain native code.** Limited to modules the host firmware
  exposes: `pebble/button`, `pebble/vibes`, `pebble/wakeup`, `pebble/message`,
  `embedded:sensor/*`, `device.keyValue`, `device.files`.
- **The app gets killed when another app opens.** A referee will check a
  notification mid-match. State must survive that.
- **Fonts resolve on exact family+size pairs** or throw at runtime.

## State

Two layers, changing for different reasons and persisted differently.

### Match state (domain, persisted)

```js
match = {
  config:  { periods: 2, periodMinutes: 45, sinBinMinutes: 10, breakMinutes: 10 },
  period:  1,
  clock:   { periodStartedAt, pausedTotal, pausedAt, breakStartedAt },
  events:  [ { t, type, team, reason } ],          // player only on sub/bin
  sinBins: [ { team, player, wakeupId, returnAt } ]
}
```

**Events are the source of truth.** Score is derived by folding `events`, never
stored separately. One decision buys undo, the match report, and correct
recovery after a kill.

### Clock

Derive from wall clock, never from a decrementing counter:

```js
elapsed = (now - periodStartedAt - pausedTotal) / 1000
```

A counter is wrong the moment the app is killed and relaunched. Alert flags are
`firedAt` timestamps rather than booleans, for the same reason.

**Snap every moment the clock is built from to a whole second.** Deriving from
wall time is necessary but not sufficient: with a raw `Date.now()` start, the
displayed value flips at `periodStartedAt % 1000` past each wall second, an
arbitrary offset no redraw can be aligned to. `resume()` folding a fractional
pause into `pausedTotal` then moved it again. Against a scoreboard that reads as
up to a second out, wandering during the half and mysteriously improving after a
pause — which is what a referee actually reports.

With `periodStartedAt` and `pausedTotal` both exact multiples of 1000ms, the
clock's own second boundary *is* the RTC second boundary.

**Drive the redraw from `watch.addEventListener("secondchange", ...)`**, the
firmware's `tick_timer_service`. It fires just after each RTC second and
recomputes its delay from `Date.now() % 1000` every time, so it cannot
accumulate drift. `setInterval(tick, 1000)` could not: it counts from app launch
and never re-aligns. pebble-timer-plus reaches the same place from the other
direction, re-arming an `AppTimer` for `value_ms % 1000` on every tick.

Measured on the emulator: the tick lands at `Date.now() % 1000 == 50` on 38 of
39 consecutive seconds (51 on the other), across a pause and resume, with the
snapped remainders staying at zero.

### UI state (navigation, not persisted)

```
SETUP ──SEL──▶ RUNNING ◀──SEL──▶ PAUSED
                 │ ▲
                 │ │ auto at 0:00 → end vibe, clock continues
             BACK│ │      counting into stoppage
                 ▼ │
             confirm ──▶ INTERVAL ──SEL──▶ RUNNING (next period)
                    └──▶ SUMMARY   (no periods left, or abandoned)
```

The design had a separate ENDED state between the whistle and the interval.
It was dropped: it showed the referee nothing the interval screen does not,
and cost a press to get through.

Pickers push modally on top of `RUNNING`/`PAUSED`.

**The clock never stops for data entry.** Every other decision bends around
this rule.

## Buttons

Give the two most frequent events dedicated buttons rather than burying them
in a menu. Recognizers available: `single`, `long`, `multi`, `raw`.

| Button      | Main clock screen            |
|-------------|------------------------------|
| SELECT      | Pause / resume               |
| SELECT long | Action menu                  |
| UP          | Goal → team                  |
| DOWN        | Card → team → reason         |
| BACK        | End period / abandon         |

BACK is a plain press rather than a hold, because a hold is not available: the
button module rejects a `long` recognizer on BACK, and a `raw` subscription on
BACK is remapped to a synthesised single click, so there is nothing to time. It
opens a confirm screen defaulting to No, which is what a hold was guarding
against anyway. BACK has no other job on this screen.

In every picker: UP/DOWN move, SELECT confirm, BACK cancel.

Goals and cards do not ask for a shirt number: numbers run high, and cycling
one up costs more attention than a referee has while the clock runs. Subs and
sin bins still ask, because both need to know which player.

The player-number picker uses `SingleRecognizerOptions.repeat` so holding
scrolls 0–99 at speed.

Action menu: `Goal · Card · Sub · Sin bin · Undo last · End period · Abandon`.

## Screens

1. Setup — periods, period length, sin-bin length
2. Clock (main)
3. Action menu
4. Team picker
5. Player number picker (sub, sin bin)
6. Reason picker
7. Sin-bin status
8. Match summary

## Sin bins

The feature Pebble does genuinely well:

```
Sin bin → team → player → duration
  → id = Wakeup.schedule(returnAt, cookie, true)
  → on fire: distinct vibe + "#7 may return"
```

`notifyIfMissed: true` means it still fires if the app was closed.

## Vibration vocabulary

| Event             | Pattern                                    |
|-------------------|--------------------------------------------|
| 2:00 remaining    | `doublePulse()`                            |
| 0:30 remaining    | `pattern([200,120,200,120,200])`           |
| Period end        | `pattern([600,250,600,250,600,250,1000])`  |
| Break over        | `pattern([500,300,500])`                   |
| Sin bin expired   | four fast taps                             |
| Paused, every 10s | `shortPulse()`                             |

Five is the ceiling for what stays distinguishable through a sleeve in the
cold. Past that people stop trusting the difference and look at the watch,
which defeats the purpose.

Break over is a deliberate sixth, and it is affordable because the ceiling is
really about how many can be confused *with each other at the same moment*. It
only fires on the interval screen, and none of the match alerts can fire there.
The one pattern it has to be told apart from is a sin bin expiring, which is
four fast taps against two long pulses.

## The interval break

Half time is variable in a way period length is not — youth fixtures,
tournament schedules, whatever the officials agree on at the time — so it is
set on the interval screen and remembered, rather than being a fourth setup
question answered before anyone knows the answer.

Started by a press rather than automatically at the whistle. The referee is
usually still on the field when a half ends, and a countdown that began without
being asked is one they then have to correct.

Never paused. A break clock that stops when the watch is not being looked at
measures the wrong thing; the match clock pauses because play stops, and a
break has no equivalent.

SELECT carries both jobs without a hold, because they cannot both apply at
once: it starts the break, and once one is running it starts the next period.
`breakMinutes: 0` means OFF, which restores the single press the screen took
before the break existed.

## Persistence

Write to `device.keyValue` on **every event**, not on a timer. On launch, if
`match:current` exists and is not ended, offer **Resume**.

## Phone export

Match summary over AppMessage (`pebble/message`) to PebbleKit JS. Watch holds
the match; the phone holds history. Nothing on the watch depends on the phone
being present.

The history leaves the phone through the settings page (`config/index.html`),
which renders the stored reports as markdown and saves a `.md` through the
phone's share sheet. The reports reach the page in the URL fragment rather than
through an upload: a fragment is not sent to the server, so the export needs no
backend, no account and no trust in whoever hosts the page. Both ends carry a
hand-written base64url codec because neither runtime has `btoa`.

The page decodes the single-letter event types itself. That is a duplicated
constant — the numbering in `match.js` is the source of truth, and a change
there has to be mirrored in the page's `describe()`.

## Open questions

- Period length presets vs. free entry — youth matches vary a lot.
- Whether added time is tracked separately or inferred from the stoppage count.
- Two-referee mode: is the second whistle worth syncing to, or out of scope?
- Battery cost of a 90-minute foreground session with 1s redraws. Measure
  before committing to the redraw cadence.
