/**
 * Left offsets for the thinking track's stops. Both the native and web range inputs reserve a 16px thumb inset at
 * each end; a model with a single supported level centers its thumb instead of dividing by zero.
 */
export function thinkingStopOffsets(count: number, width: number): readonly number[] {
  if (count <= 0) return [];
  if (count === 1) return [16 + Math.max(0, width - 32) / 2];
  return Array.from({ length: count }, (_, index) => 16 + Math.max(0, width - 32) * index / (count - 1));
}

/**
 * Width of the selected track fill: up to the selected stop plus half a thumb, or the whole track when the model has
 * one level and there is nothing to step through.
 */
export function thinkingFillWidth(count: number, width: number, index: number): number {
  if (count <= 1) return Math.max(0, width - 8);
  return thinkingStopOffsets(count, width)[index]! + 8;
}
