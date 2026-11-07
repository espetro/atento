export interface paths {
    "/api/pair/code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Issue a one-time pairing code for POST /api/pair
         * @description Returns a short-lived, single-use code. Display it to the user; the client redeems it at POST /api/pair for the bearer tokens.
         */
        get: operations["getApiPairCode"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pair": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Redeem a one-time pairing code for bearer tokens
         * @description Exchanges a code from GET /api/pair/code for the capture and server bearer tokens. Single-use; 401 on unknown, expired or already-redeemed codes. Not bearer-gated: the code is the credential.
         */
        post: operations["postApiPair"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/capture": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ingest one client capture (browser extension / script)
         * @description Bearer-token authenticated capture endpoint. Only enabled when the capture token env var is set; CORS is restricted to configured origins.
         */
        post: operations["postCapture"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ingest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bulk-ingest links (multipart file, text/plain, or JSON kind) */
        post: operations["postApiIngest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/ingest/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Progress of one ingest job */
        get: operations["getApiIngestByJobId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/collections/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Counts per pipeline collection plus needs_login per host */
        get: operations["getApiCollectionsSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/collections/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one collection: json (default), tsv, or streaming jsonl/md. `since`/`cursor` resume a delta; the cursor comes back in the body or the x-linkinbox-cursor header. */
        get: operations["getApiCollectionsByName"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/collections/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Export one collection (or its delta) to a file */
        post: operations["postApiCollectionsExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List links (UI projection plus pipeline state fields) */
        get: operations["getApiLinks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pipeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Pipeline overview: state counts, park reasons, busiest hosts */
        get: operations["getApiPipeline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/triage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply one triage action to many link ids */
        post: operations["postApiLinksTriage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get one link (detail projection) */
        get: operations["getApiLinksById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Patch user-editable link fields (title, note, tags) */
        patch: operations["patchApiLinksById"];
        trace?: never;
    };
    "/api/links/{id}/reextract": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-extract one link (FSM RETRY + scoped extract run) */
        post: operations["postApiLinksByIdReextract"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/links/{id}/artifacts/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one stored artifact for a link */
        get: operations["getApiLinksByIdArtifactsByName"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run one full pipeline pass: ingest configured sources, extract until empty, enrich until empty, sweep. Returns cursors bracketing the pass and a per-stage summary. */
        post: operations["postApiRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One run-journal row by id (stage, status, counters, tokens) */
        get: operations["getApiRunsById"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recent run-journal rows, newest first */
        get: operations["getApiRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/browsers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Configured browser adapters with capabilities and health — the same dataset `linkinbox browsers` prints. */
        get: operations["getApiBrowsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read-only config summary for the settings UI: sources, capture/server token configuration (booleans only — never values), the config file path and the bind this server answers on. */
        get: operations["getApiConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Server-sent events: link state transitions, run start/finish and ingest job progress. Every frame id is evt:{l,r,i} — the composite resume cursor for all three families; reconnect with Last-Event-ID or ?since= to replay without gaps. */
        get: operations["getApiEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sweep": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Dry-run sweep plan grouped by category */
        get: operations["getApiSweep"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sweep/apply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Apply the sweep plan (archive only, never delete) */
        post: operations["postApiSweepApply"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Per-stage metrics summary plus daily token/cost buckets */
        get: operations["getApiMetrics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getApiPairCode: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pairing code issued */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        code: string;
                        expiresAt: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    postApiPair: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    code: string;
                };
            };
        };
        responses: {
            /** @description Tokens for the client to store */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        captureToken: string | null;
                        serverToken: string | null;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    postCapture: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Capture ingested (duplicate url) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: number;
                        url: string;
                        title: string | null;
                        status: string;
                        state?: string;
                        reason?: string | null;
                        host?: string;
                        added_at?: string;
                        updated_at?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Capture ingested (new link) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: number;
                        url: string;
                        title: string | null;
                        status: string;
                        state?: string;
                        reason?: string | null;
                        host?: string;
                        added_at?: string;
                        updated_at?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    postApiIngest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @constant */
                    kind: "urls";
                    urls: string[];
                    note?: string;
                    tags?: string[];
                } | {
                    /** @constant */
                    kind: "remote";
                    url: string;
                } | {
                    /** @constant */
                    kind: "file";
                    path: string;
                } | {
                    /** @constant */
                    kind: "text";
                    text: string;
                };
                "text/plain": string;
                "multipart/form-data": {
                    /** Format: binary */
                    file: string;
                };
            };
        };
        responses: {
            /** @description Job accepted (or already running — check status "busy") */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        jobId: string;
                        accepted: number;
                        duplicates: number;
                        rejected: number;
                        /** @enum {string} */
                        status: "pending" | "running" | "done" | "failed" | "busy";
                        warnings: string[];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Another ingest run holds the lock (status "busy") */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        jobId: string;
                        accepted: number;
                        duplicates: number;
                        rejected: number;
                        /** @enum {string} */
                        status: "pending" | "running" | "done" | "failed" | "busy";
                        warnings: string[];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiIngestByJobId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        job: {
                            jobId: string;
                            source: string;
                            /** @enum {string} */
                            status: "pending" | "running" | "done" | "failed";
                            total: number;
                            done: number;
                            cursor: number;
                            runId: number | null;
                            error: string | null;
                            createdAt: string;
                            updatedAt: string;
                            finishedAt: string | null;
                        } & {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiCollectionsSummary: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Collection summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        total?: number;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getApiCollectionsByName: {
        parameters: {
            query?: {
                since?: number;
                cursor?: number;
                format?: "json" | "tsv" | "jsonl" | "md";
                fields?: string;
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                name: "enriched" | "pending" | "needs_login" | "blocked" | "errored" | "review" | "triaged";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Collection rows (json) or a serialized stream (tsv/jsonl/md) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rows: {
                            [key: string]: unknown;
                        }[];
                        cursor: number;
                    } & {
                        [key: string]: unknown;
                    };
                    "text/tab-separated-values": string;
                    "application/x-ndjson": string;
                    "text/markdown": string;
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    postApiCollectionsExport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    name: "enriched" | "pending" | "needs_login" | "blocked" | "errored" | "review" | "triaged";
                    since?: number;
                    fields?: string[];
                    /** @enum {string} */
                    format?: "jsonl" | "md" | "tsv";
                };
            };
        };
        responses: {
            /** @description Export handle { path, uri, count, bytes } */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiLinks: {
        parameters: {
            query?: {
                q?: string;
                status?: "inbox" | "scheduled" | "archived" | "discarded";
                state?: string;
                category?: string;
                host?: string;
                stale?: string;
                collection?: "enriched" | "pending" | "needs_login" | "blocked" | "errored" | "review" | "triaged";
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Links page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: ({
                            id: number;
                            url: string;
                            title: string | null;
                            status: string;
                            state?: string;
                            reason?: string | null;
                            host?: string;
                            added_at?: string;
                            updated_at?: string;
                        } & {
                            [key: string]: unknown;
                        })[];
                        total: number;
                    };
                };
            };
        };
    };
    getApiPipeline: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pipeline overview */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        byState: {
                            [key: string]: number;
                        };
                        byParkReason: {
                            [key: string]: number;
                        };
                        byHost: ({
                            host: string;
                            total: number;
                        } & {
                            [key: string]: unknown;
                        })[];
                    };
                };
            };
        };
    };
    postApiLinksTriage: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    ids: number[];
                    /** @enum {string} */
                    action: "read_now" | "schedule" | "archive" | "discard";
                };
            };
        };
        responses: {
            /** @description Triage result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiLinksById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Link detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: number;
                        url: string;
                        title: string | null;
                        status: string;
                        state?: string;
                        reason?: string | null;
                        host?: string;
                        added_at?: string;
                        updated_at?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    patchApiLinksById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: number;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    title?: string | null;
                    note?: string | null;
                    tags?: string[];
                };
            };
        };
        responses: {
            /** @description Updated link */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: number;
                        url: string;
                        title: string | null;
                        status: string;
                        state?: string;
                        reason?: string | null;
                        host?: string;
                        added_at?: string;
                        updated_at?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    postApiLinksByIdReextract: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: number;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    adapter?: string;
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description Re-extract outcome */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Illegal state or another extract run is busy */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiLinksByIdArtifactsByName: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: number;
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Artifact bytes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": string;
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    postApiRun: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        runId: string;
                        cursorBefore: number;
                        cursorAfter: number;
                        summary: {
                            ingest: {
                                jobs: ({
                                    jobId: string;
                                    accepted: number;
                                    duplicates: number;
                                    rejected: number;
                                    /** @enum {string} */
                                    status: "pending" | "running" | "done" | "failed" | "busy";
                                    warnings: string[];
                                } & {
                                    [key: string]: unknown;
                                })[];
                            } & {
                                [key: string]: unknown;
                            };
                            extract: {
                                okCount: number;
                                errorCount: number;
                            } & {
                                [key: string]: unknown;
                            };
                            enrich: {
                                okCount: number;
                                errorCount: number;
                            } & {
                                [key: string]: unknown;
                            };
                            swept: number;
                            needsAction: boolean;
                            collections: {
                                total?: number;
                            } & {
                                [key: string]: unknown;
                            };
                        } & {
                            [key: string]: unknown;
                        };
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiRunsById: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: number;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run journal row */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: number;
                        stage: string;
                        status?: string;
                        startedAt: string;
                        finishedAt: string | null;
                        inputCount: number;
                        okCount: number;
                        errorCount: number;
                        durationMs: number | null;
                        tokensIn: number | null;
                        tokensOut: number | null;
                        costUsd: number | null;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiRuns: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run journal rows */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        runs: ({
                            id: number;
                            stage: string;
                            status?: string;
                            startedAt: string;
                            finishedAt: string | null;
                            inputCount: number;
                            okCount: number;
                            errorCount: number;
                            durationMs: number | null;
                            tokensIn: number | null;
                            tokensOut: number | null;
                            costUsd: number | null;
                        } & {
                            [key: string]: unknown;
                        })[];
                    };
                };
            };
        };
    };
    getApiBrowsers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Browser adapters */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        adapters: ({
                            id: string;
                            kind: string;
                            roles: string[];
                            caps: {
                                stealth: boolean;
                                headless: boolean;
                                persistentProfile: boolean;
                            } | null;
                            defaultFor: {
                                reader: boolean;
                                login: boolean;
                            };
                            inEscalate: boolean;
                            health: {
                                ok: boolean;
                                detail: string;
                            };
                        } & {
                            [key: string]: unknown;
                        })[];
                        hostMappings: {
                            [key: string]: string;
                        };
                        reader: string;
                        login: string;
                        escalate: string[];
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getApiConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Config summary */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        dir: string;
                        configPath: string;
                        sources: string[];
                        capture: {
                            tokenEnv: string;
                            tokenConfigured: boolean;
                            allowedOrigins: string[];
                        } & {
                            [key: string]: unknown;
                        };
                        server: {
                            tokenEnv: string;
                            tokenConfigured: boolean;
                        } & {
                            [key: string]: unknown;
                        };
                        bind: {
                            hostname: string;
                            port: number;
                            tokenRequired: boolean;
                        } & {
                            [key: string]: unknown;
                        };
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getApiEvents: {
        parameters: {
            query?: {
                since?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description SSE stream (text/event-stream) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            /** @description Bad request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Missing or wrong bearer token (non-loopback binds) */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
            /** @description Internal error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                    };
                };
            };
        };
    };
    getApiSweep: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Sweep plan */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        groups: {
                            category: string;
                            links: ({
                                id: number;
                                url: string;
                                title: string | null;
                                status: string;
                                state?: string;
                                reason?: string | null;
                                host?: string;
                                added_at?: string;
                                updated_at?: string;
                            } & {
                                [key: string]: unknown;
                            })[];
                        }[];
                    };
                };
            };
        };
    };
    postApiSweepApply: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Apply result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        archived: number;
                    };
                };
            };
        };
    };
    getApiMetrics: {
        parameters: {
            query?: {
                last?: "24h" | "7d" | "2w" | "30d";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Metrics */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        stages: {
                            [key: string]: unknown;
                        }[];
                        daily: {
                            [key: string]: unknown;
                        }[];
                    };
                };
            };
        };
    };
}
