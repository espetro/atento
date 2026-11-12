// Generated from the Node @atento/mcp tools/list inputSchemas. Do not edit by hand.
export const SCHEMA_LINKS_LIST = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "q": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "inbox",
        "scheduled",
        "archived",
        "discarded"
      ]
    },
    "category": {
      "type": "string"
    },
    "stale": {
      "type": "boolean"
    },
    "fields": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "id",
          "url",
          "urlHash",
          "title",
          "source",
          "addedAt",
          "note",
          "tags",
          "extracted_content",
          "extractedAt",
          "enrichment",
          "expiresAt",
          "expiryReason",
          "status",
          "category",
          "priority",
          "action",
          "confidence",
          "readMinutes",
          "needsBrowser",
          "createdAt",
          "updatedAt"
        ]
      }
    },
    "filter": {
      "type": "string"
    },
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_LINKS_OVERVIEW = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "topHosts": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_LINKS_PIPELINE = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "state": {
      "type": "string",
      "enum": [
        "created",
        "extracting",
        "extracted",
        "needs_browser",
        "deferred",
        "enriching",
        "inbox",
        "scheduled",
        "archived",
        "discarded",
        "errored",
        "deleted"
      ]
    },
    "host": {
      "type": "string"
    },
    "q": {
      "type": "string"
    },
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_LINKS_GET = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "fields": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "id",
          "url",
          "urlHash",
          "title",
          "source",
          "addedAt",
          "note",
          "tags",
          "extracted_content",
          "extractedAt",
          "enrichment",
          "expiresAt",
          "expiryReason",
          "status",
          "category",
          "priority",
          "action",
          "confidence",
          "readMinutes",
          "needsBrowser",
          "createdAt",
          "updatedAt"
        ]
      }
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_LINKS_TRIAGE = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "ids": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      }
    },
    "action": {
      "type": "string",
      "enum": [
        "read_now",
        "schedule",
        "archive",
        "discard"
      ]
    }
  },
  "required": [
    "ids",
    "action"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_LINKS_RESTORE = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "ids": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      }
    }
  },
  "required": [
    "ids"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_LINKS_SWEEP = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "apply": {
      "type": "boolean"
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_INGEST_RUN = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "files": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "files"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_INGEST_FILE = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_INGEST_TEXT = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "text": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "text"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_INGEST_URLS = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "urls": {
      "minItems": 1,
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "note": {
      "type": "string"
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "urls"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_INGEST_REMOTE = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri"
    }
  },
  "required": [
    "url"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_INGEST_STATUS = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "jobId": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "jobId"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_EXTRACT_RUN = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_ENRICH_RUN = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_METRICS_GET = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "range": {
      "type": "string"
    },
    "now": {
      "type": "string",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
    }
  },
  "additionalProperties": false
} as const;

export const SCHEMA_LIMITS_STATUS = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {},
  "additionalProperties": false
} as const;

export const SCHEMA_LOGIN_PENDING = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {},
  "additionalProperties": false
} as const;

export const SCHEMA_COLLECTIONS_SUMMARY = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {},
  "additionalProperties": false
} as const;

export const SCHEMA_COLLECTION_READ = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "name": {
      "type": "string",
      "enum": [
        "enriched",
        "pending",
        "needs_login",
        "blocked",
        "errored",
        "review",
        "triaged"
      ]
    },
    "since": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "fields": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "id",
          "url",
          "url_hash",
          "title",
          "source",
          "added_at",
          "note",
          "tags",
          "category",
          "priority",
          "action",
          "confidence",
          "read_minutes",
          "status",
          "state",
          "reason",
          "needs_browser",
          "expires_at",
          "expiry_reason",
          "why_it_matters",
          "summary",
          "created_at",
          "updated_at"
        ]
      }
    },
    "format": {
      "type": "string",
      "enum": [
        "json",
        "tsv"
      ]
    },
    "limit": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "name"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_COLLECTION_EXPORT = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "name": {
      "type": "string",
      "enum": [
        "enriched",
        "pending",
        "needs_login",
        "blocked",
        "errored",
        "review",
        "triaged"
      ]
    },
    "since": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "fields": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "id",
          "url",
          "url_hash",
          "title",
          "source",
          "added_at",
          "note",
          "tags",
          "category",
          "priority",
          "action",
          "confidence",
          "read_minutes",
          "status",
          "state",
          "reason",
          "needs_browser",
          "expires_at",
          "expiry_reason",
          "why_it_matters",
          "summary",
          "created_at",
          "updated_at"
        ]
      }
    },
    "format": {
      "type": "string",
      "enum": [
        "jsonl",
        "md",
        "tsv"
      ]
    }
  },
  "required": [
    "name"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_BROWSE_READ = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "url": {
      "type": "string",
      "format": "uri"
    }
  },
  "required": [
    "url"
  ],
  "additionalProperties": false
} as const;

export const SCHEMA_BROWSE_HOSTS = {
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {},
  "additionalProperties": false
} as const;

export const TOOL_SCHEMAS: Record<string, unknown> = {
  "links_list": SCHEMA_LINKS_LIST,
  "links_overview": SCHEMA_LINKS_OVERVIEW,
  "links_pipeline": SCHEMA_LINKS_PIPELINE,
  "links_get": SCHEMA_LINKS_GET,
  "links_triage": SCHEMA_LINKS_TRIAGE,
  "links_restore": SCHEMA_LINKS_RESTORE,
  "links_sweep": SCHEMA_LINKS_SWEEP,
  "ingest_run": SCHEMA_INGEST_RUN,
  "ingest_file": SCHEMA_INGEST_FILE,
  "ingest_text": SCHEMA_INGEST_TEXT,
  "ingest_urls": SCHEMA_INGEST_URLS,
  "ingest_remote": SCHEMA_INGEST_REMOTE,
  "ingest_status": SCHEMA_INGEST_STATUS,
  "extract_run": SCHEMA_EXTRACT_RUN,
  "enrich_run": SCHEMA_ENRICH_RUN,
  "metrics_get": SCHEMA_METRICS_GET,
  "limits_status": SCHEMA_LIMITS_STATUS,
  "login_pending": SCHEMA_LOGIN_PENDING,
  "collections_summary": SCHEMA_COLLECTIONS_SUMMARY,
  "collection_read": SCHEMA_COLLECTION_READ,
  "collection_export": SCHEMA_COLLECTION_EXPORT,
  "browse_read": SCHEMA_BROWSE_READ,
  "browse_hosts": SCHEMA_BROWSE_HOSTS,
};
