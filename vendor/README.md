# Third-party files served by OSQA

These are exact copies of the published files, served from this site so OSQA needs nothing from
the internet (and runs on a company network that blocks public CDNs). Each script is still loaded
with its integrity hash, so a changed file is refused by the browser.

| File | Version | Source | Licence |
|---|---|---|---|
| `chart.umd.min.js` | Chart.js 4.4.0 | npm `chart.js` | MIT — `LICENSES/chart.js.txt` |
| `lucide.min.js` | Lucide 0.383.0 | npm `lucide` | ISC — `LICENSES/lucide.txt` |
| `html2canvas.min.js` | html2canvas 1.4.1 | npm `html2canvas` | MIT — `LICENSES/html2canvas.txt` |
| `jspdf.umd.min.js` | jsPDF 2.5.1 | npm `jspdf` | MIT — `LICENSES/jspdf.txt` |
| `heic2any.min.js` | heic2any 0.0.4 | npm `heic2any` | MIT (package.json; no licence file is published). It contains a compiled build of libheif, which is LGPL-3.0: it is shipped as this separate, replaceable file and only runs inside the sealed converter frame (`heic.html`). |
| `fonts/cairo-*.woff2`, `fonts/cairo.css` | Cairo (variable, 400–900) | Google Fonts | SIL Open Font License 1.1 — `fonts/OFL.txt` |

To update a library: replace the file, then update its `integrity="sha384-…"` everywhere it is
loaded (`openssl dgst -sha384 -binary FILE | openssl base64 -A`).
