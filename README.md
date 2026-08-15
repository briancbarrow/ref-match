# Ref Match

On-wrist match control for soccer referees: time, score, cards, substitutions
and sin bins, with a match summary exported to the phone.

Built as a Pebble Alloy project — embedded JavaScript on the watch, powered by
Moddable XS. See [DESIGN.md](DESIGN.md) for the reasoning behind the design.

Sibling project: `ref-timer`, a plain count-down/stoppage timer for coaching.

## Using it

Setup asks three questions — periods, period length, sin-bin length — then the
clock starts.

| Button      | Clock screen                  | Menus and pickers      |
|-------------|-------------------------------|------------------------|
| UP          | Goal                          | Move up                |
| DOWN        | Card                          | Move down              |
| SELECT      | Pause / resume                | Confirm                |
| SELECT hold | Action menu                   | —                      |
| BACK        | End period (asks first)       | Cancel one step        |

The action menu carries everything: `Goal · Card · Substitution · Sin bin ·
Sin bin status · Undo last · End period · Abandon match · Exit`.

Exiting from the menu is safe. The match is on flash after every event, and
relaunching offers to resume it.

**The clock never stops for data entry.** Pickers open on top of the clock and
it keeps running underneath — recording a goal never costs match time.

## Alerts

| Moment            | Vibration                          |
|-------------------|------------------------------------|
| 2:00 remaining    | two pulses                         |
| 0:30 remaining    | three quick taps                    |
| End of period     | three long bursts, then a held one |
| Sin bin expired   | four fast taps                     |
| While paused      | a short pulse every 10 seconds     |

Five patterns is the ceiling for what stays distinguishable through a sleeve in
the cold. Each alert fires once, and each is armed only if the period actually
starts above its trigger.

At 0:00 the clock does not stop. The status line turns red and reads STOPPAGE,
and the time counts up so you can see how far past regulation you are. The
period ends when you end it.

## Sin bins

A sin bin schedules a firmware wakeup with `notifyIfMissed`, so the alert still
reaches you if the watch has moved on to another app. Sin bins run on wall
time, not match time — that is the only thing the firmware can schedule, and it
matches the codes that specify a plain "10 minutes".

`Sin bin status` lists who is off with a live countdown, and SELECT releases a
player early.

## Phone export

From the match summary: `SEL → Send to phone`. The report goes over AppMessage
in chunks and PebbleKit JS reassembles it into `localStorage.matches`.

The watch holds the match; the phone holds history. Nothing on the watch
depends on the phone being present — if the link is down, the send stalls and
says so, and the match is unaffected.

## Building and running

```sh
pebble build                          # build for all targetPlatforms
pebble install --emulator emery       # run on the emery emulator
pebble install --cloudpebble          # install to your watch
```

Installing to hardware goes through CloudPebble: enable Dev Connect in the
Pebble app (Devices → ⋯ → Enable Dev Connect, sign in with GitHub), then
`pebble login` on your machine so both ends share an account.

Useful while testing:

```sh
pebble emu-button click select                    # press a button
pebble emu-button click select --duration 800     # hold it (action menu)
pebble screenshot --emulator emery shot.png       # capture the screen
pebble install --emulator emery --logs            # install and tail the log
```

Only one tool may hold the emulator connection at a time. Running `pebble logs`
alongside `pebble install` leaves both wedged, and the fix is to kill the
orphaned processes and reinstall.

## Platform notes

Four things about this firmware shaped the implementation, all of them found
the hard way:

- **BACK cannot be held.** The button module rejects a `long` recognizer on
  BACK outright, and a `raw` subscription on BACK is remapped to a synthesised
  single click, so there is no hold to measure. "End period" is a plain BACK
  press into a confirm screen instead.
- **The default XS machine is too small for this app**, and it fails as an
  `fxAbort` during mod load rather than as an error you can catch. `src/c/mdbl.c`
  asks for a bigger one. All three of stack/slot/chunk must be set together or
  the record is rejected and the failing defaults are used.
- **Creating a `Button` re-arms the window's click recognizers.** Swapping
  button sets inside a button handler delivers the in-flight release to the
  screen that just appeared, so screen changes are deferred by one tick.
- **AppMessage's default buffers ask for 8200 bytes each** and the app faults
  outright if that is not there. The export asks for what it needs.
