# Scrollaroid Privacy Policy

_Last updated: 3 November 2026 (version 2.0)_

Scrollaroid is a free, open-source Chrome extension that captures a web page as an image and lets you crop and redact it. The short version: **nothing leaves your computer.**

## What Scrollaroid collects

Nothing. Scrollaroid has no servers, no accounts, no analytics and no advertising. It does not collect, transmit, sell or share any personal data, browsing history or screenshots, and it makes no network requests of its own.

## What happens to your screenshots

- When you click the Scrollaroid button or press a shortcut, it captures the page in the current tab, and only that tab.
- The captured images are stored temporarily in your browser's local storage on your own computer, so the editor can open them. They are deleted automatically after 24 hours, or straight away if you click Cancel in the editor.
- To make Find and redact work, Scrollaroid notes the words on the captured page and where they appear. This stays with the capture on your computer and is deleted with it.
- Crops and redactions happen entirely in your browser. When you download or copy the result, it goes straight to your computer or clipboard.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `activeTab` | To capture the current tab, only after you click the button or press a shortcut. |
| `scripting` | To scroll the page during capture, show a progress indicator, let you select an area, temporarily hide repeating headers, and note where text sits for Find and redact. The page is put back as it was afterwards. |
| `unlimitedStorage` | To hold large captures locally while the editor opens. |
| `clipboardWrite` | For the "Copy" button in the editor. |
| `contextMenus` | Adds capture and help options to the toolbar icon's right-click menu. |

Scrollaroid cannot see or read any page until you activate it on that page.

## Third parties

None. Scrollaroid uses no third-party services, loads no code from the internet, and includes no tracking of any kind. You can check this yourself: the source code is public.

## Children

Scrollaroid does not knowingly collect information from anyone, including children.

## Changes

If this policy changes, the updated version will be posted here with a new date. Any change that introduced data collection would be stated clearly in the extension's store listing first.

## Contact

Questions about this policy can be raised as an issue on the [Scrollaroid GitHub repository](https://github.com/scottmcqueen/Scrollaroid/issues) or through [scottmcqueen.dev](https://scottmcqueen.dev).
