/**
 * The failure type, on its own so that everything can throw it.
 *
 * It lived in `project.ts`, which meant the boundary — the lowest layer, which
 * depends on nothing — had to import the layer above it to report a failure.
 * That cycle left modules half-initialized at runtime and surfaced as a
 * `ReferenceError` naming an export that plainly exists.
 */

/** An expected failure that has already explained itself: printed as one line, no stack. */
export class JetbridgeError extends Error {
  override readonly name = 'JetbridgeError';
}

/** A function declaration, not an arrow: TypeScript only narrows control flow through one. */
export function fail(message: string): never {
  throw new JetbridgeError(message);
}
