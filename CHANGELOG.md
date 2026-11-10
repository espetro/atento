# atento

## 0.1.1

### Patch Changes

- [`9fe5832`](https://github.com/espetro/atento/commit/9fe583295755d40dfad8b36d3a396c9b944bd75c) Thanks [@espetro](https://github.com/espetro)! - Add `atento mcp` (MCP server over stdio). The MCP server is an optional dependency of the CLI and is always included in the release tarballs; `atento-mcp` stays as a shortcut. Evals are now time-independent.

- [`11ba766`](https://github.com/espetro/atento/commit/11ba7664b8705739aac4f015eda59e7dc91d35ae) Thanks [@espetro](https://github.com/espetro)! - Windows x64 builds: the CLI and MCP zip (`atento-<version>-windows-x64.zip`, installable with `mise use -g github:espetro/atento`) and the desktop app (`Atento-desktop-<version>-windows-x64.zip`, including `Atento-Setup.exe`). Desktop packaging is now a cross-platform TypeScript script.
