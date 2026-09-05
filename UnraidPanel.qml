import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget plus detail popup for an Unraid server: array/parity state,
// disk temperatures, capacity, and network throughput, polled over the Unraid
// GraphQL API. Formatting and parsing live in Model.js; this file is wiring,
// presentation, and the poll lifecycle.
//
// The file is not called Panel.qml: a local Panel.qml would shadow qs.Ui's own
// Panel type in this directory and the plugin fails to load outright.
//
// It is a Panel rather than a plain BarWidget so the detail view is the same
// click-to-open card the audio, network, and bluetooth widgets use, instead of
// a hover tooltip that pops instantly and wears the tooltip border.
Panel {
  id: root
  moduleName: "awangk.unraid"
  ipcTarget: "awangk.unraid"

  readonly property bool vertical: bar ? bar.vertical : false
  readonly property string home: Quickshell.env("HOME") || ""

  readonly property string host: String(setting("host", "")).trim()
  readonly property string apiKeyFile: String(setting("apiKeyFile", "~/.config/omarchy/unraid-api-key"))
  readonly property int refreshIntervalSec: clampInt(setting("refreshIntervalSec", 30), 5, 3600)
  // Capacity and temperatures move slowly, but a transfer rate sampled every
  // 30s is nearly useless — a copy can begin and finish between two polls. So
  // poll hard only while the panel is actually open and someone is looking.
  readonly property int openRefreshIntervalSec: clampInt(setting("openRefreshIntervalSec", 2), 1, 60)
  readonly property int activeIntervalSec: opened ? openRefreshIntervalSec : refreshIntervalSec
  readonly property int timeoutSec: Math.max(2, Math.min(20, Math.floor(refreshIntervalSec / 2)))

  readonly property var cfg: ({
    host: host,
    apiKeyFile: apiKeyFile,
    tempWarn: clampInt(setting("tempWarn", 45), 20, 90),
    tempCrit: clampInt(setting("tempCrit", 55), 20, 100),
    ssdTempWarn: clampInt(setting("ssdTempWarn", 60), 20, 100),
    ssdTempCrit: clampInt(setting("ssdTempCrit", 70), 20, 110),
    showNetwork: setting("showNetwork", true) !== false,
    showNetworkInBar: setting("showNetworkInBar", false) === true,
    // Here rather than read at poll time so cfg is the single source for
    // everything a poll depends on. (This is not what makes an edit take effect
    // immediately — QML captures the `settings` read inside setting() as a
    // dependency of this binding, so cfg re-evaluates and onCfgChanged fires on
    // any settings change, including keys nothing reads.)
    insecure: setting("insecure", false) === true,
    netInterface: String(setting("netInterface", "")).trim(),
    capacityWarn: clampInt(setting("capacityWarn", 85), 1, 100),
    capacityCrit: clampInt(setting("capacityCrit", 95), 1, 100),
    showCapacity: setting("showCapacity", true) !== false,
    showTemp: setting("showTemp", true) !== false,
    label: String(setting("label", "")),
    vertical: root.vertical
  })

  // Normalized server state, or null before the first successful poll.
  property var serverState: null
  // { level, text, tooltip } for the bar label.
  property var view: ({ level: 0, text: "", tooltip: "" })

  // Optional root fields this key is currently believed to be allowed to read.
  // `vars` and `metrics` are non-nullable in the schema, so asking for one the
  // key cannot read nulls the entire response — the array data included. On a
  // refusal the offending field is dropped here and the poll retried, and
  // capsProbe puts them back periodically so widening the key is picked up
  // without a restart.
  property var caps: ({ vars: true, metrics: true })
  readonly property var wantedCaps: ({ vars: true, metrics: cfg.showNetwork })

  // Panel-shaped derivations of serverState, recomputed only when it changes.
  readonly property var capacity: Model.capacityLine(serverState)
  readonly property var parity: Model.parityLine(serverState)
  readonly property var net: Model.netLine(serverState)
  // Asked for the rate, got refused, but the array still answered: the row has
  // to explain itself or the feature just looks broken.
  readonly property bool netDenied: cfg.showNetwork && !caps.metrics && serverState !== null
  // Allowed to read metrics, but no interface matched — a `netInterface` typo,
  // usually. Same reasoning as netDenied: silence looks like a broken feature.
  readonly property string netProblem: Model.netProblem(serverState)
  readonly property var rows: Model.diskRows(serverState, cfg)

  function clampInt(value, min, max) {
    var n = parseInt(String(value), 10)
    if (!isFinite(n)) n = min
    return Math.max(min, Math.min(max, n))
  }

  function resetCaps() {
    caps = { vars: wantedCaps.vars, metrics: wantedCaps.metrics }
  }

  function levelColor(level) {
    if (level === 0) return Color.popups.text
    return root.bar ? root.bar.urgent : Color.urgent
  }

  function refresh() {
    if (poll.running) return
    if (!host) {
      root.serverState = null
      root.view = Model.renderError(0, "", cfg)
      return
    }
    var ask = { vars: caps.vars && wantedCaps.vars, metrics: caps.metrics && wantedCaps.metrics }
    poll.command = ["bash", "-c", Model.curlScript(host, Model.expandHome(apiKeyFile, home),
      cfg.insecure, timeoutSec, ask)]
    poll.running = true
  }

  function openWebUi() {
    if (!bar || !host) return
    bar.run("omarchy-launch-or-focus-webapp " + Model.shellQuote("unraid") + " " + Model.shellQuote(host))
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Settings edits arrive as a whole new `settings` object; re-poll so a
  // corrected host or key takes effect without waiting out the interval.
  onCfgChanged: {
    resetCaps()
    refreshSoon.restart()
  }

  Component.onCompleted: refresh()

  Timer {
    id: pollTimer
    interval: root.activeIntervalSec * 1000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  // Opening the panel should show current numbers, not whatever the last
  // background poll left behind up to refreshIntervalSec ago.
  onOpenedChanged: if (opened) refresh()

  Timer {
    id: refreshSoon
    interval: 400
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    // Re-ask for the optional fields now and then, so granting the key more
    // permissions on the server lights them up without touching this machine.
    id: capsProbe
    interval: 15 * 60 * 1000
    repeat: true
    running: true
    onTriggered: {
      if (!root.caps.vars || !root.caps.metrics) {
        root.resetCaps()
        root.refresh()
      }
    }
  }

  Process {
    id: poll
    running: false
    command: []
    stdout: StdioCollector { id: pollOut; waitForEnd: true }
    stderr: StdioCollector { id: pollErr; waitForEnd: true }
    onExited: function(exitCode) {
      var body = String(pollOut.text || "")
      if (exitCode !== 0) {
        // --fail-with-body means an HTTP error still delivers the GraphQL
        // error envelope on stdout; prefer that over curl's terse stderr.
        root.serverState = null
        root.view = Model.renderError(exitCode, body || pollErr.text, root.cfg)
        return
      }
      var payload = null
      try {
        payload = JSON.parse(body)
      } catch (e) {
        root.serverState = null
        root.view = Model.renderApiError("Response was not JSON: " + body.slice(0, 200), root.cfg)
        return
      }
      // A refused optional field costs one wasted poll and no more: drop it and
      // immediately retry with a narrower query rather than showing an error.
      var denied = Model.forbiddenOptional(payload)
      if (denied && root.caps[denied]) {
        var next = { vars: root.caps.vars, metrics: root.caps.metrics }
        next[denied] = false
        root.caps = next
        refreshSoon.restart()
        return
      }
      var err = Model.graphqlError(payload)
      if (err) {
        root.serverState = null
        root.view = Model.renderApiError(err, root.cfg)
        return
      }
      payload.__netInterface = root.cfg.netInterface
      root.serverState = Model.normalize(payload)
      root.view = Model.render(root.serverState, root.cfg)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.view.text
    fontSize: Style.font.body
    // No tooltip: the popup is the detail view, matching how audio, network,
    // and bluetooth behave. Warning and critical both take the theme's urgent
    // color — the leading glyph (server vs. alert) separates them, which stays
    // readable in every theme instead of hard-coding an amber that fits none.
    tooltipText: ""
    active: root.view.level > 0
    activeColor: root.bar ? root.bar.urgent : Color.urgent

    onPressed: function(b) {
      if (b === Qt.RightButton) root.openWebUi()
      else if (b === Qt.MiddleButton) { root.resetCaps(); root.refresh() }
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        // ---------- Header: unraid wordmark, server name, array state ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(title.implicitHeight, stateLabel.implicitHeight)

          // Lime Technology's own wordmark, as the webGUI header serves it. Its
          // orange-to-red gradient is fixed rather than themed: a logo that
          // recolors per theme stops reading as the logo.
          Image {
            id: logo
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            source: Qt.resolvedUrl("unraid-logotype.svg")
            // Height drives it; the source is a wide wordmark, so let width follow.
            sourceSize.height: Math.round(Style.font.title * 0.85)
            fillMode: Image.PreserveAspectFit
            smooth: true
            mipmap: true
            asynchronous: true
          }

          Text {
            id: title
            anchors.left: logo.right
            anchors.leftMargin: Style.space(9)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.serverState
              ? (root.serverState.serverName || root.host.replace(/^https?:\/\//, ""))
              : ""
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            id: stateLabel
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.serverState ? Model.titleCase(root.serverState.state) : "no data"
            color: root.serverState && root.serverState.started
              ? Qt.darker(Color.popups.text, 1.4)
              : (root.bar ? root.bar.urgent : Color.urgent)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }
        }

        // ---------- Capacity: numbers plus a fill bar ----------
        Column {
          width: parent.width
          spacing: Style.space(5)
          visible: root.capacity !== null

          Item {
            width: parent.width
            implicitHeight: capUsed.implicitHeight

            Text {
              id: capUsed
              anchors.left: parent.left
              textFormat: Text.PlainText
              text: root.capacity ? root.capacity.used + " of " + root.capacity.total : ""
              color: Color.popups.text
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              anchors.right: parent.right
              textFormat: Text.PlainText
              text: root.capacity ? root.capacity.free + " free" : ""
              color: Qt.darker(Color.popups.text, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }

          Rectangle {
            width: parent.width
            height: Style.space(6)
            radius: height / 2
            color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.12)

            Rectangle {
              height: parent.height
              radius: parent.radius
              width: parent.width * Math.max(0, Math.min(1, (root.capacity ? root.capacity.pct : 0) / 100))
              color: !root.capacity ? Color.popups.text
                : root.capacity.pct >= root.cfg.capacityCrit ? (root.bar ? root.bar.urgent : Color.urgent)
                : root.capacity.pct >= root.cfg.capacityWarn ? (root.bar ? root.bar.urgent : Color.urgent)
                : Color.popups.text

              Behavior on width { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
            }
          }
        }

        PanelSeparator { width: parent.width }

        // ---------- Parity and network ----------
        Column {
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: {
              var out = []
              if (root.parity && root.parity.text)
                out.push({ key: "Parity", value: root.parity.text, level: root.parity.level })
              if (root.net)
                out.push({ key: "Network",
                  value: root.net.name + "  ↓ " + root.net.rx + "B/s   ↑ " + root.net.tx + "B/s"
                    + (root.net.utilization !== null ? "   " + root.net.utilization.toFixed(0) + "%" : ""),
                  level: 0 })
              else if (root.netDenied)
                out.push({ key: "Network", value: "needs INFO on the API key", level: 1 })
              else if (root.netProblem)
                out.push({ key: "Network", value: root.netProblem, level: 1 })
              return out
            }

            Item {
              required property var modelData
              width: column.width
              implicitHeight: rowValue.implicitHeight

              Text {
                anchors.left: parent.left
                textFormat: Text.PlainText
                text: parent.modelData.key
                color: Qt.darker(Color.popups.text, 1.4)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                id: rowValue
                anchors.right: parent.right
                textFormat: Text.PlainText
                text: parent.modelData.value
                color: root.levelColor(parent.modelData.level)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
        }

        PanelSeparator { width: parent.width; visible: root.rows.length > 0 }

        PanelSectionHeader {
          text: "DISKS"
          foreground: Color.popups.text
          visible: root.rows.length > 0
        }

        // ---------- One row per populated disk slot ----------
        Column {
          width: parent.width
          spacing: Style.space(5)

          Repeater {
            model: root.rows

            Item {
              required property var modelData
              width: column.width
              implicitHeight: diskName.implicitHeight

              Text {
                id: diskName
                anchors.left: parent.left
                width: Style.space(64)
                textFormat: Text.PlainText
                text: parent.modelData.name
                color: root.levelColor(parent.modelData.level)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                id: diskTemp
                anchors.left: diskName.right
                width: Style.space(38)
                textFormat: Text.PlainText
                text: parent.modelData.tempLabel
                color: root.levelColor(parent.modelData.level)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              // Fill bar for slots that have a filesystem; parity and extra
              // cache-pool members have none and show their note instead.
              Rectangle {
                anchors.left: diskTemp.right
                anchors.right: diskTrailing.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                height: Style.space(4)
                radius: height / 2
                visible: parent.modelData.fill >= 0
                color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.12)

                Rectangle {
                  height: parent.height
                  radius: parent.radius
                  width: parent.width * Math.max(0, Math.min(1, parent.parent.modelData.fill / 100))
                  color: Qt.darker(Color.popups.text, 1.2)
                }
              }

              Text {
                id: diskTrailing
                anchors.right: parent.right
                textFormat: Text.PlainText
                text: parent.modelData.note !== "" ? parent.modelData.note
                  : parent.modelData.fill >= 0 ? parent.modelData.fill.toFixed(0) + "% of " + parent.modelData.sizeLabel
                  : ""
                color: parent.modelData.note !== ""
                  ? (root.bar ? root.bar.urgent : Color.urgent)
                  : Qt.darker(Color.popups.text, 1.4)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
        }

        // ---------- Error / unconfigured fallback ----------
        Text {
          width: parent.width
          visible: root.serverState === null
          textFormat: Text.PlainText
          text: root.view.tooltip
          wrapMode: Text.WordWrap
          color: Color.popups.text
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }
}
