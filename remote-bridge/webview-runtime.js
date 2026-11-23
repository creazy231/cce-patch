/* cce-patch: Connection tab (phone remote). The view behind the sessions panel's Connection tab.
 * patch.ts (remote-bridge/install.ts) puts this in front of webview/index.js, so it exists before
 * the app boots. A plain browser script (ES2019, no imports); its one global is window.__cceRemote:
 *   attach(sessions)     the app's sessions manager, handed over where each app root is created
 *   mount(el | null)     the React ref of the tab's content element: draws the view into it and
 *                        keeps it current; null (unmount) stops once no view is left
 *   request(type, data)  sends {type, ...data} to the extension host (the bridge answers the
 *                        cce_remote_* types) and resolves with the answer
 * Whatever the host sends is data: it goes into the DOM as text and attributes only. Every entry
 * point and handler is guarded, because nothing here may break the sessions panel. */
(function () {
  "use strict";
  if (typeof window === "undefined" || window.__cceRemote) return;

  var POLL_MS = 2000;
  var MAX_POLL_MS = 30000;
  var STATUS_TIMEOUT_MS = 10000;
  // Connect waits for `tailscale serve`, which may take 20 s.
  var ACTION_TIMEOUT_MS = 60000;
  var FLASH_MS = 1500;
  var GET_TAILSCALE_URL = "https://tailscale.com/download";
  var HTTPS_ADMIN_URL = "https://login.tailscale.com/admin/dns";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var NOT_HOOKED = "The Connection tab can't reach Claude Code in this window. Run the patcher again, then reload the window.";
  var NOT_CONNECTED = "Claude Code isn't connected in this window yet.";
  var NO_BRIDGE = "The phone remote bridge isn't running in this window. Run the patcher again, then reload the window.";
  var NO_ANSWER = "The phone remote bridge didn't answer.";

  var sessions = null;
  var views = [];
  var status = null; // the last ConnectionStatus from the bridge
  var busy = ""; // the action that's running
  var flash = ""; // a button that says for a moment that it worked: "copy" | "save"
  var actionError = "";
  var fetchError = "";
  // Requests are numbered, so an answer to an older request can't replace a newer status.
  var seq = 0;
  var shownSeq = 0;
  var polling = false;
  var pollAgain = false;
  var pollDelay = POLL_MS;
  var pollTimer = 0;
  var tickTimer = 0;
  var flashTimer = 0;
  var shownKey = "";

  function warn(error) {
    try {
      console.warn("[cce-remote]", error);
    } catch (_) {}
  }

  function guard(fn) {
    return function (event) {
      try {
        fn(event);
      } catch (error) {
        warn(error);
      }
    };
  }

  function isText(value) {
    return typeof value === "string" && value.length > 0;
  }

  // ── talking to the extension host ──

  function request(type, data) {
    try {
      var comms = sessions && sessions.comms;
      var connection = comms && comms.connection && comms.connection.value;
      if (!connection || typeof connection.sendRequest !== "function") {
        return Promise.reject(new Error(sessions ? NOT_CONNECTED : NOT_HOOKED));
      }
      var message = {};
      if (data && typeof data === "object") {
        for (var key in data) if (Object.prototype.hasOwnProperty.call(data, key)) message[key] = data[key];
      }
      message.type = type;
      return Promise.resolve(connection.sendRequest(message));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(NO_ANSWER));
      }, ms);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function describe(error) {
    var message = error && error.message ? String(error.message) : String(error);
    // What the host says for a request type nobody handles: the bridge isn't loaded.
    return /unknown request type/i.test(message) ? NO_BRIDGE : message;
  }

  function describeCode(code) {
    return code === "bad_url" ? "The phone app address must start with https:// (or be empty)." : String(code);
  }

  // Keeps the status of an answer unless a newer request's status is already shown.
  function take(answer, mine) {
    if (answer && answer.status && typeof answer.status === "object" && mine > shownSeq) {
      shownSeq = mine;
      status = answer.status;
    }
  }

  function poll() {
    pollTimer = 0;
    if (!views.length) return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    pollAgain = false;
    var mine = ++seq;
    withTimeout(request("cce_remote_status"), STATUS_TIMEOUT_MS)
      .then(
        function (answer) {
          fetchError = "";
          pollDelay = POLL_MS;
          take(answer, mine);
        },
        function (error) {
          fetchError = describe(error);
          pollDelay = Math.min(pollDelay * 2, MAX_POLL_MS);
        }
      )
      .then(
        guard(function () {
          polling = false;
          render();
          if (pollAgain) refresh();
          else schedule();
        })
      );
  }

  function schedule() {
    if (views.length && !pollTimer && !polling) pollTimer = setTimeout(guard(poll), pollDelay);
  }

  // Asks for the status now (or as soon as the poll that's out comes back).
  function refresh() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = 0;
    pollDelay = POLL_MS;
    poll();
  }

  function act(kind, type, data, onDone) {
    if (busy) return;
    busy = kind;
    actionError = "";
    render();
    var mine = ++seq;
    withTimeout(request(type, data), ACTION_TIMEOUT_MS)
      .then(
        function (answer) {
          busy = "";
          if (answer && answer.error) actionError = describeCode(answer.error);
          else if (onDone) onDone();
          take(answer, mine);
        },
        function (error) {
          busy = "";
          actionError = describe(error);
        }
      )
      .then(
        guard(function () {
          render();
          refresh();
        })
      );
  }

  function openUrl(url) {
    request("open_url", { url: url }).then(null, function (error) {
      actionError = describe(error);
      render();
    });
  }

  function showFlash(which) {
    flash = which;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(
      guard(function () {
        flashTimer = 0;
        flash = "";
        render();
      }),
      FLASH_MS
    );
  }

  // ── building the view ──

  function make(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function makeButton(className, label, key, onClick) {
    var button = make("button", className, label);
    button.type = "button";
    button.disabled = !!busy;
    if (key) button.setAttribute("data-cce-key", key);
    button.addEventListener("click", guard(onClick));
    return button;
  }

  // An external link, opened by the extension (the extension's own open_url request).
  function makeLink(label, url) {
    var link = make("button", "cce-conn-link", label);
    link.type = "button";
    link.title = url;
    link.setAttribute("data-cce-key", "link:" + label);
    link.addEventListener(
      "click",
      guard(function () {
        openUrl(url);
      })
    );
    return link;
  }

  // A status line: a coloured dot and what it means.
  function makeLine(state, parts) {
    var line = make("div", "cce-conn-line");
    var dot = make("span", "cce-conn-dot");
    dot.setAttribute("data-state", state);
    dot.setAttribute("aria-hidden", "true");
    line.appendChild(dot);
    var body = make("div", "cce-conn-line-body");
    for (var i = 0; i < parts.length; i++) body.appendChild(parts[i]);
    line.appendChild(body);
    return line;
  }

  function makeActions(buttons) {
    var row = make("div", "cce-conn-actions");
    for (var i = 0; i < buttons.length; i++) row.appendChild(buttons[i]);
    return row;
  }

  function makeNotice(message) {
    var notice = make("div", "cce-conn-notice", message);
    notice.setAttribute("role", "alert");
    return notice;
  }

  function makeSection(heading) {
    var section = make("section", "cce-conn-section");
    if (heading) section.appendChild(make("h3", "cce-conn-heading", heading));
    return section;
  }

  function makeQrCode(qr) {
    var size = qr && qr.size;
    if (typeof size !== "number" || Math.floor(size) !== size || size < 1 || size > 200 || !isText(qr.path)) return null;
    // One unit per module, plus the 4-module quiet zone around it that scanners need.
    var full = String(size + 8);
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "-4 -4 " + full + " " + full);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Pairing QR code");
    var background = document.createElementNS(SVG_NS, "rect");
    background.setAttribute("x", "-4");
    background.setAttribute("y", "-4");
    background.setAttribute("width", full);
    background.setAttribute("height", full);
    background.setAttribute("fill", "#fff");
    var modules = document.createElementNS(SVG_NS, "path");
    modules.setAttribute("d", qr.path);
    modules.setAttribute("fill", "#000");
    svg.appendChild(background);
    svg.appendChild(modules);
    return svg;
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatDate(ms) {
    if (typeof ms !== "number" || !(ms > 0)) return "";
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (_) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  function formatAgo(ms) {
    if (typeof ms !== "number" || !(ms > 0)) return "never";
    var minutes = Math.floor((Date.now() - ms) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " h ago";
    var days = Math.floor(hours / 24);
    if (days < 30) return days === 1 ? "yesterday" : days + " days ago";
    return "on " + formatDate(ms);
  }

  function updateCountdown(view) {
    if (!view.countdown) return;
    var left = Math.ceil((view.expiresAt - Date.now()) / 1000);
    if (left > 0) {
      view.countdown.textContent = "expires in " + Math.floor(left / 60) + ":" + pad(left % 60);
    } else {
      view.countdown.textContent = "expired";
      // The bridge makes a new code when the status is asked for and none is valid.
      if (!view.askedForNewCode) {
        view.askedForNewCode = true;
        refresh();
      }
    }
  }

  function tick() {
    for (var i = 0; i < views.length; i++) updateCountdown(views[i]);
  }

  function tailscaleSection() {
    var ts = status.tailscale && typeof status.tailscale === "object" ? status.tailscale : {};
    var section = makeSection("");
    if (!ts.installed) {
      var missing = make("div");
      missing.appendChild(document.createTextNode("Tailscale isn't installed. "));
      missing.appendChild(makeLink("Get Tailscale", GET_TAILSCALE_URL));
      section.appendChild(makeLine("off", [missing]));
    } else if (!ts.running) {
      section.appendChild(makeLine("warn", [make("div", "", "Tailscale isn't running or is logged out.")]));
      section.appendChild(
        makeActions([
          makeButton("cce-conn-btn cce-conn-secondary", "Open Tailscale", "open-tailscale", function () {
            act("open", "cce_remote_open_tailscale");
          }),
        ])
      );
    } else {
      var parts = [make("div", "", isText(ts.loginName) ? "Connected to Tailscale as " + ts.loginName : "Connected to Tailscale")];
      if (isText(ts.dnsName)) parts.push(make("div", "cce-conn-mono cce-conn-muted", ts.dnsName));
      section.appendChild(makeLine(ts.httpsEnabled ? "ok" : "warn", parts));
      if (!ts.httpsEnabled) {
        var warning = make("div", "cce-conn-warning");
        var off = make("div");
        off.appendChild(document.createTextNode("HTTPS certificates are off for your tailnet. "));
        var consent = isText(ts.consentUrl) && /^https:\/\//.test(ts.consentUrl) ? ts.consentUrl : HTTPS_ADMIN_URL;
        off.appendChild(makeLink("Turn on HTTPS", consent));
        warning.appendChild(off);
        warning.appendChild(
          make(
            "div",
            "cce-conn-note",
            "Turning on HTTPS publishes this Mac's Tailscale name" +
              (isText(ts.dnsName) ? " (" + ts.dnsName + ")" : "") +
              " in public certificate logs. Rename the machine in Tailscale first if the name is personal."
          )
        );
        section.appendChild(warning);
      }
    }
    return section;
  }

  function primaryButton() {
    var on = !!status.enabled;
    var label = busy === "connect" ? "Connecting…" : busy === "disconnect" ? "Disconnecting…" : on ? "Disconnect" : "Connect with Tailscale";
    return makeActions([
      makeButton(on ? "cce-conn-btn cce-conn-secondary" : "cce-conn-btn cce-conn-primary", label, "primary", function () {
        if (status && status.enabled) act("disconnect", "cce_remote_disconnect");
        else act("connect", "cce_remote_connect");
      }),
    ]);
  }

  function connectionSection() {
    var section = makeSection("");
    var role = status.role;
    var connected = role === "hub" || role === "peer";
    if (connected) {
      section.appendChild(
        makeLine("ok", [
          make("div", "cce-conn-strong", "Connected"),
          make("div", "cce-conn-muted", role === "hub" ? "This window serves your phone" : "Connected through another VS Code window"),
        ])
      );
    } else if (role === "error") {
      section.appendChild(makeLine("error", [make("div", "", "Not connected")]));
    } else {
      section.appendChild(makeLine("busy", [make("div", "", "Connecting…")]));
    }
    if (isText(status.url)) {
      var address = make("div", "cce-conn-address");
      address.appendChild(make("div", "cce-conn-label", "Address"));
      address.appendChild(make("div", "cce-conn-mono", status.url));
      section.appendChild(address);
    }
    if (connected) {
      var windows = typeof status.windows === "number" && status.windows > 0 ? Math.floor(status.windows) : 0;
      section.appendChild(make("div", "cce-conn-muted", windows + (windows === 1 ? " VS Code window connected" : " VS Code windows connected")));
    }
    return section;
  }

  function pairSection(view) {
    var pairing = status.pairing;
    if (!pairing || typeof pairing !== "object") return null;
    var section = makeSection("Pair a phone");
    section.appendChild(make("div", "cce-conn-step", "1. On your phone, open the CCE Remote app (with Tailscale on)."));
    section.appendChild(make("div", "cce-conn-step", "2. Tap Add Mac, then scan this code or paste the link."));
    var qr = makeQrCode(pairing.qr);
    if (qr) {
      var frame = make("div", "cce-conn-qr");
      frame.appendChild(qr);
      section.appendChild(frame);
    }
    var codeLine = make("div", "cce-conn-codeline");
    codeLine.appendChild(make("span", "cce-conn-code", isText(pairing.code) ? pairing.code : ""));
    view.countdown = codeLine.appendChild(make("span", "cce-conn-muted"));
    view.expiresAt = typeof pairing.expiresAt === "number" ? pairing.expiresAt : 0;
    view.askedForNewCode = false;
    updateCountdown(view);
    section.appendChild(codeLine);
    var link = pairing.link;
    section.appendChild(
      makeActions([
        makeButton("cce-conn-btn cce-conn-secondary", "New code", "new-code", function () {
          act("new_code", "cce_remote_new_code");
        }),
        makeButton("cce-conn-btn cce-conn-secondary", flash === "copy" ? "Copied" : "Copy link", "copy-link", function () {
          if (isText(link)) {
            act("copy", "cce_remote_copy", { text: link }, function () {
              showFlash("copy");
            });
          }
        }),
      ])
    );
    return section;
  }

  function devicesSection() {
    var section = makeSection("Paired devices");
    var devices = Array.isArray(status.devices) ? status.devices : [];
    var shown = 0;
    for (var i = 0; i < devices.length; i++) {
      var device = devices[i];
      if (!device || typeof device !== "object" || !isText(device.id)) continue;
      var row = make("div", "cce-conn-device");
      var main = make("div", "cce-conn-device-main");
      main.appendChild(make("div", "cce-conn-device-name", isText(device.name) ? device.name : "Phone"));
      var meta = make("div", "cce-conn-muted cce-conn-device-meta");
      var paired = formatDate(device.createdAt);
      if (paired) meta.appendChild(make("span", "", "paired " + paired));
      if (paired) meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(make("span", "", "last seen " + formatAgo(device.lastSeenAt)));
      if (device.push === true) {
        meta.appendChild(document.createTextNode(" · "));
        meta.appendChild(make("span", "", "notifications on"));
      }
      main.appendChild(meta);
      row.appendChild(main);
      row.appendChild(
        makeButton("cce-conn-btn cce-conn-secondary", "Remove", "remove:" + device.id, removeDevice(device.id))
      );
      section.appendChild(row);
      shown++;
    }
    if (!shown) section.appendChild(make("div", "cce-conn-muted", "No phones paired yet."));
    return section;
  }

  // The Claude in Chrome switch: while it's on, the bridge answers Claude in Chrome's routine permission
  // prompts in VS Code for the user (remote access on or off); flagged ones still ask.
  function chromeSection() {
    var on = status.chromeAutoAccept === true;
    var section = makeSection("Claude in Chrome");
    section.appendChild(
      makeLine(on ? "ok" : "off", [
        make("div", "cce-conn-strong", on ? "Auto-accept is on" : "Auto-accept is off"),
        make(
          "div",
          "cce-conn-muted",
          on ? "Claude in Chrome's routine permission prompts are answered for you in all your editor windows." : "You confirm Claude in Chrome's permission prompts yourself."
        ),
      ])
    );
    var label = busy === "chrome" ? "Saving…" : on ? "Turn off auto-accept" : "Turn on auto-accept";
    section.appendChild(
      makeActions([
        makeButton("cce-conn-btn cce-conn-secondary", label, "chrome-auto-accept", function () {
          act("chrome", "cce_remote_set_chrome_auto_accept", { on: !on });
        }),
      ])
    );
    section.appendChild(
      make(
        "div",
        "cce-conn-hint",
        "Only routine prompts are answered: those that Claude Code's safety checks flag still ask you. Each site is allowed for the rest of its session. A web page Claude reads could steer it without a prompt."
      )
    );
    return section;
  }

  function removeDevice(id) {
    return function () {
      act("remove", "cce_remote_remove_device", { id: id });
    };
  }

  function saveAppUrl(view) {
    act("save", "cce_remote_set_app_url", { url: String(view.input.value || "").trim() }, function () {
      showFlash("save");
    });
  }

  // The app address section stays in place across renders, so what's being typed survives.
  function appSection(view) {
    var section = makeSection("Phone app address");
    var field = make("div", "cce-conn-field");
    var input = make("input", "cce-conn-input");
    input.type = "url";
    input.placeholder = "https://cce-remote.example.com";
    input.spellcheck = false;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", "Phone app address");
    input.addEventListener(
      "keydown",
      guard(function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          saveAppUrl(view);
        }
      })
    );
    field.appendChild(input);
    var save = makeButton("cce-conn-btn cce-conn-secondary", "Save", "", function () {
      saveAppUrl(view);
    });
    field.appendChild(save);
    section.appendChild(field);
    section.appendChild(make("div", "cce-conn-hint", "Used in the pairing link and QR code."));
    view.input = input;
    view.save = save;
    return section;
  }

  function findKey(node, key) {
    if (node.getAttribute && node.getAttribute("data-cce-key") === key) return node;
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var hit = children[i].nodeType === 1 ? findKey(children[i], key) : null;
      if (hit) return hit;
    }
    return null;
  }

  function draw(view) {
    var active = document.activeElement;
    var focusKey = active && active !== view.input && view.box.contains(active) && active.getAttribute ? active.getAttribute("data-cce-key") : null;

    var top = make("div", "cce-conn-part");
    var head = make("div", "cce-conn-head");
    head.appendChild(make("h2", "cce-conn-title", "Phone remote"));
    head.appendChild(make("p", "cce-conn-intro", "Control this Mac's Claude Code sessions from your phone over Tailscale."));
    top.appendChild(head);
    var errors = [status && isText(status.error) ? status.error : "", actionError, fetchError];
    for (var i = 0; i < errors.length; i++) {
      if (errors[i] && errors.indexOf(errors[i]) === i) top.appendChild(makeNotice(errors[i]));
    }
    view.countdown = null;
    var bottom = make("div", "cce-conn-part");
    if (status) {
      top.appendChild(tailscaleSection());
      top.appendChild(primaryButton());
      if (status.enabled) top.appendChild(connectionSection());
      var pair = status.enabled ? pairSection(view) : null;
      if (pair) top.appendChild(pair);
      bottom.appendChild(devicesSection());
      // An older bridge's status has no switch: its tab offers none.
      if (typeof status.chromeAutoAccept === "boolean") bottom.appendChild(chromeSection());
    } else if (!fetchError) {
      top.appendChild(make("p", "cce-conn-muted", "Checking the connection…"));
    }
    view.box.replaceChild(top, view.top);
    view.top = top;
    view.box.replaceChild(bottom, view.bottom);
    view.bottom = bottom;

    view.app.hidden = !status;
    // The stored address, unless it's being edited.
    if (document.activeElement !== view.input) view.input.value = status && typeof status.appUrl === "string" ? status.appUrl : "";
    view.save.disabled = !!busy;
    view.save.textContent = flash === "save" ? "Saved" : "Save";

    if (focusKey) {
      var target = findKey(view.box, focusKey);
      if (target && !target.disabled) target.focus();
    }
  }

  function render() {
    var key;
    try {
      key = JSON.stringify([status, busy, flash, actionError, fetchError]);
    } catch (_) {
      key = String(Math.random());
    }
    if (key === shownKey) return;
    shownKey = key;
    for (var i = 0; i < views.length; i++) draw(views[i]);
  }

  function createView(el) {
    var view = { el: el, box: null, top: null, app: null, bottom: null, input: null, save: null, countdown: null, expiresAt: 0, askedForNewCode: false };
    var box = make("div", "cce-conn-view");
    // Keys typed here are the view's: the sessions list (Enter opens a session, arrows move)
    // and the chat's prompt shortcuts would act on them too. Shortcuts with a modifier still
    // bubble, so VS Code's keybindings (and copy and paste) keep working.
    box.addEventListener(
      "keydown",
      guard(function (event) {
        if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
      })
    );
    view.box = box;
    view.top = box.appendChild(make("div", "cce-conn-part"));
    view.app = box.appendChild(appSection(view));
    view.bottom = box.appendChild(make("div", "cce-conn-part"));
    el.appendChild(box);
    return view;
  }

  function stop() {
    if (pollTimer) clearTimeout(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (flashTimer) clearTimeout(flashTimer);
    pollTimer = 0;
    tickTimer = 0;
    flashTimer = 0;
    pollDelay = POLL_MS;
    flash = "";
  }

  // Drops the views whose element React took away or gave back to the sessions list (a ref is
  // called with null before the element leaves the page, so this runs a moment later).
  function prune() {
    var kept = [];
    for (var i = 0; i < views.length; i++) {
      var view = views[i];
      var el = view.el;
      if (el.isConnected !== false && el.classList && el.classList.contains("cce-conn")) kept.push(view);
      else if (view.box.parentNode === el) el.removeChild(view.box);
    }
    views = kept;
    if (!views.length) stop();
  }

  function attach(manager) {
    try {
      if (manager && typeof manager === "object") sessions = manager;
    } catch (error) {
      warn(error);
    }
  }

  function mount(el) {
    try {
      if (!el) {
        setTimeout(guard(prune), 0);
        return;
      }
      for (var i = 0; i < views.length; i++) if (views[i].el === el) return;
      var view = createView(el);
      views.push(view);
      draw(view);
      if (!tickTimer) tickTimer = setInterval(guard(tick), 1000);
      refresh();
    } catch (error) {
      warn(error);
    }
  }

  window.__cceRemote = { attach: attach, mount: mount, request: request };
})();
