/**
 * Whether the built-in fake Metrifox is serving.
 *
 * Gated on an explicit flag rather than on the absence of a key: the key is
 * per-integration, so "no key" means "not connected yet", not "use fixtures".
 * A mistyped key quietly falling through to fake data is exactly the failure
 * the connect-time probe exists to prevent.
 */
export function isMetrifoxFakeEnabled(): boolean {
  return process.env["ENABLE_METRIFOX_FAKE"] === "true";
}
