// Pure helpers for the Unraid bar widget: query construction, response
// normalization, and label/tooltip rendering. Kept out of the QML so the
// formatting rules are readable on their own and can be exercised with
// plain node (see test/model-test.js).

// Nerd Font glyphs, written as surrogate pairs so the source stays ASCII and
// does not depend on \u{...} support in the shell's JS engine.
var ICON_DISK = "\uDB81\uDC8B"   // U+F048B nf-md-server
var ICON_ALERT = "\uDB80\uDC26"  // U+F0026 nf-md-alert

// The array fields are the point of the widget; `vars` and `metrics` are
// extras that a narrowly-scoped API key may not be allowed to read. They cannot
// simply be asked for and ignored on failure: both are non-nullable at the
// query root, so one FORBIDDEN field nulls the *whole* `data` object and takes
// the array down with it. So the query is assembled from the optional fields
// the widget currently believes it can read, and `forbiddenOptional()` below
// tells the caller which one to drop after a refusal.
var OPTIONAL_FIELDS = ["vars", "metrics"]

var ARRAY_FIELDS = [
  "  array {",
  "    state",
  "    capacity { kilobytes { free used total } disks { free used total } }",
  "    parityCheckStatus { status progress running paused correcting errors speed }",
  "    parities { name device temp status numErrors rotational }",
  "    disks { name device temp status numErrors rotational fsSize fsFree fsUsed }",
  "    caches { name device temp status numErrors rotational fsSize fsFree fsUsed }",
  "  }",
  "  parityHistory { date duration status errors }"
]

// `caps` is an object like { vars: true, metrics: false }; a missing key means
// "do not ask for it".
function buildQuery(caps) {
  var lines = ["query OmarchyUnraid {"].concat(ARRAY_FIELDS)
  if (caps && caps.vars) lines.push("  vars { name }")
  if (caps && caps.metrics)
    lines.push("  metrics { network { name operstate rxSec txSec utilizationPercent } }")
  lines.push("}")
  return lines.join("\n")
}

// Name of an optional root field the server just refused, so the caller can
// drop it and retry. Returns "" when the failure is not of that kind — a
// refusal on `array` itself is fatal and must surface to the user.
function forbiddenOptional(payload) {
  if (!payload || !Array.isArray(payload.errors)) return ""
  for (var i = 0; i < payload.errors.length; i++) {
    var e = payload.errors[i]
    var path = Array.isArray(e.path) && e.path.length ? String(e.path[0]) : ""
    if (OPTIONAL_FIELDS.indexOf(path) !== -1) return path
  }
  return ""
}

// Disk states that mean the array is degraded right now, as opposed to a slot
// that is simply empty (DISK_NP) or healthy (DISK_OK).
var BAD_DISK_STATUS = {
  DISK_NP_MISSING: "missing",
  DISK_INVALID: "invalid",
  DISK_WRONG: "wrong disk",
  DISK_DSBL: "disabled",
  DISK_NP_DSBL: "disabled/missing",
  DISK_DSBL_NEW: "disabled (new)"
}

function shellQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

// The key reaches neither the QML side nor the process table. The QML half is
// free — bash reads the file itself. The process table half is not: a header
// written as `-H "x-api-key: $key"` is expanded by the shell *before* exec, so
// the secret lands in curl's argv and any local user can read it out of
// /proc/<pid>/cmdline for as long as the poll runs. So the header goes in over
// stdin as a curl config file instead, which argv never sees.
// `apiKeyFile` must already be absolute — expandHome() is applied by the
// caller, which is the only side that knows $HOME.
function curlScript(host, apiKeyFile, insecure, timeoutSec, caps) {
  var endpoint = String(host || "").replace(/\/+$/, "") + "/graphql"
  var body = JSON.stringify({ query: buildQuery(caps) })
  return [
    "set -o pipefail",
    "keyfile=" + shellQuote(apiKeyFile),
    'if [ ! -r "$keyfile" ]; then echo "no-key" >&2; exit 90; fi',
    'key=$(cat "$keyfile")',
    'key=$(printf %s "$key" | tr -d "[:space:]")',
    'if [ -z "$key" ]; then echo "empty-key" >&2; exit 90; fi',
    // Inside a curl config file's double quotes, backslash and quote are
    // escapes. Unraid keys are alphanumeric, but escaping costs one sed.
    'key=$(printf %s "$key" | sed \'s/[\\\\"]/\\\\&/g\')',
    "curl -sS --fail-with-body --max-time " + Math.max(2, timeoutSec | 0)
      + (insecure ? " -k" : "")
      + " -X POST " + shellQuote(endpoint)
      + " -H 'Content-Type: application/json'"
      + " --data-binary " + shellQuote(body)
      + " -K - <<CURLCFG",
    'header = "x-api-key: $key"',
    "CURLCFG"
  ].join("\n")
}

function expandHome(path, home) {
  var p = String(path || "")
  if (!home) return p
  if (p === "~") return home
  if (p.slice(0, 2) === "~/") return home + p.slice(1)
  return p
}

// GraphQL reports field-level failures with HTTP 200 and an `errors` array, so
// a successful curl exit is not on its own proof that we got data. But partial
// success is the normal case for a narrowly-scoped API key: a key holding only
// ARRAY still answers `array` in full and merely errors on `vars`, which this
// widget uses for nothing but the tooltip's server name. Fail only when the
// array data itself is missing.
function graphqlError(payload) {
  if (!payload) return "Malformed response"
  if (payload.data && payload.data.array) return ""
  if (Array.isArray(payload.errors) && payload.errors.length) {
    var msgs = []
    for (var i = 0; i < payload.errors.length && i < 3; i++)
      msgs.push(String(payload.errors[i].message || "unknown error"))
    return msgs.join("; ")
  }
  return "Response had no array data"
}

// Unraid reports kilobytes as 1024-byte blocks and labels the result TB in its
// own UI, so stay base-2 to keep the numbers matching the web GUI.
function humanKb(kb) {
  var n = Number(kb)
  if (!isFinite(n) || n <= 0) return "0 B"
  var units = ["KB", "MB", "GB", "TB", "PB"]
  var i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i]
}

// Bridges, bonds, and the physical NIC underneath them all report the same
// traffic, so summing interfaces double-counts. Take the single busiest real
// one instead. Virtual interfaces are excluded by name because Unraid hosts
// carry a lot of docker/libvirt plumbing that is never the answer.
var VIRTUAL_IFACE = /^(lo|docker|veth|vnet|virbr|shim|tunl|wg|tailscale|dummy)/i

function pickInterface(list, preferred) {
  var ifaces = Array.isArray(list) ? list : []
  var best = null
  for (var i = 0; i < ifaces.length; i++) {
    var n = ifaces[i]
    var name = String(n.name || "")
    if (preferred) {
      if (name === preferred) return normalizeIface(n)
      continue
    }
    if (VIRTUAL_IFACE.test(name)) continue
    if (n.operstate && String(n.operstate).toLowerCase() !== "up") continue
    var rate = Number(n.rxSec || 0) + Number(n.txSec || 0)
    if (best === null || rate > best.rate) best = { iface: n, rate: rate }
  }
  return best ? normalizeIface(best.iface) : null
}

function normalizeIface(n) {
  return {
    name: String(n.name || "?"),
    rx: Math.max(0, Number(n.rxSec || 0)),
    tx: Math.max(0, Number(n.txSec || 0)),
    utilization: n.utilizationPercent === null || n.utilizationPercent === undefined
      ? null : Number(n.utilizationPercent)
  }
}

// Bytes per second, compact enough for a bar label. Returns just the number and
// its magnitude letter ("112M"), so a caller can append "B/s" for the tooltip
// or leave it bare in the bar, where the arrow already says what it is.
function rate(bytesPerSec) {
  var n = Number(bytesPerSec || 0)
  if (!isFinite(n) || n < 1) return "0"
  var units = ["", "K", "M", "G", "T"]
  var i = 0
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1 }
  // The loop leaves n < 1000, but rounding can push it back to exactly that:
  // 999500 B/s would render "1000K", which is both a wrong magnitude and five
  // characters — one more than padRate() reserves, so the bar would resize at
  // every megabyte boundary. Promote once more instead.
  if (n >= 999.5 && i < units.length - 1) { n /= 1000; i += 1 }
  return (i === 0 || n >= 100 ? n.toFixed(0) : n.toFixed(1)) + units[i]
}

// Right-aligned in a fixed 4-column field, so "0", "951K" and "7.9M" all
// occupy the same width in the bar's monospace font.
function padRate(bytesPerSec) {
  var text = rate(bytesPerSec)
  while (text.length < 4) text = " " + text
  return text
}

function warnFor(disk, cfg) {
  return disk.solidState ? cfg.ssdTempWarn : cfg.tempWarn
}

function critFor(disk, cfg) {
  return disk.solidState ? cfg.ssdTempCrit : cfg.tempCrit
}

function temperature(disk) {
  var t = disk ? Number(disk.temp) : NaN
  // Spun-down and unassigned slots report null, NaN, or a sentinel negative.
  if (!isFinite(t) || t <= 0) return null
  return Math.round(t)
}

function titleCase(state) {
  return String(state || "").toLowerCase().replace(/_/g, " ")
}

function normalize(payload) {
  var data = payload && payload.data ? payload.data : null
  if (!data || !data.array) return null
  var a = data.array
  var all = []
  function collect(list, kind) {
    var arr = Array.isArray(list) ? list : []
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i]
      all.push({
        kind: kind,
        name: d.name || d.device || "?",
        status: d.status || "",
        temp: temperature(d),
        // Cache pools are usually NVMe/SSD, which idle 15-20 C hotter than a
        // spinning disk without it meaning anything. Threshold them separately.
        solidState: d.rotational === false,
        errors: Number(d.numErrors || 0),
        fsSize: Number(d.fsSize || 0),
        fsFree: Number(d.fsFree || 0),
        fsUsed: Number(d.fsUsed || 0)
      })
    }
  }
  collect(a.parities, "parity")
  collect(a.disks, "data")
  collect(a.caches, "cache")

  var kb = (a.capacity && a.capacity.kilobytes) || {}
  var netList = data.metrics && data.metrics.network
  var net = pickInterface(netList, payload.__netInterface)
  var total = Number(kb.total || 0)
  var used = Number(kb.used || 0)
  var lastCheck = Array.isArray(data.parityHistory) && data.parityHistory.length ? data.parityHistory[0] : null

  return {
    serverName: (data.vars && data.vars.name) || "",
    state: a.state || "UNKNOWN",
    started: a.state === "STARTED",
    totalKb: total,
    usedKb: used,
    freeKb: Number(kb.free || 0),
    usedPct: total > 0 ? (used / total) * 100 : 0,
    parity: a.parityCheckStatus || {},
    net: net,
    // Whether the server answered with interfaces at all, and which one was
    // asked for, so an empty row can say why it is empty.
    netAvailable: Array.isArray(netList),
    netWanted: String(payload.__netInterface || ""),
    lastCheck: lastCheck,
    disks: all
  }
}

// Returns { level, text, tooltip }. level: 0 ok, 1 warning, 2 critical — the
// bar maps it to the theme's normal/warn/urgent foreground.
function render(state, cfg) {
  if (!state) return { level: 2, text: ICON_ALERT + " unraid", tooltip: "Unraid: no data" }

  var problems = []
  var level = 0
  function raise(to, why) { if (to > level) level = to; if (why) problems.push(why) }

  if (!state.started) raise(2, "Array " + titleCase(state.state))

  var hottest = null
  var overheating = null
  var badDisks = []
  var errorDisks = []
  for (var i = 0; i < state.disks.length; i++) {
    var d = state.disks[i]
    if (d.temp !== null && (hottest === null || d.temp > hottest.temp)) hottest = d
    if (d.temp !== null) {
      var over = d.temp - warnFor(d, cfg)
      if (over >= 0 && (overheating === null || over > overheating.over))
        overheating = { disk: d, over: over }
    }
    if (BAD_DISK_STATUS[d.status]) badDisks.push(d)
    if (d.errors > 0) errorDisks.push(d)
  }
  for (var j = 0; j < badDisks.length; j++)
    raise(2, badDisks[j].name + " " + BAD_DISK_STATUS[badDisks[j].status])
  for (var k = 0; k < errorDisks.length; k++)
    raise(1, errorDisks[k].name + " " + errorDisks[k].errors + " errors")

  if (overheating) {
    var od = overheating.disk
    raise(od.temp >= critFor(od, cfg) ? 2 : 1, od.name + " " + od.temp + "°C")
  }

  if (state.usedPct >= cfg.capacityCrit) raise(2, "Array " + state.usedPct.toFixed(0) + "% full")
  else if (state.usedPct >= cfg.capacityWarn) raise(1, "Array " + state.usedPct.toFixed(0) + "% full")

  var p = state.parity || {}
  if (p.paused) raise(1, "Parity check paused")
  if (Number(p.errors || 0) > 0) raise(2, "Parity check: " + p.errors + " errors")

  // Bar label. A running parity check is the one thing worth displacing the
  // usual capacity/temp pair for — it is transient and you want the progress.
  var parts = []
  if (cfg.label) parts.push(cfg.label)
  if (!state.started) {
    parts.push(titleCase(state.state))
  } else if (p.running) {
    parts.push("parity " + Math.round(Number(p.progress || 0)) + "%")
  } else {
    // Thresholds are per disk type, so the globally hottest disk is often a
    // cache SSD sitting well inside its own limit while a cooler spinning disk
    // is the one raising the alarm. Showing the SSD's number in the urgent
    // color points at the wrong disk, so prefer whatever is actually over.
    var shown = overheating ? overheating.disk : hottest
    if (cfg.showCapacity && state.totalKb > 0) parts.push(state.usedPct.toFixed(0) + "%")
    if (cfg.showTemp && shown) parts.push(shown.temp + "°")
    // Off by default, and fixed-width when on. A rate that appears, disappears,
    // and changes digit count resizes the widget on every poll, which shifts
    // its neighbours and walks the anchored panel across the screen. Padding to
    // a constant character count costs a little whitespace and buys a bar that
    // holds still.
    if (cfg.showNetworkInBar && state.net)
      parts.push("↓" + padRate(state.net.rx) + " ↑" + padRate(state.net.tx))
  }
  var icon = level === 2 ? ICON_ALERT : ICON_DISK
  var text = cfg.vertical ? icon : (icon + " " + parts.join(" ")).trim()

  return { level: level, text: text, tooltip: tooltip(state, hottest, problems, cfg) }
}

function pad(s, width) {
  s = String(s)
  while (s.length < width) s += " "
  return s
}

function tooltip(state, hottest, problems, cfg) {
  var lines = []
  var who = state.serverName || String(cfg.host || "").replace(/^https?:\/\//, "") || "Unraid"
  lines.push(who + " — array " + titleCase(state.state))
  lines.push("")
  if (state.totalKb > 0) {
    lines.push(pad("Capacity", 9) + humanKb(state.usedKb) + " / " + humanKb(state.totalKb)
      + " (" + state.usedPct.toFixed(0) + "%, " + humanKb(state.freeKb) + " free)")
  }

  var p = state.parity || {}
  if (p.running) {
    lines.push(pad("Parity", 9) + "checking " + Math.round(Number(p.progress || 0)) + "%"
      + (p.speed ? " at " + p.speed : "")
      + (p.correcting ? ", correcting" : ", read-only")
      + (Number(p.errors || 0) > 0 ? ", " + p.errors + " errors" : ""))
  } else if (p.paused) {
    lines.push(pad("Parity", 9) + "paused at " + Math.round(Number(p.progress || 0)) + "%")
  } else if (state.lastCheck) {
    var lc = state.lastCheck
    lines.push(pad("Parity", 9) + titleCase(lc.status) + " "
      + shortDate(lc.date) + ", " + Number(lc.errors || 0) + " errors"
      + (lc.duration ? ", took " + duration(lc.duration) : ""))
  } else {
    lines.push(pad("Parity", 9) + "never checked")
  }
  if (hottest) lines.push(pad("Hottest", 9) + hottest.name + " " + hottest.temp + "°C")
  if (state.net) {
    lines.push(pad("Network", 9) + state.net.name
      + "  ↓ " + rate(state.net.rx) + "B/s  ↑ " + rate(state.net.tx) + "B/s"
      + (state.net.utilization !== null ? "  (" + state.net.utilization.toFixed(0) + "% of link)" : ""))
  }

  lines.push("")
  var width = 0
  for (var i = 0; i < state.disks.length; i++) width = Math.max(width, state.disks[i].name.length)
  for (var j = 0; j < state.disks.length; j++) {
    var d = state.disks[j]
    if (d.status === "DISK_NP") continue
    var bits = []
    if (d.temp !== null) bits.push(d.temp + "°C")
    else bits.push("spun down")
    if (d.fsSize > 0) bits.push(((d.fsUsed / d.fsSize) * 100).toFixed(0) + "% of " + humanKb(d.fsSize))
    if (d.errors > 0) bits.push(d.errors + " errors")
    if (BAD_DISK_STATUS[d.status]) bits.push(BAD_DISK_STATUS[d.status].toUpperCase())
    lines.push(pad(d.name, width + 2) + bits.join("  ·  "))
  }

  if (problems.length) {
    lines.push("")
    lines.push("⚠ " + problems.join("; "))
  }
  return lines.join("\n")
}

function shortDate(iso) {
  if (!iso) return ""
  var d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  var days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return days + "d ago"
  return d.toISOString().slice(0, 10)
}

function duration(seconds) {
  var s = Number(seconds || 0)
  var h = Math.floor(s / 3600)
  var m = Math.floor((s % 3600) / 60)
  return h > 0 ? h + "h " + m + "m" : m + "m"
}

// Turns a failed poll into the same {level, text, tooltip} shape, so the widget
// has one rendering path whether the server answered or not.
function renderApiError(message, cfg) {
  return { level: 2, text: ICON_ALERT + " api",
    tooltip: "Unraid API error from " + cfg.host + "\n\n" + message
      + "\n\nIf this says the key lacks permissions, recreate it with array read access:\n  unraid-api apikey --create" }
}

function renderError(exitCode, stderr, cfg) {
  var detail = String(stderr || "").trim().split("\n").slice(-3).join("\n")
  if (!cfg.host) {
    // Neutral, not urgent: an unconfigured widget is a to-do, not a fault,
    // and a permanently red bar item trains you to ignore the color.
    return { level: 0, text: ICON_DISK + " setup",
      tooltip: "Unraid widget is not configured.\n\nSet `host` on the widget in ~/.config/omarchy/shell.json,\nand put an API key in " + cfg.apiKeyFile + "." }
  }
  if (exitCode === 90) {
    return { level: 2, text: ICON_ALERT + " key",
      tooltip: "Cannot read the Unraid API key.\n\nExpected it in " + cfg.apiKeyFile + "\nCreate one on the server with: unraid-api apikey --create" }
  }
  return { level: 2, text: ICON_ALERT + " offline",
    tooltip: "Unraid " + cfg.host + " unreachable (curl exit " + exitCode + ")"
      + (detail ? "\n\n" + detail : "") }
}

// ---------------------------------------------------------------------------
// Structured views for the popup panel. The bar label and its tooltip can be
// plain strings, but the panel lays out real rows, so it needs the numbers
// rather than a pre-formatted block of text.
// ---------------------------------------------------------------------------

// One row per populated slot: name, temperature, fill, and any fault. `level`
// drives the row's color the same way it drives the bar's.
function diskRows(state, cfg) {
  var rows = []
  if (!state) return rows
  for (var i = 0; i < state.disks.length; i++) {
    var d = state.disks[i]
    if (d.status === "DISK_NP") continue
    var level = 0
    var note = ""
    if (BAD_DISK_STATUS[d.status]) { level = 2; note = BAD_DISK_STATUS[d.status] }
    else if (d.errors > 0) { level = 1; note = d.errors + " errors" }
    if (d.temp !== null) {
      if (d.temp >= critFor(d, cfg)) level = 2
      else if (d.temp >= warnFor(d, cfg) && level < 1) level = 1
    }
    rows.push({
      name: d.name,
      kind: d.kind,
      tempLabel: d.temp === null ? "—" : d.temp + "°",
      // Parity has no filesystem, and the second member of a cache pool
      // reports zeroes rather than its own numbers. -1 means "draw no bar".
      fill: d.fsSize > 0 ? (d.fsUsed / d.fsSize) * 100 : -1,
      sizeLabel: d.fsSize > 0 ? humanKb(d.fsSize) : "",
      note: note,
      level: level
    })
  }
  return rows
}

// The parity line as the panel wants it: one short sentence, plus whether it
// deserves attention.
function parityLine(state) {
  if (!state) return { text: "", level: 0 }
  var p = state.parity || {}
  if (p.running) {
    return { level: 0, text: "checking " + Math.round(Number(p.progress || 0)) + "%"
      + (p.speed ? " at " + p.speed : "")
      + (p.correcting ? " · correcting" : " · read-only") }
  }
  if (p.paused) return { level: 1, text: "paused at " + Math.round(Number(p.progress || 0)) + "%" }
  if (state.lastCheck) {
    var lc = state.lastCheck
    var errs = Number(lc.errors || 0)
    return { level: errs > 0 ? 2 : 0,
      text: titleCase(lc.status) + " " + shortDate(lc.date) + " · " + errs + " errors"
        + (lc.duration ? " · " + duration(lc.duration) : "") }
  }
  return { level: 1, text: "never checked" }
}

// The server answered with interfaces but none matched, so the Network row
// would otherwise just vanish and look like a missing feature. Say which of the
// two reasons it is — a typo in `netInterface` is by far the likelier one.
function netProblem(state) {
  if (!state || state.net || !state.netAvailable) return ""
  return state.netWanted
    ? "no interface named " + state.netWanted
    : "no active interface"
}

function netLine(state) {
  if (!state || !state.net) return null
  return {
    name: state.net.name,
    rx: rate(state.net.rx),
    tx: rate(state.net.tx),
    utilization: state.net.utilization
  }
}

function capacityLine(state) {
  if (!state || !(state.totalKb > 0)) return null
  return {
    used: humanKb(state.usedKb),
    total: humanKb(state.totalKb),
    free: humanKb(state.freeKb),
    pct: state.usedPct
  }
}
