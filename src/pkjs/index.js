// PebbleKit JS: receives the match report from the watch and keeps the history.
//
// The report arrives in chunks because a single AppMessage does not hold a
// whole match. Chunks can arrive out of order, so they are placed by index and
// only parsed once every slot is filled.

var chunks = [];
var expected = 0;

function reset() {
  chunks = [];
  expected = 0;
}

function store(report) {
  var history;
  try {
    history = JSON.parse(localStorage.getItem("matches") || "[]");
  } catch (err) {
    history = [];
  }
  history.push(report);
  // Keep the phone's copy bounded; this is a referee's log, not an archive.
  if (history.length > 50) {
    history = history.slice(history.length - 50);
  }
  localStorage.setItem("matches", JSON.stringify(history));
}

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
