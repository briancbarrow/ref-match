// Match state: the domain layer. Knows nothing about drawing or buttons.
//
// Events are the source of truth. The score is folded out of `events` rather
// than stored, so undo, the match report and recovery after the app is killed
// all fall out of one list instead of three code paths that can disagree.

import Wakeup from "pebble/wakeup";
// `device` is a host global (globalThis.device); importing it is blocked.

export const HOME = 0;
export const AWAY = 1;
export const TEAM_NAMES = ["HOME", "AWAY"];
export const TEAM_INITIALS = ["H", "A"];

// Phases. Numbers rather than strings: they go through JSON on every event.
export const SETUP = 0;
export const RUNNING = 1;
export const PAUSED = 2;
export const INTERVAL = 3;
export const SUMMARY = 4;

// Event types, single letters to keep the persisted JSON small.
export const GOAL = "G";
export const CARD = "C";
export const SUB = "S";
export const BIN = "B";
export const PERIOD_END = "P";

export const CARD_KINDS = ["Yellow", "2nd yellow", "Red"];
export const CARD_SHORT = ["YEL", "2YEL", "RED"];

export const WARN_SECONDS = 120;
export const FINAL_WARN_SECONDS = 30;

// A real match produces a few dozen events. The cap exists so a stuck button
// cannot grow the persisted blob past the 8KB settings file and start failing
// saves mid-match. Past it we refuse new events rather than dropping old ones:
// dropping an old goal would silently change the score.
const MAX_EVENTS = 150;
const STATE_KEY = "match";

let store;
try {
	store = device.keyValue.open({ path: "refmatch", format: "string" });
}
catch {
	store = undefined;
}

export const match = {
	config: { periods: 2, periodMinutes: 45, sinBinMinutes: 10 },
	period: 1,
	phase: SETUP,
	clock: { periodStartedAt: 0, pausedTotal: 0, pausedAt: 0 },
	events: [],
	sinBins: [],
	// firedAt timestamps, not booleans: a boolean is a lie after a relaunch.
	// 1 is the "suppressed" sentinel for an alert the period starts below.
	fired: { warn: 0, final: 0, end: 0 },
	abandoned: false
};

export function periodSeconds() {
	return match.config.periodMinutes * 60;
}

// Every moment the clock is built from is snapped to a whole second, so
// periodStartedAt and pausedTotal are always exact multiples of 1000ms. That
// makes the match clock's own second boundary land on the RTC second boundary,
// which is the edge the firmware's "secondchange" event fires just after and
// the edge a scoreboard operator's stopwatch ticks on.
//
// Without this the boundary sat at `periodStartedAt % 1000` past each wall
// second -- an arbitrary offset that the redraw could not be aligned to, and
// that moved again on every pause because resume() folded a fractional number
// of milliseconds into pausedTotal. That is the whole of the "sometimes faster,
// sometimes slower, but fine once I have paused it once" drift.
function snapped(ms = Date.now()) {
	return Math.round(ms / 1000) * 1000;
}

// Derived from wall time, never from a decrementing counter: setInterval
// drifts, and a counter is simply wrong after the app is killed and relaunched.
export function elapsedInPeriod() {
	const { periodStartedAt, pausedTotal, pausedAt } = match.clock;
	if (!periodStartedAt)
		return 0;
	const frozen = pausedAt ? pausedAt : Date.now();
	return Math.floor((frozen - periodStartedAt - pausedTotal) / 1000);
}

export function remainingInPeriod() {
	if (!match.clock.periodStartedAt)
		return periodSeconds();
	return periodSeconds() - elapsedInPeriod();
}

// Match minute for the event log: earlier periods count in full, so a goal in
// the 67th minute reads 67' even though the period clock shows 22:00.
export function matchSeconds() {
	return (match.period - 1) * periodSeconds() + elapsedInPeriod();
}

export function score() {
	const goals = [0, 0];
	for (const e of match.events) {
		if (GOAL === e.type)
			goals[e.team]++;
	}
	return goals;
}

export function cardCount(team, kind) {
	let n = 0;
	for (const e of match.events) {
		if (CARD === e.type && e.team === team && (undefined === kind || e.kind === kind))
			n++;
	}
	return n;
}

export function addEvent(event) {
	if (match.events.length >= MAX_EVENTS) {
		console.log("event log full, refusing new event");
		return undefined;
	}
	const recorded = { t: matchSeconds(), p: match.period, ...event };
	match.events.push(recorded);
	save();
	return recorded;
}

// Undo only reaches the most recent event, and never crosses a period end.
// Reaching further back would let a mis-press in the 80th minute delete
// something from the first half without the referee seeing what went.
export function undoLast() {
	const last = match.events[match.events.length - 1];
	if (!last || PERIOD_END === last.type)
		return undefined;

	match.events.pop();
	if (BIN === last.type)
		removeSinBin(last.team, last.player);
	save();
	return last;
}

export function startPeriod() {
	match.phase = RUNNING;
	match.clock = { periodStartedAt: snapped(), pausedTotal: 0, pausedAt: 0 };
	// Don't arm an alert for a period that starts at or below its own trigger:
	// a 1-minute period should skip the two-minute warning, not fire it at once.
	const length = periodSeconds();
	match.fired = {
		warn: length <= WARN_SECONDS ? 1 : 0,
		final: length <= FINAL_WARN_SECONDS ? 1 : 0,
		end: 0
	};
	save();
}

export function pause() {
	if (RUNNING !== match.phase)
		return;
	match.phase = PAUSED;
	match.clock.pausedAt = snapped();
	save();
}

export function resume() {
	if (PAUSED !== match.phase)
		return;
	match.phase = RUNNING;
	match.clock.pausedTotal += snapped() - match.clock.pausedAt;
	match.clock.pausedAt = 0;
	save();
}

export function endPeriod() {
	// Record before freezing the clock so the event carries the real minute.
	addEvent({ type: PERIOD_END });
	if (!match.clock.pausedAt)
		match.clock.pausedAt = snapped();
	match.phase = match.period < match.config.periods ? INTERVAL : SUMMARY;
	if (SUMMARY === match.phase)
		cancelAllSinBins();
	save();
}

export function nextPeriod() {
	if (match.period >= match.config.periods)
		return;
	match.period++;
	startPeriod();
}

export function abandon() {
	match.abandoned = true;
	if (!match.clock.pausedAt)
		match.clock.pausedAt = snapped();
	match.phase = SUMMARY;
	cancelAllSinBins();
	save();
}

// --- Sin bins -------------------------------------------------------------
//
// Wakeup is wall-clock only, so a sin bin runs on wall time even when the match
// clock is stopped. That matches the codes that specify "10 minutes" plainly,
// and it is the only thing the firmware can actually schedule.

function sinBinCookie(team, player) {
	return team * 100 + player;
}

export function addSinBin(team, player, minutes) {
	const returnAt = Date.now() + minutes * 60000;
	let wakeupId = -1;
	try {
		// notifyIfMissed: the alert still reaches the referee if the watch has
		// moved on to another app by the time the bin expires.
		wakeupId = Wakeup.schedule(returnAt, sinBinCookie(team, player), true);
	}
	catch {
		wakeupId = -1;
	}

	match.sinBins.push({ team, player, wakeupId, returnAt, alerted: false });
	addEvent({ type: BIN, team, player, minutes });

	// A negative id means the firmware refused — too soon, or too many wakeups
	// pending across all apps. The in-app timer still expires the bin; only the
	// alert-while-closed is lost, so report it rather than failing the bin.
	return wakeupId >= 0;
}

export function activeSinBins(now = Date.now()) {
	return match.sinBins.filter(b => b.returnAt > now);
}

export function dueSinBins(now = Date.now()) {
	return match.sinBins.filter(b => b.returnAt <= now);
}

export function removeSinBin(team, player) {
	const index = match.sinBins.findIndex(b => b.team === team && b.player === player);
	if (index < 0)
		return undefined;

	const [bin] = match.sinBins.splice(index, 1);
	if (bin.wakeupId >= 0) {
		try {
			Wakeup.cancel(bin.wakeupId);
		}
		catch {
			// Already fired or already gone; nothing to clean up.
		}
	}
	save();
	return bin;
}

export function sinBinByCookie(cookie) {
	return match.sinBins.find(b => sinBinCookie(b.team, b.player) === cookie);
}

function cancelAllSinBins() {
	for (const bin of match.sinBins) {
		if (bin.wakeupId >= 0) {
			try {
				Wakeup.cancel(bin.wakeupId);
			}
			catch {
			}
		}
	}
	match.sinBins.length = 0;
}

// --- Persistence ----------------------------------------------------------
//
// Written on every event rather than on a timer: a timer loses whatever
// happened since its last tick, and the thing it loses is a goal.

export function save() {
	if (!store)
		return;
	try {
		store.write(STATE_KEY, JSON.stringify(match));
	}
	catch {
		// Best effort: a failed save must never take the clock down mid-match.
	}
}

export function restore() {
	if (!store)
		return false;

	let saved;
	try {
		saved = JSON.parse(store.read(STATE_KEY));
	}
	catch {
		return false;
	}
	if (!saved || SETUP === saved.phase)
		return false;

	Object.assign(match, saved);

	// A match written by a build that did not snap the clock carries a
	// fractional offset. Re-snapping moves the elapsed time by under half a
	// second, which nobody can see, and buys back the phase lock for the rest
	// of the match rather than only from the next period on.
	match.clock.periodStartedAt = snapped(match.clock.periodStartedAt);
	match.clock.pausedTotal = snapped(match.clock.pausedTotal);
	if (match.clock.pausedAt)
		match.clock.pausedAt = snapped(match.clock.pausedAt);

	return true;
}

export function reset() {
	cancelAllSinBins();
	Object.assign(match, {
		period: 1,
		phase: SETUP,
		clock: { periodStartedAt: 0, pausedTotal: 0, pausedAt: 0 },
		events: [],
		sinBins: [],
		fired: { warn: 0, final: 0, end: 0 },
		abandoned: false
	});
	try {
		store?.delete(STATE_KEY);
	}
	catch {
	}
}

// --- Formatting -----------------------------------------------------------

export function formatClock(seconds) {
	const total = Math.abs(Math.trunc(seconds));
	const minutes = Math.floor(total / 60);
	const secs = total % 60;
	return `${minutes}:${secs < 10 ? "0" : ""}${secs}`;
}

export function matchMinute(seconds) {
	// Referees count the minute in progress: 0:05 is the 1st minute.
	return Math.floor(seconds / 60) + 1;
}

export function describeEvent(e) {
	const when = `${matchMinute(e.t)}'`;
	const team = TEAM_INITIALS[e.team];
	switch (e.type) {
		case GOAL:
			return `${when} GOAL ${team} #${e.player}`;
		case CARD:
			return `${when} ${CARD_SHORT[e.kind]} ${team} #${e.player}`;
		case SUB:
			return `${when} SUB ${team} ${e.player}>${e.playerOn}`;
		case BIN:
			return `${when} BIN ${team} #${e.player}`;
		case PERIOD_END:
			return `${when} END P${e.p}`;
		default:
			return `${when} ?`;
	}
}

// Compact report for the phone. Deliberately not a rich object graph: the
// watch holds the match, the phone holds history, and the link is narrow.
export function report() {
	const [home, away] = score();
	return {
		v: 1,
		at: Date.now(),
		config: match.config,
		periodsPlayed: match.period,
		score: { home, away },
		abandoned: match.abandoned,
		events: match.events
	};
}
