# Releasing

Both packages (`drizzle-spanner` and the workspace package
`drizzle-spanner-kit`) version and release in lockstep from a single
`v<version>` tag. Versions stay at `0.x` until the drizzle-orm v1 line is
stable.

> Why not changesets: the `drizzle-spanner` package **is** the npm-workspace
> root, and changesets does not version a workspace root package. The
> equivalent here is lockstep versions, a hand-written `CHANGELOG.md` per
> package, and `scripts/release-check.ts` enforcing that a tag, both
> `package.json` versions, and both changelogs agree.

## Cutting a release

1. Bump `version` in `package.json` **and**
   `packages/drizzle-spanner-kit/package.json` to the same value.
2. Add a `## <version>` entry to `CHANGELOG.md` **and**
   `packages/drizzle-spanner-kit/CHANGELOG.md`.
3. Sanity-check locally:

```bash
node scripts/release-check.ts v<version>
```

4. Land those changes on `master` through a PR, then tag:

```bash
git tag v<version>
git push origin v<version>
```

5. The tag triggers `.github/workflows/release.yml`: release-check, lint,
   typecheck, unit tests, build, `arethetypeswrong`, pack-contents check, and
   a **dry-run** publish of both packages. CI never publishes and holds no
   npm token.

## Publishing (manual, deliberate)

After the release workflow is green on the tag, a maintainer with npm
permissions publishes from a clean checkout of that tag:

```bash
git checkout v<version>
npm ci
npm run build
npm run build -w drizzle-spanner-kit
npm publish --access public
npm publish --access public --workspace drizzle-spanner-kit
```

Pre-1.0 versions publish to the default `latest` dist-tag intentionally:
there is no stable line to protect yet.
