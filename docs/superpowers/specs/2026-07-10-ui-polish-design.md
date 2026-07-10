# UI Polish Design

## Direction

Keep the current layout, typography, spacing, and control priority intact. Apply a quiet-print finish with restrained stage-light accents so the app feels more tactile without competing with the book.

## Surfaces

- Add one very low-contrast, CSS-only grain treatment to the top bar, sidebar, settings panel, and player.
- Keep the reader background completely texture-free for maximum legibility.
- Use the existing theme colors; add no new palette or image asset.
- Give chrome surfaces a faint inset highlight and cleaner hairline separation for depth.

## Interactive polish

- Reuse the existing accent and glow tokens for hover, pressed, selected, and playing states.
- Make active states feel related: restrained glow, consistent contrast, and a small pressed response.
- Preserve every touch target, responsive priority, and keyboard focus ring.
- Do not add animation beyond the short transitions already present.

## Scope

This is a CSS-only pass in `src/styles.css`. It does not change layout, JSX, reader rendering, playback behavior, preferences, or stored data.

## Verification

- Check dark and light themes at mobile, tablet, and desktop widths.
- Confirm the reader remains texture-free and text contrast is unchanged.
- Run the existing unit tests, production build, and browser smoke suite.
