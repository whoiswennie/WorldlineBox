/**
 * Which mouse buttons start a viewer pan gesture (image / video / GIF).
 *
 * Button 0 is the primary (left) button already used to drag the view.
 * Button 1 is the auxiliary (middle) button — the same “hold to pan”
 * habit as Photoshop’s hand / middle-mouse pan. Right-click (2) stays
 * with the context menu and must not pan.
 */
export function isViewerPanPointerButton(button: number): boolean {
  return button === 0 || button === 1;
}
