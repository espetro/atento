export type { Extractor, ExtractResult, Fetcher, FetchLike, ExecLike } from "./types.js";
export { createDefuddleExtractor } from "./defuddle.js";
export type { DefuddleExtractorOptions, ParseHtml } from "./defuddle.js";
export { createReadabilityExtractor } from "./readability.js";
export type { ReadabilityExtractorOptions } from "./readability.js";
export { createBrowserExtractor, profileDirForHost } from "./browser.js";
export type { BrowserExtractorOptions } from "./browser.js";
export { cleanBrowserMarkdown } from "./clean.js";
export { createPatchrightExtractor } from "./patchright.js";
export type { PatchrightExtractorOptions } from "./patchright.js";
export { createYtdlpExtractor, vttToTranscript } from "./ytdlp.js";
export type { YtdlpExtractorOptions } from "./ytdlp.js";
export { createPdfExtractor } from "./pdf.js";
export type { PdfExtractorOptions } from "./pdf.js";
export {
  createRouter,
  buildRouterDeps,
  routeFor,
} from "./router.js";
export type {
  RouterOptions,
  RouterDeps,
  RouteChoice,
  RoutedExtractResult,
  ExtractAttempt,
  HostRoutePolicy,
} from "./router.js";
