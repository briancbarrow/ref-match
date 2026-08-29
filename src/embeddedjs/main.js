// Ref Match — on-wrist match control.
//
// Navigation is a screen stack. Each screen owns the button recognizers it
// needs, and installing a screen swaps them: that is how SELECT can mean
// "pause" on the clock and "confirm" in a picker without a mode flag.
//
// The clock never stops for data entry. Pickers push modally on top of the
// clock screen; the tick keeps running underneath them the whole time.

import Button from "pebble/button";
import Vibes from "pebble/vibes";
import Message from "pebble/message";
import * as M from "match";
import { drawClock, drawList, drawNumber, drawPanel } from "ui";

// --- Button sets ----------------------------------------------------------

// BACK cannot be long-pressed on this firmware: the button module rejects a
// long recognizer on BACK outright ("no long back"), and a raw subscription on
// BACK is remapped to a synthesised single click, so there is no hold to
// measure. The design's "hold BACK to end the period" is therefore a plain
// press into a confirm screen — BACK has no other job here, the confirm is
// what guards against a mis-press, and it defaults to No. Claiming BACK at all
// is also what stops a stray press dropping out of the app mid-match.
const CLOCK_KEYS = [
	{ types: ["up", "down", "select", "back"], single: true },
	{ types: ["select"], long: { delay: 500 } }
];

const LIST_KEYS = [
	{ types: ["up", "down", "select", "back"], single: true }
];

const NUMBER_KEYS = [
	// repeat: holding runs 0-99 at speed rather than asking for 99 presses.
	{ types: ["up", "down"], single: { repeat: 100 } },
	{ types: ["select", "back"], single: true }
];

let installed = [];

function installButtons(specs) {
	for (const button of installed) {
		try {
			button.close();
		}
		catch {
		}
	}
	installed = specs.map(spec => new Button({ ...spec, onPush: dispatch }));
}

function dispatch(pushed, which, recognizer) {
	if (!pushed)
		return;
	current().onPress?.(which, recognizer);
}

// --- Screen stack ---------------------------------------------------------

const stack = [];
let lastFrame = "";
let pending;

function current() {
	return stack[stack.length - 1];
}

// Screen changes are deferred by a tick rather than applied inside the button
// handler. Creating a Button re-installs the window's click config provider,
// which re-arms the recognizers; do that while a click is still in flight and
// the release lands on the screen that just appeared. That is how confirming a
// scorer with SELECT used to arrive at the clock as a second SELECT and pause
// the match.
function applyPending() {
	if (!pending)
		return;
	const change = pending;
	pending = undefined;
	change();
	installButtons(current().keys);
	lastFrame = "";
	draw();
}

function schedule(change) {
	// Two transitions in one event would drop the first; apply it and move on.
	if (pending)
		applyPending();
	pending = change;
	setTimeout(applyPending, 0);
}

function show(screen) {
	schedule(() => {
		stack.length = 0;
		stack.push(screen);
	});
}

function push(screen) {
	schedule(() => stack.push(screen));
}

function pop() {
	schedule(() => {
		if (stack.length > 1)
			stack.pop();
	});
}

// Redraws are skipped when nothing visible changed. At one tick a second for
// ninety minutes that is most of the frames, and each one is a full repaint.
function draw() {
	const screen = current();
	if (!screen)
		return;
	const frame = screen.signature();
	if (frame === lastFrame)
		return;
	lastFrame = frame;
	screen.draw();
}

// --- Transient notices ----------------------------------------------------

let notice = "";
let noticeUntil = 0;

function setNotice(text, seconds = 6) {
	notice = text;
	noticeUntil = Date.now() + seconds * 1000;
}

function activeNotice() {
	if (notice && Date.now() > noticeUntil)
		notice = "";
	return notice;
}

// --- Shared text ----------------------------------------------------------

function scoreText() {
	const [home, away] = M.score();
	return `${M.TEAM_INITIALS[M.HOME]} ${home} - ${away} ${M.TEAM_INITIALS[M.AWAY]}`;
}

function binsText() {
	const active = M.activeSinBins().length;
	return active ? `BIN ${active}` : "";
}

// The referee's own watch setting, read once: it cannot change while the app
// is in the foreground, and the getter is a native call on every redraw.
let hour12;
try {
	hour12 = watch.hour12;
}
catch {
	hour12 = false;
}

// Time of day for the clock screen. 24-hour pads the hour so the field keeps
// one width all match; 12-hour does not, because "03:47" is not how a clock
// reads. Seconds are deliberately absent — the match clock is the thing being
// read to the second, and a second field competing with it is noise.
function timeOfDay(date) {
	const minutes = date.getMinutes();
	let hours = date.getHours();
	if (hour12) {
		hours %= 12;
		if (!hours)
			hours = 12;
	}
	const hh = !hour12 && hours < 10 ? `0${hours}` : `${hours}`;
	return `${hh}:${minutes < 10 ? "0" : ""}${minutes}`;
}

// --- Generic screens ------------------------------------------------------

function listScreen(title, items, onSelect, hint, start = 0) {
	let index = Math.min(Math.max(0, start), Math.max(0, items.length - 1));

	return {
		keys: LIST_KEYS,
		signature: () => `list|${title}|${index}|${items.length}`,
		draw() {
			drawList(title, items, index, hint);
		},
		onPress(which) {
			switch (which) {
				case "up":
					// Wrapping keeps a short list one press away in either
					// direction, which matters when the referee is not looking.
					index = index > 0 ? index - 1 : items.length - 1;
					break;
				case "down":
					index = index < items.length - 1 ? index + 1 : 0;
					break;
				case "select":
					onSelect(index);
					return;
				case "back":
					pop();
					return;
			}
			draw();
		}
	};
}

function numberScreen(title, caption, onSelect) {
	let value = 0;

	return {
		keys: NUMBER_KEYS,
		signature: () => `num|${title}|${value}`,
		draw() {
			drawNumber(title, `${value}`, caption, "hold UP/DOWN to run");
		},
		onPress(which) {
			switch (which) {
				case "up":
					value = value >= 99 ? 0 : value + 1;
					break;
				case "down":
					value = value <= 0 ? 99 : value - 1;
					break;
				case "select":
					onSelect(value);
					return;
				case "back":
					pop();
					return;
			}
			draw();
		}
	};
}

function confirmScreen(title, onYes) {
	return listScreen(title, ["No", "Yes"], index => {
		if (1 === index)
			onYes();
		else
			pop();
	});
}

// --- Setup ----------------------------------------------------------------

// Values run high to low so UP always means "more", whichever field is showing.
const SETUP_FIELDS = [
	{ label: "PERIODS", key: "periods", values: [4, 3, 2, 1], unit: "" },
	{ label: "PERIOD LENGTH", key: "periodMinutes", values: [45, 40, 35, 30, 25, 20, 15, 10, 5, 1], unit: " min" },
	{ label: "SIN BIN", key: "sinBinMinutes", values: [15, 10, 8, 5, 2, 0], unit: " min" }
];

function setupScreen() {
	let field = 0;

	// A restored config could hold a value that is no longer on its list, which
	// would leave UP/DOWN dead on that field. Snap each one back onto its list.
	for (const f of SETUP_FIELDS) {
		if (f.values.indexOf(M.match.config[f.key]) < 0)
			M.match.config[f.key] = f.values[Math.floor(f.values.length / 2)];
	}

	function valueText() {
		const f = SETUP_FIELDS[field];
		const value = M.match.config[f.key];
		if ("sinBinMinutes" === f.key && 0 === value)
			return "OFF";
		return `${value}${f.unit}`;
	}

	return {
		keys: LIST_KEYS,
		signature: () => `setup|${field}|${valueText()}`,
		draw() {
			drawPanel(SETUP_FIELDS[field].label, valueText(),
				`step ${field + 1} of ${SETUP_FIELDS.length}`,
				field < SETUP_FIELDS.length - 1 ? "UP/DOWN change, SEL next" : "UP/DOWN change, SEL start");
		},
		onPress(which) {
			const f = SETUP_FIELDS[field];
			const at = f.values.indexOf(M.match.config[f.key]);

			switch (which) {
				case "up":
					if (at > 0)
						M.match.config[f.key] = f.values[at - 1];
					break;
				case "down":
					if (at < f.values.length - 1)
						M.match.config[f.key] = f.values[at + 1];
					break;
				case "select":
					if (field < SETUP_FIELDS.length - 1)
						field++;
					else
						startMatch();
					return;
				case "back":
					if (field > 0)
						field--;
					else
						watch.exit();
					return;
			}
			draw();
		}
	};
}

function startMatch() {
	M.reset();
	M.startPeriod();
	Vibes.shortPulse();
	console.log(`match started: ${M.match.config.periods} x ${M.match.config.periodMinutes} min`);
	show(clockScreen());
}

// --- Clock ----------------------------------------------------------------

// One word for how the period is going, which picks both the ring colour and
// the colour of the digits. Kept here rather than in ui.js so the drawing layer
// still knows nothing about match state.
function clockTone(remaining) {
	if (M.PAUSED === M.match.phase)
		return "pause";
	if (remaining < 0)
		return "stop";
	// Same guard startPeriod() puts on the vibration: a period that begins at or
	// below the two-minute mark never earns the warning, because a 1-minute
	// period rendered amber from the whistle says nothing at all.
	if (M.periodSeconds() > M.WARN_SECONDS && remaining <= M.WARN_SECONDS)
		return "warn";
	return "run";
}

function clockScreen() {
	return {
		keys: CLOCK_KEYS,
		signature() {
			return `clock|${M.match.phase}|${M.match.period}|${M.formatClock(M.remainingInPeriod())}|${scoreText()}|${binsText()}|${timeOfDay(new Date())}|${activeNotice()}`;
		},
		draw() {
			const remaining = M.remainingInPeriod();
			const paused = M.PAUSED === M.match.phase;
			const bins = binsText();
			const status = paused ? "PAUSED" : (remaining < 0 ? "STOPPAGE" : "RUNNING");
			drawClock({
				// Period and time of day share the top line. Two corner-anchored
				// labels would be the obvious layout and is exactly what a round
				// screen has no pixels for.
				header: `P${M.match.period}/${M.match.config.periods}   ${timeOfDay(new Date())}`,
				score: scoreText(),
				// Roboto-Bold 49 carries digits and the colon only, so the clock
				// itself can never show a sign; stoppage reads from the ring and
				// the label instead.
				clock: M.formatClock(remaining),
				status: bins ? `${status}  ${bins}` : status,
				// Fraction of the period still to play, which is what the ring
				// draws. Stoppage is an empty ring, not a negative one.
				progress: Math.max(0, remaining) / M.periodSeconds(),
				tone: clockTone(remaining),
				hint: paused ? "SEL resume" : "UP goal  DN card",
				notice: activeNotice()
			});
		},
		onPress(which, recognizer) {
			if ("long" === recognizer) {
				if ("select" === which)
					push(menuScreen());
				return;
			}

			switch (which) {
				case "up":
					goalFlow();
					break;
				case "down":
					cardFlow();
					break;
				case "back":
					push(endPeriodConfirm());
					break;
				case "select":
					if (M.RUNNING === M.match.phase)
						M.pause();
					else
						M.resume();
					Vibes.shortPulse();
					lastPauseReminder = Date.now();
					draw();
					break;
			}
		}
	};
}

// --- Action menu ----------------------------------------------------------

function menuScreen() {
	const labels = [];
	const actions = [];

	function add(label, action) {
		labels.push(label);
		actions.push(action);
	}

	add("Goal", goalFlow);
	add("Card", cardFlow);
	add("Substitution", subFlow);
	if (M.match.config.sinBinMinutes > 0) {
		add("Sin bin", sinBinFlow);
		add("Sin bin status", () => push(sinBinStatusScreen()));
	}
	add("Undo last", undoAction);
	add("End period", () => push(endPeriodConfirm()));
	add("Abandon match", () => push(abandonConfirm()));
	// The match is on flash after every event, so leaving is safe and the
	// referee gets the watch back without ending anything.
	add("Exit (keep match)", () => watch.exit());

	return listScreen("ACTIONS", labels, index => actions[index](), "BACK to clock");
}

// --- Flows ----------------------------------------------------------------
//
// Each step pushes the next picker, so BACK unwinds one decision at a time and
// the final step drops the whole stack back to the clock.

function toClock(message) {
	if (message)
		setNotice(message);
	show(clockScreen());
}

function pickTeam(title, next) {
	push(listScreen(title, M.TEAM_NAMES, team => next(team)));
}

function pickPlayer(title, team, next) {
	push(numberScreen(title, M.TEAM_NAMES[team], player => next(player)));
}

// Goals and cards do not ask for a shirt number. Numbers run high in the
// leagues this is used in, and cycling one up 0-99 costs more attention than
// the referee has to spare while the clock runs — the team and the minute are
// what the scoreline and the report need.

function goalFlow() {
	pickTeam("GOAL", team => {
		M.addEvent({ type: M.GOAL, team });
		Vibes.shortPulse();
		const [home, away] = M.score();
		toClock(`GOAL ${M.TEAM_NAMES[team]} ${home}-${away}`);
	});
}

function cardFlow() {
	pickTeam("CARD", team => {
		push(listScreen("CARD", M.CARD_KINDS, kind => {
			M.addEvent({ type: M.CARD, team, kind });
			Vibes.shortPulse();
			toClock(`${M.CARD_SHORT[kind]} ${M.TEAM_INITIALS[team]}`);
		}));
	});
}

function subFlow() {
	pickTeam("SUB", team => {
		pickPlayer("OFF", team, off => {
			pickPlayer("ON", team, on => {
				M.addEvent({ type: M.SUB, team, player: off, playerOn: on });
				Vibes.shortPulse();
				toClock(`SUB ${M.TEAM_INITIALS[team]} ${off}>${on}`);
			});
		});
	});
}

const BIN_DURATIONS = [2, 5, 8, 10, 15];

function sinBinFlow() {
	pickTeam("SIN BIN", team => {
		pickPlayer("PLAYER", team, player => {
			const labels = BIN_DURATIONS.map(minutes => `${minutes} min`);
			const preferred = BIN_DURATIONS.indexOf(M.match.config.sinBinMinutes);
			push(listScreen("DURATION", labels, index => {
				const minutes = BIN_DURATIONS[index];
				const scheduled = M.addSinBin(team, player, minutes);
				Vibes.shortPulse();
				toClock(scheduled
					? `BIN ${M.TEAM_INITIALS[team]} #${player} ${minutes}m`
					: `BIN #${player} - NO ALARM`);
			}, undefined, preferred < 0 ? 0 : preferred));
		});
	});
}

function undoAction() {
	const removed = M.undoLast();
	if (!removed) {
		toClock("NOTHING TO UNDO");
		return;
	}
	Vibes.doublePulse();
	toClock(`UNDID ${M.describeEvent(removed)}`);
}

function sinBinStatusScreen() {
	let index = 0;

	function bins() {
		return M.match.sinBins;
	}

	function labels() {
		const now = Date.now();
		if (!bins().length)
			return ["none active"];
		return bins().map(bin => {
			const left = Math.max(0, Math.ceil((bin.returnAt - now) / 1000));
			return `${M.TEAM_INITIALS[bin.team]} #${bin.player} ${M.formatClock(left)}`;
		});
	}

	return {
		keys: LIST_KEYS,
		signature: () => `bins|${index}|${labels().join(",")}`,
		draw() {
			drawList("SIN BINS", labels(), index, bins().length ? "SEL release early" : "BACK to menu");
		},
		onPress(which) {
			const list = bins();
			switch (which) {
				case "up":
					index = index > 0 ? index - 1 : Math.max(0, list.length - 1);
					break;
				case "down":
					index = index < list.length - 1 ? index + 1 : 0;
					break;
				case "select": {
					const bin = list[index];
					if (!bin)
						return;
					M.removeSinBin(bin.team, bin.player);
					Vibes.shortPulse();
					index = 0;
					toClock(`#${bin.player} RETURNED`);
					return;
				}
				case "back":
					pop();
					return;
			}
			draw();
		}
	};
}

// --- Period transitions ---------------------------------------------------

function endPeriodConfirm() {
	return confirmScreen(`END PERIOD ${M.match.period}?`, () => {
		M.endPeriod();
		Vibes.shortPulse();
		console.log(`period ${M.match.period} ended`);
		afterPhase();
	});
}

function abandonConfirm() {
	return confirmScreen("ABANDON MATCH?", () => {
		M.abandon();
		Vibes.shortPulse();
		console.log("match abandoned");
		afterPhase();
	});
}

function afterPhase() {
	switch (M.match.phase) {
		case M.SUMMARY:
			show(summaryScreen());
			break;
		case M.INTERVAL:
			show(intervalScreen());
			break;
		default:
			show(clockScreen());
			break;
	}
}

function intervalScreen() {
	const halfTime = 2 === M.match.config.periods && 1 === M.match.period;
	const title = halfTime ? "HALF TIME" : `END OF P${M.match.period}`;

	function startNext() {
		M.nextPeriod();
		Vibes.shortPulse();
		console.log(`period ${M.match.period} started`);
		show(clockScreen());
	}

	return {
		// NUMBER_KEYS for the repeat on UP/DOWN: a twenty-minute break is a hold
		// rather than twenty presses.
		keys: NUMBER_KEYS,
		signature() {
			const value = M.breakRunning() ? M.formatClock(M.remainingInBreak()) : M.match.config.breakMinutes;
			return `interval|${M.match.period}|${scoreText()}|${binsText()}|${M.breakRunning()}|${value}`;
		},
		draw() {
			const running = M.breakRunning();
			const remaining = M.remainingInBreak();
			const off = 0 === M.match.config.breakMinutes;
			const next = `SEL start P${M.match.period + 1}`;

			let hint;
			if (!running)
				hint = off ? `UP set break, ${next}` : "UP/DN set, SEL start break";
			else
				hint = remaining < 0 ? `BREAK OVER - ${next}` : next;

			// Gothic-Bold 28 is a full font, so unlike the clock screen's digit
			// subset this value can say OFF outright.
			drawPanel(title,
				off ? "OFF" : M.formatClock(running ? remaining : M.breakSeconds()),
				scoreText(),
				hint);
		},
		onPress(which) {
			switch (which) {
				case "up":
					M.setBreakMinutes(M.match.config.breakMinutes + 1);
					break;
				case "down":
					M.setBreakMinutes(M.match.config.breakMinutes - 1);
					break;
				case "select":
					// SELECT means "start the break" until one is running, then goes
					// back to its old job of starting the next period. A break set
					// to OFF has nothing to start, so it passes straight through —
					// which is the single press this screen took before.
					if (M.breakRunning() || 0 === M.match.config.breakMinutes) {
						startNext();
						return;
					}
					M.startBreak();
					Vibes.shortPulse();
					console.log(`break started: ${M.match.config.breakMinutes} min`);
					break;
				case "back":
					push(abandonConfirm());
					return;
			}
			draw();
		}
	};
}

// --- Summary --------------------------------------------------------------

function summaryLines() {
	const [home, away] = M.score();
	const reds = team => M.cardCount(team, 1) + M.cardCount(team, 2);

	const lines = [
		scoreText(),
		M.match.abandoned ? "ABANDONED" : "FULL TIME",
		`${M.match.period} x ${M.match.config.periodMinutes} min`,
		`YEL H${M.cardCount(M.HOME, 0)} A${M.cardCount(M.AWAY, 0)}`,
		`RED H${reds(M.HOME)} A${reds(M.AWAY)}`
	];
	for (const event of M.match.events)
		lines.push(M.describeEvent(event));
	return lines;
}

function summaryScreen() {
	const lines = summaryLines();
	let index = 0;

	return {
		keys: LIST_KEYS,
		signature: () => `summary|${index}|${activeNotice()}`,
		draw() {
			drawList("MATCH", lines, index, activeNotice() || "SEL for options");
		},
		onPress(which) {
			switch (which) {
				case "up":
					index = index > 0 ? index - 1 : lines.length - 1;
					break;
				case "down":
					index = index < lines.length - 1 ? index + 1 : 0;
					break;
				case "select":
					push(listScreen("MATCH OPTIONS", ["Send to phone", "New match", "Exit"], choice => {
						if (0 === choice) {
							pop();
							sendReport();
						}
						else if (1 === choice) {
							M.reset();
							show(setupScreen());
						}
						else {
							watch.exit();
						}
					}));
					return;
				case "back":
					pop();
					return;
			}
			draw();
		}
	};
}

// --- Phone export ---------------------------------------------------------
//
// The watch holds the match; the phone holds history. Every failure path here
// ends in a notice and nothing else — nothing on the watch may depend on the
// phone being present.

const CHUNK_BYTES = 180;

let link;
let chunks = [];
let chunkIndex = 0;

function sendReport() {
	const json = JSON.stringify(M.report());
	chunks = [];
	for (let i = 0; i < json.length; i += CHUNK_BYTES)
		chunks.push(json.slice(i, i + CHUNK_BYTES));
	chunkIndex = 0;

	try {
		link ??= new Message({
			format: "map",
			keys: ["chunk", "index", "total"],
			// Size the buffers explicitly. The default is
			// app_message_{inbox,outbox}_size_maximum(), which asks for 8200
			// bytes each — the XS machine has already taken its share of the
			// app heap by this point, so the allocation fails and the app
			// faults outright rather than throwing something catchable. One
			// chunk plus its two integers and the dictionary overhead is a few
			// hundred bytes, and the phone never sends anything back.
			input: 128,
			output: 512,
			onReadable() {
				this.read();		// drain: the phone has nothing to tell us
			},
			onWritable() {
				pump();
			}
		});
	}
	catch {
		setNotice("NO PHONE LINK");
		draw();
		return;
	}

	// Progress is reported by pump() once a chunk is actually away. The first
	// write usually throws "not writable" — the link only opens up once the
	// phone has answered the handshake — so claiming 1/N here would report a
	// send that has not happened yet.
	setNotice(`SENDING 0/${chunks.length}`, 60);
	pump();
}

function pump() {
	if (!chunks.length)
		return;

	if (chunkIndex >= chunks.length) {
		chunks = [];
		setNotice("SENT TO PHONE");
		draw();
		return;
	}

	try {
		link.write(new Map([
			["chunk", chunks[chunkIndex]],
			["index", chunkIndex],
			["total", chunks.length]
		]));
		chunkIndex++;
		setNotice(`SENDING ${chunkIndex}/${chunks.length}`, 60);
	}
	catch {
		// The outbox is busy or the phone dropped out. onWritable calls back if
		// the link recovers; if it never does, the notice simply expires.
	}
	draw();
}

// --- Alerts and the tick --------------------------------------------------

const PAUSE_REMINDER_MS = 10000;
// Four fast taps. Nothing else in the vocabulary is four of anything, which is
// the whole point: five patterns is the ceiling for what stays distinguishable
// through a sleeve in the cold.
const BIN_PATTERN = [120, 100, 120, 100, 120, 100, 120];

let lastPauseReminder = 0;

function checkAlerts(now) {
	const remaining = M.remainingInPeriod();

	if (!M.match.fired.warn && remaining <= M.WARN_SECONDS) {
		M.match.fired.warn = now;
		console.log("ALERT two-minute warning");
		Vibes.doublePulse();
		watch.light(true);
		M.save();
	}

	if (!M.match.fired.final && remaining <= M.FINAL_WARN_SECONDS) {
		M.match.fired.final = now;
		console.log("ALERT thirty-second warning");
		Vibes.pattern([200, 120, 200, 120, 200]);
		watch.light(true);
		M.save();
	}

	if (!M.match.fired.end && remaining <= 0) {
		M.match.fired.end = now;
		console.log("ALERT full time, entering stoppage");
		Vibes.pattern([600, 250, 600, 250, 600, 250, 1000]);
		watch.light(true);
		setNotice(`P${M.match.period} TIME - BACK ENDS`, 15);
		M.save();
	}
}

function releaseBin(bin) {
	Vibes.pattern(BIN_PATTERN);
	watch.light(true);
	setNotice(`#${bin.player} ${M.TEAM_NAMES[bin.team]} MAY RETURN`, 15);
	// The BIN event keeps the record; sinBins only tracks who is off right now.
	M.removeSinBin(bin.team, bin.player);
}

// Two long pulses. This takes the vocabulary to six patterns, one past the
// ceiling DESIGN.md sets, and it is worth it because context does the
// disambiguating: none of the match alerts can fire during an interval, so the
// only other thing the watch can say here is a sin bin expiring — and that is
// four fast taps, which is nothing like this.
const BREAK_PATTERN = [500, 300, 500];

function checkBreak(now) {
	if (!M.breakRunning() || M.match.fired.break)
		return;
	if (M.remainingInBreak() > 0)
		return;

	M.match.fired.break = now;
	console.log("ALERT break over");
	Vibes.pattern(BREAK_PATTERN);
	watch.light(true);
	M.save();
}

function checkSinBins(now) {
	for (const bin of M.dueSinBins(now))
		releaseBin(bin);
}

// Driven by the firmware's second tick rather than by setInterval.
//
// setInterval fired every 1000ms counted from app launch and was never
// re-aligned, so the redraw landed at an arbitrary offset — up to a full second
// — after the clock's value had actually changed, and Pebble's timers can fire
// early (Moddable's own watch code carries a 50ms guard for exactly that), so
// the offset wandered over ninety minutes. That is why the app read fast
// against a scoreboard at some moments and slow at others.
//
// "secondchange" is the firmware's tick_timer_service. It fires just after each
// RTC second and re-computes its own delay from `Date.now() % 1000` every time,
// so it cannot accumulate drift. Since match.js now snaps the clock to whole
// seconds, that RTC second is also the moment the displayed value changes: the
// redraw and the value it draws are on the same edge. This is the same
// self-rephasing scheme pebble-timer-plus uses in prv_app_timer_callback.
function tick() {
	const now = Date.now();

	if (M.RUNNING === M.match.phase)
		checkAlerts(now);
	else if (M.PAUSED === M.match.phase && now - lastPauseReminder >= PAUSE_REMINDER_MS) {
		lastPauseReminder = now;
		Vibes.shortPulse();
	}

	if (M.INTERVAL === M.match.phase)
		checkBreak(now);

	checkSinBins(now);
	draw();
}

// --- Launch ---------------------------------------------------------------

watch.addEventListener("wakeup", event => {
	const bin = M.sinBinByCookie(event?.cookie);
	if (bin)
		releaseBin(bin);
	draw();
});

function resumeIntoMatch() {
	switch (M.match.phase) {
		case M.SUMMARY:
			show(summaryScreen());
			break;
		case M.INTERVAL:
			show(intervalScreen());
			break;
		case M.SETUP:
			show(setupScreen());
			break;
		default:
			lastPauseReminder = Date.now();
			show(clockScreen());
			break;
	}
}

function resumeScreen() {
	return listScreen("MATCH IN PROGRESS", ["Resume", "New match"], choice => {
		if (0 === choice) {
			resumeIntoMatch();
		}
		else {
			M.reset();
			show(setupScreen());
		}
	}, `P${M.match.period} ${scoreText()}`);
}

// Launched by a sin-bin wakeup rather than by the referee: go straight to the
// match. Asking "resume?" at the moment of an alert would be answering a
// question nobody asked.
let wokeUp;
try {
	wokeUp = watch.wake;
}
catch {
	wokeUp = undefined;
}

const restored = M.restore();

if (restored && wokeUp) {
	resumeIntoMatch();
	const bin = M.sinBinByCookie(wokeUp.cookie);
	if (bin)
		releaseBin(bin);
}
else if (restored && M.SUMMARY !== M.match.phase) {
	show(resumeScreen());
}
else if (restored) {
	show(summaryScreen());
}
else {
	show(setupScreen());
}

watch.addEventListener("secondchange", tick);
