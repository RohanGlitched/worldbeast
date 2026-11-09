// Engravings of fixed seeds, drawn ahead of time by scripts/render-art.mjs with the game's own portrait code
// (the How-it-works specimens and the Hall's empty plates): no WebGL, no three.js, at 1x and 2x.
export const STATIC_PLATES = [1, 2, 5, 7, 10];

/** <img> props for a fixed-seed plate (360x300 framing, aspect 6:5), or null when the seed has none */
export function plateImg(seed) {
  if (!STATIC_PLATES.includes(seed)) return null;
  return { src: `/art/plates/${seed}.webp`, srcSet: `/art/plates/${seed}.webp 1x, /art/plates/${seed}@2x.webp 2x` };
}
