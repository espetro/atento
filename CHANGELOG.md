# atento

## 0.2.1

### Patch Changes

- [#12](https://github.com/espetro/atento/pull/12) [`d385f78`](https://github.com/espetro/atento/commit/d385f78765c8d149bb261325b8368c4a267ad2d2) Thanks [@espetro](https://github.com/espetro)! - The CLI and the MCP server report the release version instead of a hard-coded `0.1.0`. `atento --version` and the MCP `serverInfo.version` now match the release they ship in.

## 0.2.0

### Minor Changes

- Native `atento` binary (scriptc): a single self-contained executable for macOS (arm64, x64) and Linux (x64, arm64) with the full read/write CLI — list, show, overview, triage, restore, sweep, prune, metrics, import, enrich, backup, status, breaker, ingest, collections — and the MCP server (`atento mcp`, 21 of 23 tools). Byte-for-byte parity with the Node CLI on the portable surface (72/72 harness cases); starts in ~10 ms with no Node runtime. Extract, run, retry, login, browse, serve and `browse_read`/`extract_run` still need the Node CLI (browser/DOM/media stack). Download `atento-native-<os>-<arch>` from the release assets.

### Patch Changes

- [`9fe5832`](https://github.com/espetro/atento/commit/9fe583295755d40dfad8b36d3a396c9b944bd75c) Thanks [@espetro](https://github.com/espetro)! - Add `atento mcp` (MCP server over stdio). The MCP server is an optional dependency of the CLI and is always included in the release tarballs; `atento-mcp` stays as a shortcut. Evals are now time-independent.

- [`11ba766`](https://github.com/espetro/atento/commit/11ba7664b8705739aac4f015eda59e7dc91d35ae) Thanks [@espetro](https://github.com/espetro)! - Windows x64 builds: the CLI and MCP zip (`atento-<version>-windows-x64.zip`, installable with `mise use -g github:espetro/atento`) and the desktop app (`Atento-desktop-<version>-windows-x64.zip`, including `Atento-Setup.exe`). Desktop packaging is now a cross-platform TypeScript script.
