// Drawing. Pure functions of their arguments — no match state reaches in here,
// so a screen can be reasoned about from its view object alone.
//
// Every layout is derived from render.width/height and the font metrics rather
// than from fixed pixel positions: emery is 200x228 rectangular and gabbro is
// 260x260 round, and hard-coded coordinates would only ever suit one of them.

import Poco from "commodetto/Poco";

export const render = new Poco(screen);

// Font lookup is an exact family+size match; unlisted pairs throw "font not
// found" at runtime. Roboto-Bold 49 is a digit/colon subset, so it may only be
// handed digits and colons — never a letter, never a minus sign. Stoppage is
// shown by the STOPPAGE label and the accent colour instead.
export const fonts = {
	clock: new render.Font("Roboto-Bold", 49),
	big: new render.Font("Gothic-Bold", 28),
	score: new render.Font("Gothic-Bold", 24),
	row: new render.Font("Gothic-Bold", 18),
	hint: new render.Font("Gothic-Regular", 14)
};

export const colors = {
	white: render.makeColor(255, 255, 255),
	black: render.makeColor(0, 0, 0),
	red: render.makeColor(255, 0, 0),
	gray: render.makeColor(110, 110, 110),
	// The ring palette. Both target platforms are colour; each of these lands on
	// an exact Pebble 64-colour entry, so nothing is dithered.
	green: render.makeColor(0, 170, 0),
	yellow: render.makeColor(255, 170, 0),
	track: render.makeColor(170, 170, 170)
};

const PAD = 3;

// Round displays are square; rectangular Pebbles never are (144x168, 200x228).
// Poco does not report the shape, and getting this wrong is expensive: on the
// round gabbro a corner-anchored label lands outside the glass entirely, and a
// full-width line loses a word off each end.
const ROUND = render.width === render.height;
const RADIUS = render.width / 2;

// Rows near the top and bottom of a circle are much narrower than the diameter.
// Measure the chord across the row's furthest edge from centre so text is fitted
// to the width actually visible at that height, not to the screen width.
function usableWidth(y, height) {
	if (!ROUND)
		return render.width - PAD * 2;

	const centre = render.height / 2;
	const furthest = Math.max(Math.abs(y - centre), Math.abs(y + height - centre));
	const half = Math.sqrt(Math.max(0, RADIUS * RADIUS - furthest * furthest));
	return Math.max(0, half * 2 - PAD * 2);
}

// Content is inset from the top and bottom on a round screen so the title bar
// and the hint line sit inside the glass instead of being shaved off by it.
const INSET = ROUND ? Math.round(render.height * 0.09) : PAD;

export function textWidth(text, font) {
	return render.getTextWidth(text, font);
}

function centered(text, font, color, y) {
	render.drawText(text, font, color, Math.round((render.width - textWidth(text, font)) / 2), y);
}

// Truncate to fit rather than letting Poco run text off the edge, which turns
// "12' 2YEL A #11" into something that reads as a different event entirely. The
// marker is two ASCII dots, not an ellipsis: the system fonts are not
// guaranteed to carry U+2026 and a missing glyph is worse than a plain one.
function fit(text, font, width, marker = "..") {
	if (textWidth(text, font) <= width)
		return text;
	let cut = text;
	while (cut.length > 1 && textWidth(`${cut}${marker}`, font) > width)
		cut = cut.slice(0, -1);
	return `${cut}${marker}`;
}

// Draw centred and clipped to what is visible at this height. Used for every
// line of text in the app, so nothing can silently run off a round edge.
function line(text, font, color, y) {
	centered(fit(text, font, usableWidth(y, font.height)), font, color, y);
}

function background() {
	render.fillRectangle(colors.white, 0, 0, render.width, render.height);
}

// The title bar spans the full width — on a round screen the ends disappear
// under the bezel, which reads as intentional — but its text is centred so it
// stays inside the glass on both shapes.
function titleBar(title, note) {
	const height = fonts.hint.height + 4;
	const label = note ? `${title}  ${note}` : title;

	render.fillRectangle(colors.black, 0, INSET, render.width, height);
	line(label, fonts.hint, colors.white, INSET + 2);

	return INSET + height;
}

function footer(text, color = colors.gray) {
	if (!text)
		return;
	const y = render.height - INSET - fonts.hint.height;
	line(text, fonts.hint, color, y);
}

// --- The progress ring ----------------------------------------------------
//
// Poco's Pebble build adds drawCircle(color, x, y, r, fromDeg, toDeg), which is
// graphics_fill_radial at full inset: a filled pie wedge, 0 degrees at twelve
// o'clock, running clockwise. A ring is therefore three fills, the same trick
// pebble-timer-plus uses in drawing_render — flood the screen with the track
// colour, lay the remaining arc over it, then drop a disc of background in the
// middle and what is left is a band.
//
// On the round gabbro that band is a true annulus. On the rectangular emery the
// disc is inscribed in the width, so the band is thinnest at the sides and
// opens out towards the corners. That is the one part of a rectangular screen a
// referee's eye never uses, so widening it there costs nothing.

const CENTRE_X = render.width / 2;
const CENTRE_Y = render.height / 2;

// Round loses its outermost pixels under the bezel, so its band is drawn wider.
const BAND = ROUND ? 14 : 8;

// Far enough to reach every corner: the flood and the arc must both cover the
// whole screen or the corners keep whatever was underneath.
const RING_OUTER = Math.ceil(Math.sqrt(render.width * render.width + render.height * render.height) / 2);

// Everything the clock screen draws lives inside this disc.
const RING_INNER = Math.round(Math.min(render.width, render.height) / 2) - BAND;

// The chord across a row of the inner disc. Same reasoning as usableWidth, but
// measured against the ring rather than the glass: on emery the ring is now the
// tighter of the two, so the clock screen fits text to it on both shapes.
function ringWidth(y, height) {
	const furthest = Math.max(Math.abs(y - CENTRE_Y), Math.abs(y + height - CENTRE_Y));
	const half = Math.sqrt(Math.max(0, RING_INNER * RING_INNER - furthest * furthest));
	return Math.max(0, half * 2 - PAD * 2);
}

function ringLine(text, font, color, y, width, marker) {
	centered(fit(text, font, width ?? ringWidth(y, font.height), marker), font, color, y);
}

function ring(progress, arc, track) {
	render.fillRectangle(track, 0, 0, render.width, render.height);

	// Rounded, not truncated: at 45 minutes a whole degree is 7.5 seconds, and
	// truncating would leave the ring visibly behind the digits it sits around.
	const sweep = Math.round(360 * Math.min(1, Math.max(0, progress)));
	if (sweep > 0)
		render.drawCircle(arc, CENTRE_X, CENTRE_Y, RING_OUTER, 0, sweep);

	render.drawCircle(colors.white, CENTRE_X, CENTRE_Y, RING_INNER, 0, 360);
}

// How the ring and the digits are coloured. `run` is the ordinary case; `warn`
// picks up the same two-minute mark the vibration does, so the watch says the
// same thing whether it is felt or glanced at.
const TONES = {
	run: { arc: colors.green, track: colors.track, text: colors.black },
	warn: { arc: colors.yellow, track: colors.track, text: colors.black },
	// A period past its time has no ring left to drain, so the whole band goes
	// red rather than empty — an empty ring reads as "not started".
	stop: { arc: colors.red, track: colors.red, text: colors.red },
	pause: { arc: colors.gray, track: colors.track, text: colors.gray }
};

// --- Screens --------------------------------------------------------------

// view: { header, score, clock, status, progress, tone, hint, notice }
export function drawClock(view) {
	render.begin();

	const tone = TONES[view.tone] ?? TONES.run;
	ring(view.progress, tone.arc, tone.track);

	// Five rows, centred in the disc as one block. Pinning the hint to the
	// bottom of the disc is the obvious layout and is wrong: the chord there is
	// only a few pixels wide, so the line would be truncated to nothing.
	const rows = [
		{ text: view.header, font: fonts.hint, color: colors.gray },
		{ text: view.score, font: fonts.score, color: colors.black },
		// Roboto-Bold 49 is a digit/colon subset. An overrun here must clip
		// silently rather than pick up the usual ".." marker, which is a glyph
		// this font does not carry.
		{ text: view.clock, font: fonts.clock, color: tone.text, marker: "" },
		{ text: view.status, font: fonts.row, color: tone.text },
		{ text: view.notice || view.hint, font: fonts.hint, color: colors.gray }
	];

	const GAP = 2;
	const top = Math.round(CENTRE_Y - RING_INNER) + PAD;
	const bottom = Math.round(CENTRE_Y + RING_INNER) - PAD;
	let block = GAP * (rows.length - 1);
	for (const row of rows)
		block += row.font.height;

	let y = top + Math.max(0, Math.round((bottom - top - block) / 2));
	for (const row of rows) {
		// The notice inverts the hint row: a sin bin expiring matters more than a
		// reminder of which button does what, and it has to win the glance.
		if (row.text === view.notice && view.notice) {
			// The bar is taller than its text, so its chord is the narrower of the
			// two. Fit the text to the bar, not to the text's own row, or a long
			// notice runs out past the ends of the black it is meant to sit on.
			const width = ringWidth(y - 2, row.font.height + 4);
			render.fillRectangle(colors.black, Math.round(CENTRE_X - width / 2), y - 2,
				Math.round(width), row.font.height + 4);
			ringLine(view.notice, row.font, colors.white, y, width - PAD * 2);
		}
		else {
			ringLine(row.text, row.font, row.color, y, undefined, row.marker);
		}
		y += row.font.height + GAP;
	}

	render.end();
}

// A scrolling list. `index` is both the selection and the scroll position.
export function drawList(title, items, index, hint) {
	render.begin();
	background();

	const note = items.length ? `${index + 1}/${items.length}` : "";
	const top = titleBar(title, note);
	const bottom = render.height - INSET - (hint ? fonts.hint.height + PAD : 0);
	const rowHeight = fonts.row.height + 6;
	const visible = Math.max(1, Math.floor((bottom - top - PAD) / rowHeight));

	// Keep the selection near the middle of the window, but never scroll past
	// either end of the list.
	let first = index - (visible >> 1);
	if (first > items.length - visible)
		first = items.length - visible;
	if (first < 0)
		first = 0;

	for (let i = 0; i < visible && first + i < items.length; i++) {
		const n = first + i;
		const y = top + i * rowHeight;
		const selected = n === index;
		if (selected)
			render.fillRectangle(colors.black, 0, y, render.width, rowHeight);
		line(items[n], fonts.row, selected ? colors.white : colors.black, y + 3);
	}

	footer(hint);
	render.end();
}

// Big-digit picker. `value` must be digits only — it is drawn in the clock font.
export function drawNumber(title, value, caption, hint) {
	render.begin();
	background();

	const top = titleBar(title);
	let y = top + Math.max(PAD, Math.round((render.height - INSET - top - fonts.clock.height) / 3));

	line(value, fonts.clock, colors.black, y);

	if (caption) {
		y += fonts.clock.height + 4;
		line(caption, fonts.row, colors.gray, y);
	}

	footer(hint);
	render.end();
}

// Setup and interval screens: a heading, one value, a caption, a hint.
export function drawPanel(title, value, caption, hint) {
	render.begin();
	background();

	const top = titleBar(title);
	let y = top + Math.max(PAD, Math.round((render.height - INSET - top - fonts.big.height) / 3));

	line(value, fonts.big, colors.black, y);

	if (caption) {
		y += fonts.big.height + 6;
		line(caption, fonts.row, colors.gray, y);
	}

	footer(hint);
	render.end();
}
