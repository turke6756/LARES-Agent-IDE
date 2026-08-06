# Lares marketing site — first slice

This directory is a dependency-free static prototype containing the site shell,
hero, and Act 1 of the scroll story. Open `index.html` directly in a modern
browser; no build step or local server is required.

## What is here

- The hero uses `Terminal_1.png` as a temporary image. A TODO in `index.html`
  marks it for replacement with the final sanitized hero still.
- Act 1 reconstructs four fictional editor windows in HTML/CSS. It does not use
  the private VS Code screenshots. Project names and code-like lines are
  fictional/abstract.
- The Act 1 payoff is real Lares footage cropped from the source master. Run
  `./encode-media.sh` from a shell with `ffmpeg` on PATH to regenerate the
  desktop/mobile MP4s and poster frames in `media/`. The footage is cleared for
  publication; `VS_Code_JobHunt.png` is not cleared and must never be used.
- Links use `#` placeholders until final GitHub and installation/docs URLs are
  selected.

Desktop Act 1 uses native scrolling, a sticky visual, and CSS motion driven by a
single `--progress` property. Below 768px it becomes normal document flow. With
reduced motion enabled it shows the payoff state, disables autoplay, and exposes
video controls. Captions remain semantic HTML and readable without JavaScript.
The current encoded desktop MP4 is 107,254 bytes; the mobile MP4 is 60,940
bytes.

## Not built yet

Acts 2 and 3 and all later feature sections are intentionally empty section
placeholders in `index.html`. Final copy, the final hero still, production URLs,
and later story media remain outstanding.
