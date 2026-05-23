# Release runbook

This document captures the human steps for cutting a new Subflow release. The mechanical build / package / GitHub-Release-creation steps are automated by [`.github/workflows/release.yml`](./.github/workflows/release.yml), which fires on a `vX.Y.Z` tag push.

## Pre-release checklist

Before tagging, make the version consistent everywhere and the CHANGELOG accurate. None of these steps are automated — they are deliberate human acts, in part because the version numbers and the release-notes wording are the parts the release-time reader cares most about and the parts that benefit most from a second look before the tag is immutable.

1. **Bump `package.json`** `version` to the new `X.Y.Z`.
2. **Bump `public/manifest.json`** `version` to the same value. The packaging script (`scripts/package.mjs`) and the release workflow both refuse to ship if these disagree, so this is a guard rather than a step you can forget.
3. **Update `CHANGELOG.md`**:
   - Replace the open `## [Unreleased]` heading (if any) with `## [X.Y.Z] — YYYY-MM-DD` (today's date in ISO-8601). The dash style is cosmetic — the release workflow matches on the `## [X.Y.Z]` prefix only.
   - Add a fresh empty `## [Unreleased]` section above it if you want a place to accumulate future changes.
   - Update the reference-link footer:
     ```
     [Unreleased]: https://github.com/hydai/subflow/compare/vX.Y.Z...HEAD
     [X.Y.Z]: https://github.com/hydai/subflow/releases/tag/vX.Y.Z
     ```
4. **Run the full local validation** to mirror what the workflow will do:
   ```sh
   npm run package
   ```
   This chains `typecheck → test → build → zip` and verifies that `package.json` and `dist/manifest.json` agree on version before producing `subflow-vX.Y.Z.zip`. If this fails locally, the workflow will fail too.

## Cutting the release

1. Commit the version-bump + CHANGELOG changes on a branch (e.g. `chore/release-vX.Y.Z`) and open a PR. Use a commit message like `chore(release): cut vX.Y.Z`.
2. Merge the PR (squash, per the rest of the project's history). This is the last opportunity to catch a typo without rewriting tags.
3. Pull `main` locally and tag the merge commit:
   ```sh
   git switch main
   git pull --ff-only
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. The `Release` workflow on GitHub Actions takes over. It runs the same `npm run package` chain you ran locally, extracts the matching `## [X.Y.Z]` section from `CHANGELOG.md` as the release body, and publishes a GitHub Release with `subflow-vX.Y.Z.zip` attached.
5. Visit the release page on GitHub to verify the asset and the rendered notes look right.

## What the workflow does **not** do

- **It doesn't bump versions for you.** The file edits in the pre-release checklist are deliberate human acts; automating them would couple the release moment to commit-message conventions, which this project doesn't enforce.
- **It doesn't submit the zip to the Chrome Web Store.** The Web Store API requires an OAuth2 client tied to a specific Google account, and the credentials would have to live in repo secrets that any maintainer with write access could exfiltrate. The upload to https://chrome.google.com/webstore/devconsole stays manual.
- **It doesn't maintain the `[Unreleased]` reference-link entry in the CHANGELOG.** Keeping that manual avoids accidental overwrites.
- **It doesn't sign the artifact.** Chrome's update mechanism does its own signing once the zip is uploaded; pre-upload signing would not buy anything.

## Rolling back

The right rollback path depends on whether a GitHub Release has actually been published — that is the moment the tag becomes truly immutable for outside consumers.

### Case A — workflow guard rejected the tag (no Release was created)

`Create GitHub Release` is the workflow's final step. If any earlier guard (tag format, `package.json` version mismatch, missing CHANGELOG section, missing zip) fails, the workflow exits before that step runs and no Release is published. In that window the tag is safe to delete and re-create, because nothing external could be pointing at it yet.

Verify on the Actions page that the failed run never reached `Create GitHub Release`, then:

```sh
git tag -d vX.Y.Z              # delete locally
git push --delete origin vX.Y.Z  # delete on origin
# fix the files (package.json, public/manifest.json, CHANGELOG.md), commit, push,
# then re-tag the new merge commit.
```

### Case B — Release was published and the artifact is bad

Once `Create GitHub Release` ran successfully, treat the tag as immutable. External integrators (and the future Chrome Web Store update history once it exists) may already be pointing at it.

1. **Don't delete or rewrite the tag.** Even if the artifact is wrong, churning the tag breaks anyone who already fetched it.
2. Bump to the next patch version (`X.Y.(Z+1)`), document the rollback in `CHANGELOG.md`, and cut a new release using the pre-release checklist and tagging steps above.
3. Optionally mark the bad release as "pre-release" on GitHub via the release page so it stops being the "Latest release" link target. (Editing the release body to add a "⚠ Use vX.Y.(Z+1) instead" line is fine too — the tag stays put, only the human-facing metadata changes.)

### Case C — Release was partially created (rare)

If `gh release create` itself failed mid-way and left a draft/incomplete Release behind, delete the Release object via the GitHub UI (or `gh release delete vX.Y.Z`), then treat the situation as Case A and delete the tag too.

## When the workflow fails

The workflow logs a `::error::` annotation pointing at the offending check whenever a guard fails. Common cases (all of these are Case A — no Release was published, so re-tagging per the steps above is safe):

- **"Tag … does not match the required 'vMAJOR.MINOR.PATCH' format"** — re-tag using the strict `vX.Y.Z` shape; pre-release suffixes (`-rc1`, `-beta`) are intentionally rejected for now because the CHANGELOG doesn't have a story for them.
- **"Tag … implies version 'X.Y.Z' but package.json is 'A.B.C'"** — you forgot to bump `package.json` (and probably `public/manifest.json`) before tagging. Follow the Case A delete-and-retag steps after fixing the files.
- **"CHANGELOG.md has no '## [X.Y.Z]' section"** — same root cause as above; update the heading and re-tag.
- **"Expected 'subflow-vX.Y.Z.zip' was not produced"** — `npm run package` succeeded but the zip name didn't match. This usually means `scripts/package.mjs` was edited; the workflow assumes the script writes exactly `subflow-v<package.json version>.zip` at the repo root.
