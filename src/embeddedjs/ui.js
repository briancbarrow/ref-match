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
	gray: render.makeColor(110, 110, 110)
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
function fit(text, font, width) {
	if (textWidth(text, font) <= width)
		return text;
	let cut = text;
	while (cut.length > 1 && textWidth(`${cut}..`, font) > width)
		cut = cut.slice(0, -1);
	return `${cut}..`;
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

// --- Screens --------------------------------------------------------------

// view: { period, score, clock, status, stoppage, bins, hint, notice }
export function drawClock(view) {
	render.begin();
	background();

	const accent = view.stoppage ? colors.red : colors.black;

	// Period and sin-bin count share one centred line. They were in opposite
	// corners, which is exactly where a round screen has no pixels.
	const top = INSET;
	line(view.bins ? `${view.period}   ${view.bins}` : view.period,
		fonts.hint, colors.gray, top);

	// Centre the score/clock/status block in what is left between that line and
	// the footer, rather than stacking from the top: stacking leaves the whole
	// of emery's extra height as a hole under the clock.
	const above = top + fonts.hint.height + 2;
	const below = render.height - INSET - fonts.hint.height - PAD;
	const block = fonts.score.height + 2 + fonts.clock.height + 2 + fonts.row.height;

	let y = above + Math.max(0, Math.round((below - above - block) / 2));
	line(view.score, fonts.score, colors.black, y);

	y += fonts.score.height + 2;
	line(view.clock, fonts.clock, accent, y);

	y += fonts.clock.height + 2;
	line(view.status, fonts.row, view.stoppage ? colors.red : colors.gray, y);

	// The notice line borrows the hint row: a sin bin expiring matters more than
	// a reminder of which button does what.
	if (view.notice) {
		const noticeY = render.height - INSET - fonts.hint.height;
		render.fillRectangle(colors.black, 0, noticeY - 2, render.width, fonts.hint.height + 4);
		line(view.notice, fonts.hint, colors.white, noticeY);
	}
	else {
		footer(view.hint);
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
