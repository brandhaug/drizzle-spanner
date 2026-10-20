# Anti-slop lint plugin

`plugin.mjs` and `license.md` are byte-for-byte copies of
`config/oxlint/anti-slop/` from the published `ultracite@8.0.1` package,
the version previously installed by this repository. The plugin originates at
<https://github.com/dmmulroy/anti-slop> and retains its bundled MIT license.

Only this self-contained plugin was used from Ultracite. Keeping the bundle here
removes the unused CLI's dependency on vulnerable `braces` without changing the
plugin or this repository's configured lint rules. Oxlint loads it from
`.oxlintrc.json`; formatter, linter, and Fallow exclusions preserve vendor bytes.

SHA-256:

```text
9bfb19ea9e86908fdf930103d3f1ee0825e0e0eabdf016ac54bc96ab871884c4  plugin.mjs
2e796f3c65c1ee8f034add8eac12a1a9d29aecede719ec12d9e0c37a62a2b206  license.md
```

To update, unpack a reviewed Ultracite release, copy both files from that
directory without modification, update the version and hashes here, and run
`bun run check`, `fallow dead-code --fail-on-regression`, and `bun audit`.
