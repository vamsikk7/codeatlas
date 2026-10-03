/**
 * classBlockHeight.ts — BUG-POLAR-5.
 *
 * The L4 file-diagram renders each section (IMPORTS / VARIABLES / FUNCTIONS) as a
 * ClassBlockNode: a header plus a scrollable list of its items (component caps the
 * list at maxHeight 400 with overflow). But the Dagre layout sized every node at a
 * fixed NODE_HEIGHT (80), so a tall section (e.g. 41 imports ≈ 450px) overlapped the
 * sections laid out below it — text bled through. Estimating the ACTUAL rendered box
 * height from the item count (capped to the component's scroll max) lets the layout
 * allocate the right vertical space so sections no longer collide.
 */
export const CLASS_BLOCK_ROW_HEIGHT = 30;
export const CLASS_BLOCK_HEADER_HEIGHT = 44;
export const CLASS_BLOCK_MAX_ITEMS_HEIGHT = 400; // matches ClassBlockNode's list maxHeight

export function classBlockNodeHeight(itemCount: number): number {
    const items = Math.max(0, Math.floor(itemCount));
    const itemsHeight = Math.min(items * CLASS_BLOCK_ROW_HEIGHT, CLASS_BLOCK_MAX_ITEMS_HEIGHT);
    return CLASS_BLOCK_HEADER_HEIGHT + itemsHeight;
}
