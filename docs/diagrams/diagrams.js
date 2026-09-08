/* ==========================================================================
   Architecture diagrams — connector engine, viewport controls, scope resolver.

   No build step, no dependencies, no network. Loaded as a classic script so
   the page works opened straight off disk (file://), where ES modules would
   be blocked by CORS.
   ========================================================================== */

(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  /* ---------------------------------------------------------------- theme */

  var root = document.documentElement;

  function storedTheme() {
    try { return localStorage.getItem("arch-theme"); } catch (e) { return null; }
  }

  (function initTheme() {
    var t = storedTheme();
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
  })();

  function currentTheme() {
    var t = root.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function bindTheme() {
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    function label() { btn.textContent = currentTheme() === "dark" ? "Light mode" : "Dark mode"; }
    label();
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("arch-theme", next); } catch (e) {}
      label();
      drawAll();
    });
  }

  /* ------------------------------------------------------ geometry helpers */

  /**
   * Offset of `el` inside `rootEl`, walking the offsetParent chain.
   *
   * Deliberately not getBoundingClientRect: the canvas carries a CSS
   * `transform: scale()` for zoom, and offset* values are layout units that
   * ignore transforms — so connector geometry stays correct at any zoom.
   */
  function offsetIn(el, rootEl) {
    var x = 0, y = 0, n = el;
    while (n && n !== rootEl) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent;
    }
    if (!n) return null; // not inside rootEl's offset chain
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function port(r, side) {
    if (side === "top") return [r.x + r.w / 2, r.y];
    if (side === "bottom") return [r.x + r.w / 2, r.y + r.h];
    if (side === "left") return [r.x, r.y + r.h / 2];
    return [r.x + r.w, r.y + r.h / 2];
  }

  function autoSides(a, b) {
    var dx = (b.x + b.w / 2) - (a.x + a.w / 2);
    var dy = (b.y + b.h / 2) - (a.y + a.h / 2);
    if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? ["bottom", "top"] : ["top", "bottom"];
    return dx > 0 ? ["right", "left"] : ["left", "right"];
  }

  function push(p, side, d) {
    return [
      p[0] + (side === "left" ? -d : side === "right" ? d : 0),
      p[1] + (side === "top" ? -d : side === "bottom" ? d : 0)
    ];
  }

  /**
   * Cubic bezier between two ports. For a cubic with these control points the
   * t=0.5 point reduces to (P0 + 3C0 + 3C1 + P3) / 8 — used to place the label.
   */
  function build(a, b, e) {
    var auto = autoSides(a, b);
    var s0 = e.fs || auto[0];
    var s1 = e.ts || auto[1];
    var p0 = port(a, s0);
    var p1 = port(b, s1);
    var bow = e.bow || 0;
    var v0 = s0 === "top" || s0 === "bottom";
    var v1 = s1 === "top" || s1 === "bottom";
    var c0, c1;

    if (bow) {
      c0 = push(p0, s0, bow);
      c1 = push(p1, s1, bow);
    } else if (v0 && v1) {
      var my = (p0[1] + p1[1]) / 2;
      c0 = [p0[0], my];
      c1 = [p1[0], my];
    } else if (!v0 && !v1) {
      var mx = (p0[0] + p1[0]) / 2;
      c0 = [mx, p0[1]];
      c1 = [mx, p1[1]];
    } else if (v0) {
      c0 = [p0[0], p1[1]];
      c1 = [p0[0], p1[1]];
    } else {
      c0 = [p1[0], p0[1]];
      c1 = [p1[0], p0[1]];
    }

    return {
      d: "M " + p0[0] + " " + p0[1] + " C " + c0[0] + " " + c0[1] + ", " +
         c1[0] + " " + c1[1] + ", " + p1[0] + " " + p1[1],
      mid: [
        (p0[0] + 3 * c0[0] + 3 * c1[0] + p1[0]) / 8,
        (p0[1] + 3 * c0[1] + 3 * c1[1] + p1[1]) / 8
      ]
    };
  }

  /* ------------------------------------------------------ connector engine */

  function ensureLayers(canvas) {
    var svg = canvas.querySelector("svg.wires");
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("class", "wires");
      svg.setAttribute("aria-hidden", "true");

      var defs = document.createElementNS(SVGNS, "defs");
      [["arw", "var(--edge)"], ["arwHi", "var(--edge-hi)"]].forEach(function (m) {
        var mk = document.createElementNS(SVGNS, "marker");
        mk.setAttribute("id", canvas.id + "-" + m[0]);
        mk.setAttribute("viewBox", "0 0 10 10");
        mk.setAttribute("refX", "9");
        mk.setAttribute("refY", "5");
        mk.setAttribute("markerWidth", "7");
        mk.setAttribute("markerHeight", "7");
        mk.setAttribute("orient", "auto-start-reverse");
        var tip = document.createElementNS(SVGNS, "path");
        tip.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
        tip.setAttribute("fill", m[1]);
        mk.appendChild(tip);
        defs.appendChild(mk);
      });
      svg.appendChild(defs);
      canvas.insertBefore(svg, canvas.firstChild);
    }

    var labels = canvas.querySelector(".wire-labels");
    if (!labels) {
      labels = document.createElement("div");
      labels.className = "wire-labels";
      labels.setAttribute("aria-hidden", "true");
      canvas.insertBefore(labels, canvas.querySelector("svg.wires").nextSibling);
    }
    return { svg: svg, labels: labels };
  }

  function drawCanvas(canvas) {
    var raw = canvas.getAttribute("data-edges");
    if (!raw) return;

    var edges;
    try {
      edges = JSON.parse(raw);
    } catch (err) {
      console.error("[diagrams] bad data-edges on #" + canvas.id, err);
      return;
    }

    var layers = ensureLayers(canvas);
    var svg = layers.svg;
    var labels = layers.labels;

    // Clear previous render (keep <defs>).
    Array.prototype.slice.call(svg.querySelectorAll("path")).forEach(function (p) { p.remove(); });
    labels.textContent = "";

    // scrollWidth/Height so wires still cover children that overflow the
    // canvas box (a diagram with its own min-width on a narrow screen).
    var w = Math.max(canvas.offsetWidth, canvas.scrollWidth);
    var h = Math.max(canvas.offsetHeight, canvas.scrollHeight);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    var drawn = [];

    edges.forEach(function (e) {
      var aEl = document.getElementById(e.from);
      var bEl = document.getElementById(e.to);
      if (!aEl || !bEl) {
        console.warn("[diagrams] #" + canvas.id + ": missing endpoint", e.from, "->", e.to);
        return;
      }
      var a = offsetIn(aEl, canvas);
      var b = offsetIn(bEl, canvas);
      if (!a || !b) return;

      var geo = build(a, b, e);

      var path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", geo.d);
      path.setAttribute("marker-end", "url(#" + canvas.id + "-arw)");
      if (e.kind === "dashed") path.setAttribute("class", "dash");
      svg.appendChild(path);

      var labelEl = null;
      if (e.label) {
        labelEl = document.createElement("div");
        labelEl.className = "wire-label";
        labelEl.textContent = e.label;
        labelEl.style.left = geo.mid[0] + "px";
        labelEl.style.top = geo.mid[1] + "px";
        labels.appendChild(labelEl);
      }

      drawn.push({ path: path, label: labelEl, from: e.from, to: e.to });
    });

    canvas._edges = drawn;
    wireHighlight(canvas);
  }

  /* ------------------------------------------------------------ highlight */

  function wireHighlight(canvas) {
    if (canvas._highlightBound) return;
    canvas._highlightBound = true;

    var targets = canvas.querySelectorAll(".node, .group, .lane-head");

    Array.prototype.forEach.call(targets, function (el) {
      if (!el.id) return;
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      el.addEventListener("mouseenter", function () { focusOn(canvas, el.id); });
      el.addEventListener("mouseleave", function () { clearFocus(canvas); });
      el.addEventListener("focus", function () { focusOn(canvas, el.id); });
      el.addEventListener("blur", function () { clearFocus(canvas); });
    });
  }

  function focusOn(canvas, id) {
    var edges = canvas._edges || [];
    var near = {};
    near[id] = true;

    edges.forEach(function (e) {
      var hit = e.from === id || e.to === id;
      e.path.classList.toggle("hi", hit);
      e.path.classList.toggle("dim", !hit);
      e.path.setAttribute("marker-end", "url(#" + canvas.id + (hit ? "-arwHi" : "-arw") + ")");
      if (e.label) {
        e.label.classList.toggle("hi", hit);
        e.label.classList.toggle("dim", !hit);
      }
      if (hit) {
        near[e.from] = true;
        near[e.to] = true;
      }
    });

    canvas.classList.add("focusing");
    Array.prototype.forEach.call(canvas.querySelectorAll(".node, .group"), function (el) {
      el.classList.toggle("near", !!near[el.id]);
    });
  }

  function clearFocus(canvas) {
    canvas.classList.remove("focusing");
    (canvas._edges || []).forEach(function (e) {
      e.path.classList.remove("hi", "dim");
      e.path.setAttribute("marker-end", "url(#" + canvas.id + "-arw)");
      if (e.label) e.label.classList.remove("hi", "dim");
    });
    Array.prototype.forEach.call(canvas.querySelectorAll(".near"), function (el) {
      el.classList.remove("near");
    });
  }

  /* ------------------------------------------------------------- viewport */

  var MIN_Z = 0.45, MAX_Z = 2.2;

  function contentWidth(canvas) { return Math.max(canvas.offsetWidth, canvas.scrollWidth); }

  function applyZoom(fig) {
    var canvas = fig.querySelector(".canvas");
    var vp = fig.querySelector(".viewport");
    if (!canvas || !vp) return;
    var z = fig._zoom;
    canvas.style.transform = z === 1 ? "" : "scale(" + z + ")";
    // The transform is out of flow for sizing, so the viewport is told how
    // tall the scaled canvas actually is.
    vp.style.height = z === 1 ? "" : (canvas.scrollHeight * z + 60) + "px";
    var out = fig.querySelector(".zoom-val");
    if (out) out.textContent = Math.round(z * 100) + "%";
  }

  function setZoom(fig, z) {
    fig._zoom = Math.min(MAX_Z, Math.max(MIN_Z, z));
    applyZoom(fig);
  }

  function fit(fig) {
    var canvas = fig.querySelector(".canvas");
    var vp = fig.querySelector(".viewport");
    if (!canvas || !vp) return;
    var avail = vp.clientWidth - 52;
    setZoom(fig, Math.min(1, avail / contentWidth(canvas)));
  }

  /** Shrink to fit only when the diagram genuinely overflows its viewport. */
  function fitIfOverflowing(fig) {
    var canvas = fig.querySelector(".canvas");
    var vp = fig.querySelector(".viewport");
    if (!canvas || !vp) return;
    if (contentWidth(canvas) > vp.clientWidth - 52) fit(fig);
  }

  /**
   * Re-derive the zoom for the space now available — used on load, on window
   * resize, and when the contents panel is collapsed.
   *
   * Resets to 100% first so a diagram that was shrunk to fit a narrow viewport
   * grows back when the room reappears. A figure the reader has zoomed by hand
   * is left alone until they press Reset.
   */
  function autoFit(fig) {
    if (fig._userZoomed) return;
    fig._zoom = 1;
    applyZoom(fig);
    fitIfOverflowing(fig);
  }

  /** Everything that has to happen after the available width changes. */
  function relayout() {
    drawAll();
    Array.prototype.forEach.call(document.querySelectorAll("figure.fig"), autoFit);
  }

  function bindFigure(fig) {
    fig._zoom = 1;

    var tools = fig.querySelector(".fig-tools");
    if (tools) {
      tools.addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        var act = btn.getAttribute("data-act");
        // A hand-set zoom sticks through resizes and panel toggles; Reset hands
        // the figure back to automatic sizing.
        if (act === "in") { fig._userZoomed = true; setZoom(fig, fig._zoom + 0.15); }
        else if (act === "out") { fig._userZoomed = true; setZoom(fig, fig._zoom - 0.15); }
        else if (act === "fit") { fig._userZoomed = true; fit(fig); }
        else if (act === "reset") { fig._userZoomed = false; setZoom(fig, 1); autoFit(fig); }
        else if (act === "full") {
          if (document.fullscreenElement === fig) document.exitFullscreen();
          else if (fig.requestFullscreen) fig.requestFullscreen();
        }
      });
    }

    // Drag to pan.
    var vp = fig.querySelector(".viewport");
    if (vp) {
      var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      vp.addEventListener("pointerdown", function (ev) {
        if (ev.target.closest(".node, .group, a, button, input, label")) return;
        dragging = true;
        sx = ev.clientX; sy = ev.clientY;
        sl = vp.scrollLeft; st = vp.scrollTop;
        vp.classList.add("grabbing");
        vp.setPointerCapture(ev.pointerId);
      });
      vp.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        vp.scrollLeft = sl - (ev.clientX - sx);
        vp.scrollTop = st - (ev.clientY - sy);
      });
      ["pointerup", "pointercancel"].forEach(function (t) {
        vp.addEventListener(t, function () { dragging = false; vp.classList.remove("grabbing"); });
      });
    }
  }

  /* ---------------------------------------------------------------- redraw */

  function drawAll() {
    Array.prototype.forEach.call(document.querySelectorAll(".canvas[data-edges]"), drawCanvas);
  }

  /* --------------------------------------------------------- scope resolver
     Mirrors src/core/registries/function-registry.ts:
       resolveScopes(fns, provider) — union across fns, throws if any fn
       declares no scopes for that provider.
       providerNamesForFunctions(fns) — intersection of per-function support.
     Values transcribed from the provider definitions in src/core/providers/.
  ---------------------------------------------------------------------------*/

  var PROVIDERS = [
    { name: "hubspot", label: "HubSpot", kind: "OAuth" },
    { name: "salesforce", label: "Salesforce", kind: "OAuth" },
    { name: "metrifox", label: "Metrifox", kind: "API key" },
    { name: "stripe", label: "Stripe", kind: "API key" },
    { name: "mock", label: "Mock CRM", kind: "OAuth" }
  ];

  var SCOPES = {
    identity: {
      hubspot: ["crm.objects.companies.read", "crm.objects.contacts.read",
                "crm.schemas.companies.read", "crm.schemas.contacts.read"],
      salesforce: ["api", "refresh_token"],
      metrifox: ["customers:read", "contacts:read"],
      // Customers only: Stripe has no contact resource, so ours are synthesized
      // from customer fields and nothing extra is read.
      stripe: ["customers:read"],
      mock: ["crm.objects.companies.read", "crm.objects.contacts.read", "crm.schemas.read"]
    },
    support: {
      hubspot: ["tickets", "crm.objects.tickets.read", "crm.schemas.tickets.read"],
      salesforce: ["api", "refresh_token"],
      mock: ["crm.objects.tickets.read", "crm.schemas.read"]
    },
    billing: { mock: ["billing.invoices.read"] },
    usage: {},
    communication: {}
  };

  var FN_LABEL = {
    identity: "Identity", support: "Support", billing: "Billing",
    usage: "Usage", communication: "Communication"
  };

  function resolveScopes(fns, provider) {
    var set = {};
    for (var i = 0; i < fns.length; i++) {
      var byProvider = SCOPES[fns[i]] || {};
      var list = byProvider[provider];
      if (!list || !list.length) return null; // the real function throws here
      for (var j = 0; j < list.length; j++) set[list[j]] = true;
    }
    return Object.keys(set).sort();
  }

  function unsupportedFor(fns, provider) {
    return fns.filter(function (f) {
      var byProvider = SCOPES[f] || {};
      return !byProvider[provider] || !byProvider[provider].length;
    });
  }

  function bindResolver() {
    var host = document.getElementById("resolverOut");
    if (!host) return;
    var boxes = document.querySelectorAll(".fn-picker input[type=checkbox]");

    function render() {
      var fns = [];
      Array.prototype.forEach.call(boxes, function (b) { if (b.checked) fns.push(b.value); });

      host.textContent = "";

      if (!fns.length) {
        var empty = document.createElement("div");
        empty.className = "pcard off";
        empty.style.gridColumn = "1 / -1";
        empty.innerHTML = "<h4>No functions selected</h4>" +
          "<p class='why'>Selecting nothing yields no providers rather than all of them — " +
          "<code>providerNamesForFunctions([])</code> returns an empty list.</p>";
        host.appendChild(empty);
        return;
      }

      // Baseline = the first selected function alone, so added scopes are visible.
      var base = {};
      PROVIDERS.forEach(function (p) {
        var b = resolveScopes([fns[0]], p.name);
        base[p.name] = {};
        if (b) b.forEach(function (s) { base[p.name][s] = true; });
      });

      PROVIDERS.forEach(function (p) {
        var scopes = resolveScopes(fns, p.name);
        var card = document.createElement("div");

        if (!scopes) {
          var missing = unsupportedFor(fns, p.name).map(function (f) { return FN_LABEL[f]; });
          card.className = "pcard off";
          card.innerHTML =
            "<h4><span class='dot no'></span>" + p.label + " <span class='kind'>" + p.kind + "</span></h4>" +
            "<p class='count'>not offered</p>" +
            "<p class='why'>Declares no scopes for <b>" + missing.join("</b>, <b>") + "</b>, " +
            "so it is filtered out of the picker.</p>";
        } else {
          var chips = scopes.map(function (s) {
            var added = fns.length > 1 && !base[p.name][s];
            return "<span class='chip " + (added ? "add" : "on") + "'>" + s + "</span>";
          }).join("");
          var addedCount = scopes.filter(function (s) { return fns.length > 1 && !base[p.name][s]; }).length;
          card.className = "pcard";
          card.innerHTML =
            "<h4><span class='dot ok'></span>" + p.label + " <span class='kind'>" + p.kind + "</span></h4>" +
            "<p class='count'>" + scopes.length + " scope" + (scopes.length === 1 ? "" : "s") +
            (fns.length > 1 ? " · " + (addedCount ? "+" + addedCount + " added" : "unchanged") : "") + "</p>" +
            chips;
        }
        host.appendChild(card);
      });
    }

    Array.prototype.forEach.call(boxes, function (b) { b.addEventListener("change", render); });
    render();
  }

  /* ------------------------------------------------------ cascade explorer
     data-model.html §1. Transcribed from the `onDelete` clauses in
     prisma/schema.prisma: User→Integration, User→IntegrationDraft and all seven
     Integration→child relations are Cascade; Customer→Contact alone is SetNull.
     OAuthState appears in none of them — it has no foreign key, because its
     `subjectId` names a row in one of two tables depending on `subjectKind`.
  ---------------------------------------------------------------------------*/

  var UNDER_INTEGRATION = [
    "e-fn", "e-token", "e-mapping", "e-discovered",
    "e-customer", "e-contact", "e-syncrun"
  ];

  var CASCADE = {
    user: {
      gone: ["e-user", "e-integration", "e-draft"].concat(UNDER_INTEGRATION),
      note: "<b>Cascade all the way down.</b> <code>User → Integration</code> is " +
            "<code>onDelete: Cascade</code>, and so is every relation beneath it — one " +
            "delete removes that user's integrations and every credential, mapping, " +
            "synced record and run underneath, plus any half-finished draft. Nothing is " +
            "left orphaned."
    },
    integration: {
      gone: ["e-integration"].concat(UNDER_INTEGRATION),
      kept: ["e-user", "e-draft"],
      note: "<b>The tenancy boundary.</b> Every table below carries " +
            "<code>integrationId</code>, so removing one integration is a clean sweep — " +
            "and the reason no query can leak another integration's data by omission. " +
            "The owning <code>User</code> is untouched."
    },
    customer: {
      gone: ["e-customer"],
      unlinked: ["e-contact"],
      note: "<b>Deliberately not a cascade.</b> <code>Customer → Contact</code> is " +
            "<code>SetNull</code>: losing a company record must not silently delete the " +
            "people attached to it. Each contact survives with <code>customerId = null</code> " +
            "and keeps its <code>externalCustomerId</code>, so a later sync can relink it."
    }
  };

  function bindCascade() {
    var pick = document.getElementById("cascadePick");
    var out = document.getElementById("cascadeOut");
    var canvas = document.getElementById("c-er");
    if (!pick || !out || !canvas) return;

    var IDLE = "Every relation below is <code>Cascade</code> except one. Pick a row to " +
               "delete and the tables will show what goes with it.";

    function mark(ids, cls, word) {
      (ids || []).forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.add(cls);
        var slot = el.querySelector(".ent-state");
        if (slot) slot.textContent = word;
      });
    }

    function render() {
      Array.prototype.forEach.call(canvas.querySelectorAll(".ent"), function (el) {
        el.classList.remove("st-gone", "st-unlinked", "st-kept");
        var slot = el.querySelector(".ent-state");
        if (slot) slot.textContent = "";
      });

      var checked = pick.querySelector("input:checked");
      var spec = checked ? CASCADE[checked.value] : null;

      if (!spec) {
        canvas.classList.remove("cascading");
        out.innerHTML = IDLE;
        return;
      }

      canvas.classList.add("cascading");
      mark(spec.gone, "st-gone", "deleted");
      mark(spec.unlinked, "st-unlinked", "kept · link nulled");
      mark(spec.kept, "st-kept", "untouched");
      out.innerHTML = spec.note;
    }

    pick.addEventListener("change", render);
    render();
  }

  /* ------------------------------------------------- contents panel toggle */

  function navIsOff() { return root.getAttribute("data-nav") === "off"; }

  function bindNav() {
    var btn = document.getElementById("navBtn");
    if (!btn) return;

    // The inline head script normally sets this already; repeated here so the
    // toggle still works if that script is stripped.
    try {
      if (localStorage.getItem("arch-nav") === "off") root.setAttribute("data-nav", "off");
    } catch (e) {}

    function sync() {
      var off = navIsOff();
      btn.setAttribute("aria-expanded", off ? "false" : "true");
      btn.classList.toggle("is-off", off);
      btn.title = (off ? "Show contents" : "Hide contents") + "  [";
      var txt = btn.querySelector(".nav-txt");
      if (txt) txt.textContent = off ? "Show contents" : "Hide contents";
    }

    function toggle() {
      var off = navIsOff();
      if (off) root.removeAttribute("data-nav");
      else root.setAttribute("data-nav", "off");
      try { localStorage.setItem("arch-nav", off ? "on" : "off"); } catch (e) {}
      sync();
      relayout();
    }

    sync();
    btn.addEventListener("click", toggle);

    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "[" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      ev.preventDefault();
      toggle();
    });
  }

  /* --------------------------------------------------------- contents nav */

  function bindToc() {
    var toc = document.getElementById("toc");
    if (!toc) return;
    var figs = document.querySelectorAll("figure.fig[id]");

    Array.prototype.forEach.call(figs, function (fig) {
      var h = fig.querySelector(".fig-head h2");
      if (!h) return;
      var num = h.querySelector(".n");
      var a = document.createElement("a");
      a.href = "#" + fig.id;
      a.innerHTML = "<span class='toc-num'>" + (num ? num.textContent.trim() : "") + "</span>" +
        h.textContent.replace(num ? num.textContent : "", "").trim();
      toc.appendChild(a);
    });

    if (!("IntersectionObserver" in window)) return;
    var links = toc.querySelectorAll("a");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        Array.prototype.forEach.call(links, function (l) {
          l.classList.toggle("active", l.getAttribute("href") === "#" + en.target.id);
        });
      });
    }, { rootMargin: "-84px 0px -66% 0px" });
    Array.prototype.forEach.call(figs, function (f) { io.observe(f); });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    bindTheme();
    bindNav();
    bindToc();
    bindResolver();
    bindCascade();
    var figs = document.querySelectorAll("figure.fig");
    Array.prototype.forEach.call(figs, bindFigure);
    relayout();

    // Fonts can settle after first paint and shift layout under the wires.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

    // Widening or narrowing the window changes what fits, same as the panel.
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(relayout, 120);
    });

    // Catches reflow the resize listener does not see — a canvas that changes
    // height because its own text rewrapped, for instance.
    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(function (entries) {
        entries.forEach(function (en) { drawCanvas(en.target); });
      });
      Array.prototype.forEach.call(document.querySelectorAll(".canvas[data-edges]"), function (c) {
        ro.observe(c);
      });
    }

    document.addEventListener("fullscreenchange", function () { setTimeout(drawAll, 60); });
    window.addEventListener("beforeprint", drawAll);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
