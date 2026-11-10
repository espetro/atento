# Changesets

Every user-facing change adds a changeset: `pnpm changeset`, pick the `atento` package, choose the bump and describe the change.
Merging to `main` opens a "Version Packages" PR that updates `CHANGELOG.md`; merging that PR tags the release and publishes the GitHub Release with the built apps.
Only the `atento` umbrella package is versioned. Every other workspace package is private and follows its version.
