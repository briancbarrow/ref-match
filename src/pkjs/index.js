// PebbleKit JS: receives the match report from the watch, keeps the history,
// and hands it to the settings page so the referee can save it as markdown.
//
// The report arrives in chunks because a single AppMessage does not hold a
// whole match. Chunks can arrive out of order, so they are placed by index and
// only parsed once every slot is filled.

// The settings page. It is a static page — config/index.html in this repo,
// published anywhere that serves files over https. The match log travels in
// the URL fragment, which the browser does not send to the server, so the host
// only ever serves the page and never sees a match.
var CONFIG_URL = "https://briancbarrow.github.io/ref-match/config/";

var chunks = [];
var expected = 0;

function reset() {
  chunks = [];
  expected = 0;
}

function history() {
  try {
    return JSON.parse(localStorage.getItem("matches") || "[]");
  } catch (err) {
    return [];
  }
}

function store(report) {
  var log = history();
  log.push(report);
  // Keep the phone's copy bounded; this is a referee's log, not an archive.
  if (log.length > 50) {
    log = log.slice(log.length - 50);
  }
  localStorage.setItem("matches", JSON.stringify(log));
}

// --- Settings page --------------------------------------------------------
//
// Opening the app's settings hands the whole stored log to the page in the URL
// fragment. Nothing is uploaded and no key is needed: the page renders the
// markdown and the phone's own share sheet saves the file.

// base64url over UTF-8, written out because this runtime has no btoa and no
// TextEncoder. Percent-encoding the JSON instead would roughly double a URL
// that already carries fifty matches.
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Bytes(s) {
  var escaped = encodeURIComponent(s);
  var bytes = [];
  for (var i = 0; i < escaped.length; i++) {
    if ("%" === escaped.charAt(i)) {
      bytes.push(parseInt(escaped.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(escaped.charCodeAt(i));
    }
  }
  return bytes;
}

function toBase64url(s) {
  var bytes = utf8Bytes(s);
  var out = "";
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < bytes.length; i++) {
    buffer = (buffer * 256) + bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      var divisor = Math.pow(2, bits);
      out += ALPHABET.charAt(Math.floor(buffer / divisor) & 0x3f);
      buffer = buffer % divisor;
    }
  }
  if (bits > 0) {
    out += ALPHABET.charAt((buffer * Math.pow(2, 6 - bits)) & 0x3f);
  }
  return out;
}

// A phone will open a very long URL, but not an unbounded one. Fifty ordinary
// matches land well inside this; a log that somehow does not gives up its
// oldest matches rather than failing to open at all.
var MAX_FRAGMENT = 60000;

function fragment() {
  var log = history();
  var encoded = toBase64url(JSON.stringify(log));
  while (encoded.length > MAX_FRAGMENT && log.length > 1) {
    log = log.slice(1);
    encoded = toBase64url(JSON.stringify(log));
  }
  return encoded;
}

Pebble.addEventListener("showConfiguration", function () {
  try {
    var url = CONFIG_URL + "#" + fragment();
    // Logged because a settings page that never opens looks identical from the
    // phone to one the app never asked for: this line is what tells the two
    // apart, and `pebble logs` is the only place either is visible.
    console.log("ref-match: opening settings, " + history().length +
      " matches, url " + url.length + " chars");
    Pebble.openURL(url);
  } catch (err) {
    console.log("ref-match: could not open settings - " + err);
  }
});

Pebble.addEventListener("webviewclosed", function (e) {
  // The page returns nothing at all when it is simply dismissed.
  if (!e || !e.response) {
    return;
  }

  // Some phone apps hand back the fragment already decoded and some do not,
  // so try it raw before decoding rather than depending on which.
  var response;
  try {
    response = JSON.parse(e.response);
  } catch (err) {
    try {
      response = JSON.parse(decodeURIComponent(e.response));
    } catch (err2) {
      return;
    }
  }

  if (response && response.clear) {
    localStorage.removeItem("matches");
    console.log("ref-match: match history cleared");
  }
});

// The watch side only treats the link as writable once the phone has sent it
// something: the firmware's outbox-sent callback is a no-op until then, so
// without a message from here the watch sends one chunk and stalls waiting for
// a callback that never comes. Speak first, and answer everything.
function ping() {
  try {
    Pebble.sendAppMessage({ index: 0 });
  } catch (err) {
    console.log("ref-match: could not ping watch - " + err);
  }
}

Pebble.addEventListener("ready", function () {
  console.log("ref-match: phone link ready");
  ping();
});

Pebble.addEventListener("appmessage", function (e) {
  var payload = e.payload || {};

  // Anything inbound — including the watch's own handshake — is worth
  // answering, because the reply is what keeps the watch's outbox callbacks
  // alive for the rest of the transfer.
  ping();

  if (undefined === payload.chunk) {
    return;
  }

  var index = payload.index || 0;
  var total = payload.total || 1;

  // A different total means a new report started; drop whatever was half done.
  if (total !== expected) {
    reset();
    expected = total;
  }
  chunks[index] = payload.chunk;

  for (var i = 0; i < total; i++) {
    if (undefined === chunks[i]) {
      return;
    }
  }

  var report;
  try {
    report = JSON.parse(chunks.join(""));
  } catch (err) {
    console.log("ref-match: report did not parse - " + err);
    reset();
    return;
  }
  reset();

  console.log("ref-match: " + report.score.home + "-" + report.score.away +
    ", " + report.events.length + " events" +
    (report.abandoned ? " (abandoned)" : ""));

  try {
    store(report);
  } catch (err) {
    console.log("ref-match: could not store report - " + err);
  }
});
