# MACPrep — Brand & Logo Spec

The MACPrep mark is the **pulse tile**: a rounded green tile with a white ECG/pulse trace — a nod to
the anesthesia vitals monitor, and to "is this answer alive / correct." Chosen 2026-06-28.

## Files in this folder
| File | Use |
|------|-----|
| `macprep-mark.svg` | Primary mark — green tile + white pulse. App icon, favicon, social avatar base. Pure vector, no font needed. |
| `macprep-mark-ink.svg` | Ink-tile variant (green pulse) for special/dark contexts. |
| `macprep-pulse-white.svg` | Pulse only, transparent — knockout for placing on photos/solid colors. |
| `macprep-logo-horizontal.svg` | Mark + "MACPrep" wordmark, for **light** backgrounds. |
| `macprep-logo-horizontal-dark.svg` | Mark + wordmark, for **dark** backgrounds. |

## Colors
| Token | Hex | Use |
|-------|-----|-----|
| Brand green | `#146A4A` | Tile, "Prep" on light, primary |
| Bright green | `#2FA36B` | Interactive / accents |
| Mint | `#4FCC8E` / `#B7E9CF` | "Prep" on dark, highlights |
| Ink | `#0E1512` | "MAC", text, ink tile |
| Paper | `#F5F7F5` | Light surfaces |
| Pulse white | `#FFFFFF` | The trace on the green tile |

## Type
- **Wordmark:** Figtree, weight 800, letter-spacing ~-1. "MAC" in ink, "Prep" in green (mint on dark).
- **Technical accents / labels:** JetBrains Mono (matches the mono labels already in the app).
- _For print or any offline use, outline the wordmark text to paths so it never depends on the font._

## Usage rules
- **Clear space:** keep empty space around the logo ≥ the height of the tile's corner radius (~22% of
  the tile). Don't crowd it.
- **Min size:** mark works down to 16px (favicon). Don't show the horizontal lockup below ~20px tall —
  use the mark alone instead.
- **Backgrounds:** green tile sits on light *or* dark. On busy photos, use `macprep-pulse-white.svg`
  knockout or place the mark on a solid tile first.
- **Don't:** recolor the tile off-brand, stretch/skew, add gradients or drop shadows, rotate the pulse,
  or set the wordmark in a different font.

## Exporting PNGs (for platforms that need raster)
The SVGs are the source of truth. To rasterize:
- **Favicon set:** export `macprep-mark.svg` at 16, 32, 48, 180 (Apple touch), 512 px.
- **Social avatar:** export `macprep-mark.svg` at 512×512 (platforms crop to a circle — the pulse stays
  centered and safe).
- Tools: open in a browser/Figma/Inkscape and export, or `rsvg-convert -w 512 macprep-mark.svg > out.png`.
- Modern browsers also accept the SVG directly as a favicon (`<link rel="icon" href="macprep-mark.svg">`).

## Wiring it into the site (dev-thread task)
Replacing the current header logo, favicon, and OG/social share image is a code change — hand that to
the dev conversation. This folder is the asset source; the site wiring is separate.
