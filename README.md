# Scrollaroid

A Chrome extension that captures an entire scrolling page as one image, then lets you crop it and black out anything private before saving.

## Install

1. Download or clone this repository somewhere permanent (Chrome loads it from that location).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the repository folder.
4. Optional: pin it from the puzzle-piece menu so the button is always visible.

## Use

- Click the toolbar button, or press **Alt+Shift+S** (change it at `chrome://extensions/shortcuts`).
- The page scrolls itself while the badge shows progress; keep the tab in front until it finishes.
- An editor tab opens with the stitched image.

### Editor

| Action | How |
| --- | --- |
| Black box | **Redact** tool (B), drag over anything to hide |
| Adjust a box | Click it to select, drag to move, drag a handle to resize, arrow keys to nudge, Delete to remove |
| Crop | **Crop** tool (C), drag a box, adjust with the handles, then **Apply crop** or Enter |
| Undo / redo | Ctrl/⌘+Z, Ctrl/⌘+Shift+Z |
| Zoom | − / + buttons, Ctrl/⌘+scroll, 0 to fit |
| Save | **Download PNG** (Ctrl/⌘+S) or **Copy** (Ctrl/⌘+C) |
| Discard | **Cancel**, then confirm, deletes the capture and closes the tab |

Dragging near the edge of the window scrolls automatically, so a crop or redaction can span a long page.

Redaction boxes stay movable while you edit and are painted into the pixels when you download or copy, so nothing underneath is recoverable from the saved image.

## Evidence mode

For screenshots that may be used as evidence, right-click the toolbar icon and tick **Evidence mode**. The icon shows an orange **EV** badge while it's on. Captures taken in evidence mode:

- Hide nothing on the page, so the image matches exactly what was on screen (fixed headers may repeat).
- Fingerprint every raw screen image with SHA-256 the moment it's captured.
- Record the URL, page title, capture start and end times (UTC and local), browser version and window size.
- Stamp downloads and copies with a footer showing the URL, capture time, the original image's SHA-256 and a summary of edits, and embed the same details in the PNG metadata.

In the editor, **Evidence package** downloads a zip containing:

| File | What it is |
| --- | --- |
| `original.png` | The full stitched capture, unedited |
| `redacted.png` | The cropped and redacted copy, with the provenance footer |
| `frames/` | Every raw screen image exactly as captured |
| `report.pdf` | Capture details, method, edits, fingerprints and how to verify, followed by the redacted image |
| `manifest.json` | All of the above in machine-readable form, including crop and redaction coordinates and a timestamped edit log |
| `SHA256SUMS.txt` | Fingerprints of every file; check with `shasum -a 256 -c SHA256SUMS.txt` |

The package includes the unredacted original. Share only `redacted.png` or `report.pdf` with anyone who shouldn't see everything.

Evidence mode documents how a capture was made; it doesn't make a screenshot admissible on its own. Requirements vary by jurisdiction, so check with whoever is handling the matter.

## How it works

- Fixed elements (headers, cookie bars, chat bubbles) appear once at the top instead of repeating in every frame; sticky headers are hidden only while stuck. Evidence mode turns this off.
- Web-app layouts where the window itself doesn't scroll (an inner feed or panel does) are detected, and that panel is scrolled and stitched instead.
- Endless-scroll pages stop after 80 screens.
- Very tall pages are scaled down to stay within Chrome's 32,000 px canvas limit; the editor notes when that happens.
- Captures are kept locally for 24 hours so the editor tab survives a reload, then deleted. Nothing leaves your machine.

## Limits

Chrome doesn't allow extensions to capture `chrome://` pages, the Chrome Web Store, or the built-in PDF viewer. `file://` pages work only if "Allow access to file URLs" is enabled on the extension's details page.

## Packaging for the Chrome Web Store

The `store/` folder holds the listing images and isn't part of the extension. To build the upload zip:

```sh
zip -r scrollaroid.zip . -x 'store/*' 'README.md' '.git*' '*.zip'
```
