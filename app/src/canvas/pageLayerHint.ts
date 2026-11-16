/**
 * What the layers that ride with the board's page (its text, its marks, the
 * ink, the scene's overlays) are told about how they will move.
 *
 * A page turn back lends the board's own page to its sheet (see PageTurn's
 * `borrowBoard`) and moves those layers with `rotate` and `translate` every
 * frame. Told so, each is a compositor layer of its own and a frame is the
 * compositor's alone. Told so only when a turn started, the board's page was
 * painted again and rastered as a new layer at the turn's start, and again
 * when it landed: 40 to 50 ms of paint and up to 110 ms of raster on the
 * tablet, most of a quarter-second flick.
 */
export const PAGE_LAYER_WILL_CHANGE = "transform, rotate, translate";

/**
 * The `will-change` for the board's page layers.
 *
 * Held for page turns (`heldAt`: the zoom they were held at), they keep
 * `PAGE_LAYER_WILL_CHANGE`, moving or not. Otherwise, or once the zoom has
 * changed since, `transform` while the camera moves and nothing at rest: a
 * layer of its own keeps the scale it was rastered at, and dropped at rest
 * the page is drawn again sharp at the zoom it rests at.
 */
export function pageLayerWillChange(moving: boolean, heldAt: number | null, zoom: number): string {
  if (heldAt != null && heldAt > 0 && Math.abs(zoom - heldAt) <= heldAt * 1e-4) return PAGE_LAYER_WILL_CHANGE;
  return moving ? "transform" : "";
}
