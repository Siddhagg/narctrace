# NarcTrace

**Digital Companion for Field Drug Testing** — SIH26231, Team Vertex231.

A client-only web app that acts as a digital companion for existing colorimetric
field drug-testing kits: it creates a unique, traceable Test ID tied to an
officer, timestamp and GPS location, guides a multi-photo capture of the test
reaction, and extracts colour information from each photo to assist (not
replace) visual interpretation.

## What it does

1. **Permissions** — requests camera and location access from the browser.
2. **Officer login** — captures officer name + badge/ID for the record (no
   backend account system; stored only in `sessionStorage` for the tab).
3. **Start New Test** — generates a unique Test ID (`FT-#####`), timestamps
   it, and resolves GPS coordinates to a city/state/approximate address via
   OpenStreetMap Nominatim, with a small embedded map.
4. **Guided capture** — live camera preview with a centre focus box; captures
   6 photos, sampling the focus-box colour live (~4×/second) and on each
   capture.
5. **Colour analysis** — converts sampled pixels to hex/RGB and matches them
   to the nearest common colour name (Red, Orange, Yellow, Green, Blue,
   Purple, Pink, Brown, Black, White, Gray).
6. **Report** — a single traceable record: Test ID, officer, time, location,
   all captured frames and their colour readings.
7. **Test History** — saved locally in the browser's `localStorage`. Nothing
   is uploaded to any server.

## Important positioning

NarcTrace **assists** the existing field-testing process. It does **not**
claim 100% AI drug detection — confirmatory laboratory testing remains
separate where required. This is reflected directly in the UI.

## Tech

Plain HTML/CSS/JS, no build step, no backend:

- Camera: `getUserMedia`
- Location: Geolocation API + [Nominatim](https://nominatim.openstreetmap.org/) reverse geocoding (free, no key)
- Map: embedded OpenStreetMap iframe (no key)
- Colour analysis: `<canvas>` pixel sampling in-browser
- Storage: `sessionStorage` (officer) + `localStorage` (test history)

## Running locally

Any static file server works, e.g.:

```bash
npx serve .
```

Then open the printed `http://localhost` URL — camera/location APIs require
a secure context (`https://` or `localhost`), so opening `index.html`
directly via `file://` will not work.

## Deployment

Deployed as a static site on Vercel.
