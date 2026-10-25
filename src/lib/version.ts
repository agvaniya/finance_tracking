import pkg from "../../package.json";

/**
 * The build's version, taken from package.json so one edit moves it
 * everywhere it is shown. Scheme: major.feature.patch — the last part moves
 * for fixes and small builds, the middle for major features, the first only
 * by explicit decision.
 */
export const APP_VERSION: string = pkg.version;
