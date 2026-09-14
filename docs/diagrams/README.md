# Interactive diagrams

HTML versions of the diagrams in [`../architecture.md`](../architecture.md) and
[`../data-model.md`](../data-model.md), because Mermaid renders them small and
cramped in a Markdown preview.

**Open [`index.html`](./index.html) in a browser.** No server, no build step, no
network — static files that work straight off disk over `file://`. The two pages
share one stylesheet and one script, and cross-link from the header.

```
index.html        9 architecture diagrams
data-model.html   sync spine, identity layer, cascade explorer, status lifecycle
styles.css        tokens, components, light + dark themes
diagrams.js       connector engine, viewport controls, both interactive widgets
```

## What it adds over the Markdown

| | |
|---|---|
| **Zoom / fit / pan / full screen** | Per diagram. Drag the canvas to pan; a diagram wider than its viewport shrinks to fit on load. |
| **Collapsible contents panel** | The header button or <kbd>[</kbd> hides the sidebar; diagrams reclaim its 236px and re-fit, so most jump back to 100%. Remembered in `localStorage`. |
| **Hover to isolate** | Hover or <kbd>Tab</kbd> to a box and everything it does not connect to dims. |
| **Live scope resolver** (§2) | The `function × provider` grid is a real matrix, and ticking functions recomputes `resolveScopes()` per provider in the browser. |
| **Cascade explorer** (data model §1) | Pick a row to delete and each table is marked <b>deleted</b>, <b>kept · link nulled</b>, or <b>untouched</b> — the `onDelete` clauses made visible. |
| **Dark mode** | Toggled in the header, remembered in `localStorage`, defaults to the OS setting. |

Zoom is automatic — a diagram is shrunk only as far as it must be to fit, and
grows back when room reappears (window resize, panel collapse). Touching the
zoom controls opts a figure out of that until you press **Reset**.

The §2 resolver mirrors
[`function-registry.ts`](../../src/core/registries/function-registry.ts) —
union across the selected functions, and a provider declaring nothing for any
one of them drops out. Scope values are transcribed from the
`ProviderDefinition`s in [`src/core/providers/`](../../src/core/providers/); if
those change, update `SCOPES` in `diagrams.js` and the matrix in `index.html`.

The data-model page is transcribed from
[`prisma/schema.prisma`](../../prisma/schema.prisma) — field names, types,
nullability, defaults, unique constraints and `onDelete` behaviour. The cascade
explorer's `CASCADE` table in `diagrams.js` encodes those same clauses; keep both
in step with the schema.

The cascade explorer covers **§1 only**. The four identity tables are drawn in
§2, so they have no node there to mark, and their `onDelete` behaviour is stated
in the explorer's prose instead of shown. That is a deliberate limit rather than
an omission — putting fifteen tables in one canvas made the spine unreadable,
and a cascade control that silently ignored a third of the schema would be
worse than one that says which third.

## How a diagram is built

Boxes are ordinary HTML laid out with CSS grid. Edges are **not** authored as
coordinates — each canvas carries a `data-edges` attribute, and `diagrams.js`
measures the real DOM and draws SVG beziers between the elements named:

```html
<div class="canvas dg-sync" id="c-sync" data-edges='[
  {"from":"p-wc","to":"p-wk","label":"external → internal index"},
  {"from":"p-g1","to":"p-fail","label":"no"}
]'>
```

| Key | Meaning |
|---|---|
| `from`, `to` | Element ids. Either endpoint may be a `.node`, a `.group`, or a `.lane-head`. |
| `label` | Optional. `\n` breaks the line. Placed at the curve midpoint. |
| `kind` | `"dashed"` for a relationship that must not exist (see §8). |
| `fs`, `ts` | Force the exit/entry side: `top`/`bottom`/`left`/`right`. |
| `bow` | Push the control points outward, to route around through a gutter. |

Sides are chosen automatically by comparing box centres, which is wrong
whenever two boxes overlap on an axis — the edge then leaves by the far side and
doubles back. That is what `fs`/`ts` are for; several edges here set them.

Geometry uses `offsetLeft`/`offsetTop` rather than `getBoundingClientRect`,
because the zoom control is a CSS `transform: scale()` and offsets ignore
transforms — so the wiring stays correct at any zoom.

### Two traps worth knowing before editing

1. **Never let an overlay take a grid placement.** A `.dg-* > * { grid-column: 2 }`
   rule matches the `<svg>` and label layers too, and an absolutely-positioned
   grid item *with* a grid placement is positioned against its grid area rather
   than the container — silently shifting every wire by the gutter width. Hence
   the `:not(svg):not(.wire-labels)` guards.
2. **Groups must not create a stacking context.** Painting order has to be group
   fill → wires → cards → labels. If `.group` takes a `z-index`, its cards are
   trapped beneath the wire layer.

## Colour

Three categorical hues (app/entry, providers/outside, pure logic) plus the
reserved status roles, on neutral cards for everything else. Both themes were
checked with the palette validator on the all-pairs gate: worst CVD ΔE 9.2 light
/ 9.4 dark, worst normal-vision ΔE 24.0 / 20.9.

Colour is never the only channel. Every box is labelled, decisions carry a **◆**
and persistence a **▤**, groups are titled, and "must never happen" edges are
dashed — so the diagrams survive greyscale printing and colour-vision
deficiency. `@media print` drops the chrome and expands every viewport.
