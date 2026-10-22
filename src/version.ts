/**
 * The SDK's own version, for the tracer scope, the `telemetry.distro.version`
 * resource attribute and the heartbeat payload, and exported as `VERSION`.
 *
 * A literal bumped by release-please (an `extra-files` entry), never read
 * from `package.json` at runtime: once an application bundles the SDK, a
 * path relative to this module resolves to the APPLICATION's package.json,
 * and every span would report the app's version as the SDK's.
 */
export const SDK_VERSION: string = "1.6.0"; // x-release-please-version
