# Releasing Agent HSP

This is the checklist for cutting a new version. It takes about 30 minutes, most of it waiting for the build.

Releases come from `main`. Version numbers follow Semantic Versioning: `MAJOR.MINOR.PATCH`. While we are below 1.0, bump MINOR for new features and PATCH for fixes only.

## 1. Bump the version

The version lives in three files. They must match.

| File | Field |
|---|---|
| `desktop/src-tauri/tauri.conf.json` | `"version"` (this is the version users see) |
| `desktop/src-tauri/Cargo.toml` | `version` under `[package]` |
| `desktop/package.json` | `"version"` |

Then refresh the lock files so they agree:

```bash
cd desktop
npm install          # updates package-lock.json
cargo check          # updates Cargo.lock
```

`desktop/crates/preso-core/Cargo.toml` has its own version. Only bump it if you want to; nothing publishes that crate.

## 2. Update the changelog

In `CHANGELOG.md`:

1. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`.
2. Add a new, empty `## [Unreleased]` above it.
3. Update the compare links at the bottom.

Write entries for users, not developers. "Verses show faster" beats "refactor segmenter".

## 3. Test

Run the tests in `CONTRIBUTING.md`. Then run the latency harness and compare with the last release. Do not release if verses found went down or wrong verses went up, unless the changelog explains why.

Install the build on a real Mac and, if you can, a real Windows machine. Check: Load model, Listen, a spoken reference reaches the projector, the output window goes full screen.

## 4. Commit, tag and push

```bash
git checkout main
git pull
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The tag must start with `v` and match the version in `tauri.conf.json`.

## 5. What the build does

Pushing the tag starts `.github/workflows/release.yml`:

1. One job builds the quote-matching index (`verse-index.bin`). It is cached, so it only rebuilds when the KJV text or the builder changes.
2. Two jobs build the installers with `tauri-apps/tauri-action`:
   - macOS (`macos-latest`, Apple Silicon): `.dmg`
   - Windows (`windows-latest`): NSIS `.exe` installer
3. The installers are attached to a **draft** GitHub Release named "Agent HSP vX.Y.Z", twice: once with the version in the file name, and once under a fixed name (`Agent-HSP-macOS.dmg`, `Agent-HSP-Windows-setup.exe`).
4. The fixed-name installers are also uploaded to `downloads.anagkazo.app/agent-hsp/vX.Y.Z/` (S3 behind CloudFront; the infrastructure is in the count-amc repo, `infra/anagkazo-web`). The job signs in to AWS as the `agent-hsp-release` role, which only this repo's `v*` tags can use. No secrets are stored.

The fixed names give links that always point at the newest published release:

- https://github.com/kbosompem/agent-hsp/releases/latest/download/Agent-HSP-macOS.dmg
- https://github.com/kbosompem/agent-hsp/releases/latest/download/Agent-HSP-Windows-setup.exe

The Anagkazo website (https://anagkazo.app/hsp.html) links to `downloads.anagkazo.app/agent-hsp/latest/` instead. Nothing there changes until you publish the draft.

## 6. Publish

1. Open the repo's Releases page on GitHub and find the draft.
2. Check that both installers are attached.
3. Paste the changelog section for this version into the description, above the signing note.
4. Click **Publish release**.

Publishing starts `.github/workflows/publish-downloads.yml`. It copies that version's installers to `downloads.anagkazo.app/agent-hsp/latest/`, rewrites `agent-hsp/latest.json` (version, date, links) and `agent-hsp/latest.js` (the same data as a script; the Anagkazo page loads it to show the version number) and clears the CloudFront cache for all of them. A pre-release does not move the latest links.

## If something goes wrong

- **The build failed.** Fix it on `main`, then move the tag: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`, tag again, and push. Delete the old draft release first.
- **A bad release is already public.** Do not delete it. Mark it as a pre-release, add a note, and ship a PATCH release.

## Not done yet

- **Code signing.** Installers are unsigned, so Windows SmartScreen and macOS Gatekeeper warn users. Signing needs an Apple Developer ID (with notarization) and a Windows code-signing certificate, stored as GitHub secrets. Tracked in GitHub issue #18.
- **Intel Macs.** `macos-latest` builds for Apple Silicon only. A universal build needs `--target universal-apple-darwin` and both Rust targets installed.
- **Auto-update.** Not set up. Users download each new version by hand.
- **Tests in CI.** Neither workflow runs `cargo test` or `tsc` yet. Adding them to `build.yml` is a good first contribution.
