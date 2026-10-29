// defuddle 0.19.x ships a CommonJS-shaped default export whose runtime
// value is the Defuddle class, but its bundled types describe a namespace.
// Declare the shape we actually consume.
declare module "defuddle" {
  export interface DefuddleMetadata {
    title?: string;
    description?: string;
    author?: string;
    published?: string;
    site?: string;
    language?: string;
    domain?: string;
    favicon?: string;
    image?: string;
    wordCount?: number;
    parseTime?: number;
  }

  export interface DefuddleOptions {
    url?: string;
    markdown?: boolean;
    separateMarkdown?: boolean;
    debug?: boolean;
  }

  export interface DefuddleResponse extends DefuddleMetadata {
    content: string;
    contentMarkdown?: string;
    extractorType?: string;
  }

  export default class Defuddle {
    constructor(doc: Document, options?: DefuddleOptions);
    parse(): DefuddleResponse;
    parseAsync(): Promise<DefuddleResponse>;
  }
}

declare module "pdfjs-dist/build/pdf.mjs" {
  export function getDocument(src: {
    data: Uint8Array;
    useSystemFonts?: boolean;
  }): { promise: Promise<unknown> };
  const pdfjs: { getDocument: typeof getDocument };
  export default pdfjs;
}
