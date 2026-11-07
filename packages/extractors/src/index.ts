export type { Extractor, ExtractResult, Fetcher, FetchLike, ExecLike } from "./types.js";
export { createDefuddleExtractor } from "./defuddle.js";
export type { DefuddleExtractorOptions, ParseHtml } from "./defuddle.js";
export { createReadabilityExtractor } from "./readability.js";
export type { ReadabilityExtractorOptions } from "./readability.js";
export { createBrowserExtractor, profileDirForHost, isLoginWall } from "./browser.js";
export type { BrowserExtractorOptions } from "./browser.js";
export { cleanBrowserMarkdown } from "./clean.js";
export {
  createPatchrightExtractor,
  defaultPatchrightLaunch,
  patchrightProfileDir,
  htmlToMarkdown,
  textToMarkdown,
} from "./patchright.js";
export type {
  PatchrightExtractorOptions,
  PatchrightContext,
  PatchrightLaunch,
  PatchrightLauncher,
  PatchrightPage,
} from "./patchright.js";
export { createBrowseReader, toBrowseOutcome, profileDirFor } from "./browse-reader.js";
export type { BrowseReader, BrowseReaderOptions, BrowseReadOutcome, BrowseReadReason } from "./browse-reader.js";
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
