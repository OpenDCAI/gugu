# Host screen capture

`screen.get` is a generic host action on macOS, Windows and Linux. It captures a picture through Electron's `desktopCapturer`; it does not load CUA, require Computer Use to be enabled, or read an accessibility tree. Existing screen grants, per-action denial and Deny All still apply. This intentionally changes the macOS result from text/AX metadata to the same picture response used on the other desktops.

The host requests a screen thumbnail, matches the primary display by `display_id`, and reports the image's actual dimensions. A single source without an id can represent a system-selected screen, including Linux PipeWire; multiple unidentified sources are not guessed. The resulting JPEG stays within the 1568-pixel longest-edge limit. The display count comes from Electron's screen registry.

macOS capture checks Electron's Screen Recording status before and after acquisition. Ordinary agent calls do not request a grant. The person's existing Screen Connect action requests Screen Recording through the generic permission helper, then verifies a real Electron capture. Helper success alone does not establish capture access; failed access keeps the group disconnected and reports the restart requirement. Accessibility permission and the CUA permission cache are not part of this path.

`screen.elements.find` remains a separate macOS accessibility query in the Computer Use family until that capability's App migration is delivered. Its target rules and the existing `computer.*` execution path are unchanged by this prerequisite. The next migration must preserve generic host screenshots while removing the CUA-only host implementation.

API references: [Electron 44 desktopCapturer](https://github.com/electron/electron/blob/v44.0.0/docs/api/desktop-capturer.md), [source identity and thumbnail sizing](https://github.com/electron/electron/blob/v44.0.0/docs/api/structures/desktop-capturer-source.md). These APIs do not guarantee that a returned thumbnail has the requested dimensions.

Validation uses injected Electron sources and real action-provider grants in the directed unit tests. They do not replace macOS permission/signing acceptance or the allocated real-window Calculator and Browser Use checks. See issue #1607 for the approved ownership and release order.
