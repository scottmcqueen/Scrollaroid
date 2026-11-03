# Scrollaroid

A free, open-source Chrome extension that captures an entire scrolling page (or any part of it) as one image, then lets you crop it and black out anything private before saving.

## Install

1. Download or clone this repository somewhere permanent (Chrome loads it from that location).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the repository folder.
4. Optional: pin it from the puzzle-piece menu so the button is always visible.

## Use

| To | Do |
| --- | --- |
| Capture the full page | Click the toolbar button, or press **Alt+Shift+S** |
| Capture a selected area | Press **Alt+Shift+A** (or right-click the icon), then drag a box; drag past the edge to keep scrolling |
| Stop a long capture | Press **Esc** or click the icon again; you keep everything captured so far |

Change the shortcuts at `chrome://extensions/shortcuts`. A welcome page opens on install; it's also under **Help and shortcuts** when you right-click the icon.

### Editor

| Action | How |
| --- | --- |
| Black box | **Redact** tool (B), drag over anything to hide |
| Find and redact | **Find & redact** (F) finds email addresses, phone numbers, card numbers, usernames or any text you type, and covers the ones you pick |
| Adjust a box | Click it to select, drag to move, drag a handle to resize, arrow keys to nudge, Delete to remove |
| Crop | **Crop** tool (C), drag a box, adjust with the handles, then **Apply crop** or Enter |
| Undo / redo | Ctrl/⌘+Z, Ctrl/⌘+Shift+Z |
| Zoom | − / + buttons, Ctrl/⌘+scroll, 0 to fit |
| Save | **Download PNG** (Ctrl/⌘+S) or **Copy** (Ctrl/⌘+C) |
| Discard | **Cancel**, then confirm, deletes the capture and closes the tab |
| Help | **?** lists every shortcut |

Redaction boxes stay movable while you edit and are painted into the pixels when you download or copy, so nothing underneath is recoverable from the saved image. Find and redact only searches the page's text, not text inside images.

## How it works

- Fixed elements (headers, cookie bars, chat bubbles) appear once at the top instead of repeating in every frame; sticky headers are hidden only while stuck.
- Web-app layouts where the window itself doesn't scroll (an inner feed or panel does) are detected, and that panel is scrolled and stitched instead.
- Endless-scroll pages stop after 80 screens.
- Very tall pages are scaled down to stay within Chrome's 32,000 px canvas limit; the editor notes when that happens.
- Captures are kept locally for 24 hours so the editor tab survives a reload, then deleted. Nothing leaves your machine.

## Limits

Chrome doesn't allow extensions to capture `chrome://` pages, the Chrome Web Store, or the built-in PDF viewer. `file://` pages work only if "Allow access to file URLs" is enabled on the extension's details page.

## Packaging for the Chrome Web Store

The `store/` folder holds the listing images and isn't part of the extension. To build the upload zip:

```sh
zip -r scrollaroid.zip . -x 'store/*' 'README.md' 'PRIVACY.md' 'LICENSE' '.git*' '*.zip'
```

## Licence

Copyright © 2026 Scott McQueen.

Scrollaroid is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3** (see [`LICENSE`](LICENSE)). If you distribute a modified version, you must make its source available under the same licence.

Commercial rights are reserved by the author. Veriframe, the professional evidence-capture extension, is a separate product and is not covered by this licence. For other commercial licensing, contact the author.
