# Scrollaroid Privacy Policy

_Last updated: 3 November 2026 (version 1.3)_

Scrollaroid is a Chrome extension that captures a full web page as an image and lets you crop and redact it. This policy explains what it does with your information. The short version: **nothing leaves your computer.**

## What Scrollaroid collects

Nothing. Scrollaroid has no servers, no accounts, no analytics and no advertising. It does not collect, transmit, sell or share any personal data, browsing history or screenshots.

## What happens to your screenshots

- When you click the Scrollaroid button or press its shortcut, it captures the page in the current tab, and only that tab.
- The captured images are stored temporarily in your browser's local storage on your own computer, so the editor can open them. They are deleted automatically after 24 hours.
- Crops and redactions happen entirely in your browser. When you download or copy the result, it goes straight to your computer or clipboard.
- For evidence captures, the page address, title, capture time, browser version and window size are written into the image and into the evidence package. Evidence packages are built on your computer and saved to your Downloads; nothing is sent anywhere.
- To make Find and redact work, Scrollaroid notes the words on the captured page and where they appear. This stays with the capture on your computer and is deleted with it.
- If you type a name or case reference when creating an evidence package, Scrollaroid remembers it in your browser's local extension storage so it's filled in next time. It never leaves your computer, and removing the extension deletes it.
- Scrollaroid never uploads screenshots anywhere.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `activeTab` | To capture the current tab, only after you click the button or press the shortcut. |
| `scripting` | To scroll the page during capture, show a progress indicator, let you select an area, temporarily hide repeating headers, and note where text sits for Find and redact. The page is put back as it was afterwards. |
| `unlimitedStorage` | To hold large captures locally while the editor opens. |
| `clipboardWrite` | For the "Copy" button in the editor. |
| `contextMenus` | Adds area, evidence and help options to the toolbar icon's right-click menu. |
| `storage` | Remembers the name and case reference you last entered for an evidence package. |

Scrollaroid cannot see or read any page until you activate it on that page.

## Third parties

Scrollaroid does not use any third-party services, libraries loaded from the internet, or tracking of any kind.

## Children

Scrollaroid does not knowingly collect information from anyone, including children.

## Changes

If this policy changes, the updated version will be posted here with a new date. Any change that introduced data collection would be stated clearly in the extension's store listing first.

## Contact

Questions about this policy can be raised as an issue on the [Scrollaroid GitHub repository](https://github.com/scottmcqueen/Scrollaroid/issues) or through [scottmcqueen.dev](https://scottmcqueen.dev).
