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
  config:  { periods: 2, periodMinutes: 45, sinBinMinutes: 10 },
  period:  1,
  clock:   { periodStartedAt, pausedTotal, pausedAt },
  events:  [ { t, type, team, player, reason } ],
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
| UP          | Goal → team → scorer         |
| DOWN        | Card → team → player → reason|
| BACK        | End period / abandon         |

BACK is a plain press rather than a hold, because a hold is not available: the
button module rejects a `long` recognizer on BACK, and a `raw` subscription on
BACK is remapped to a synthesised single click, so there is nothing to time. It
opens a confirm screen defaulting to No, which is what a hold was guarding
against anyway. BACK has no other job on this screen.

In every picker: UP/DOWN move, SELECT confirm, BACK cancel.

The player-number picker uses `SingleRecognizerOptions.repeat` so holding
scrolls 0–99 at speed.

Action menu: `Goal · Card · Sub · Sin bin · Undo last · End period · Abandon`.

## Screens

1. Setup — periods, period length, sin-bin length
2. Clock (main)
3. Action menu
4. Team picker
5. Player number picker
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
| Sin bin expired   | four fast taps                             |
| Paused, every 10s | `shortPulse()`                             |

Five is the ceiling for what stays distinguishable through a sleeve in the
cold. Past that people stop trusting the difference and look at the watch,
which defeats the purpose.

## Persistence

Write to `device.keyValue` on **every event**, not on a timer. On launch, if
`match:current` exists and is not ended, offer **Resume**.

## Phone export

Match summary over AppMessage (`pebble/message`) to PebbleKit JS. Watch holds
the match; the phone holds history. Nothing on the watch depends on the phone
being present.

## Open questions

- Period length presets vs. free entry — youth matches vary a lot.
- Whether added time is tracked separately or inferred from the stoppage count.
- Two-referee mode: is the second whistle worth syncing to, or out of scope?
- Battery cost of a 90-minute foreground session with 1s redraws. Measure
  before committing to the redraw cadence.
