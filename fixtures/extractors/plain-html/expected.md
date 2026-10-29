The 4.2 release focuses on extraction reliability and adds a configuration file that removes the need for environment variables in the common case.

## Highlights

*   Extraction yield is now measured per extractor and reported in the metrics output.
*   The router escalates to a browser extraction when a static pass returns almost nothing.
*   Video extraction prefers the auto-generated transcript over the description.

## Fixes

Fixed an issue where pages with a large navigation element were leaking nav text into the extracted markdown.

Fixed a crash when a saved link pointed at a URL that no longer resolved.

## Upgrade notes

No schema migration is required. Existing databases keep working and the new columns are added on first run.
