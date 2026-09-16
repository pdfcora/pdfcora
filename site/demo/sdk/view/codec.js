/**
 * Bumped when the shape changes incompatibly.
 *
 * Every envelope carries it and the decoder refuses anything else, so an older peer
 * fails loudly rather than misreading a newer message as if it understood it.
 */
export const WIRE_VERSION = 1;
export function encodeEvent(event) {
    return JSON.stringify({ v: WIRE_VERSION, ...event });
}
export function decodeEvent(wire) {
    const raw = JSON.parse(wire);
    if (raw['v'] !== WIRE_VERSION) {
        throw new Error(`unsupported view event version ${String(raw['v'])}, expected ${WIRE_VERSION}`);
    }
    const { v: _version, ...event } = raw;
    return event;
}
//# sourceMappingURL=codec.js.map