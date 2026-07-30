// Both packages release in lockstep from a single v<version> tag. The
// release workflow runs this before the dry-run publish so a tag can never
// ship a version that package.json or the changelogs disagree with.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ReleasePackage {
  name: string;
  version: string;
  changelog: string;
}

export function findReleaseIssues(
  tag: string,
  packages: ReleasePackage[],
): string[] {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!match) {
    return [`tag '${tag}' is not of the form v<semver>`];
  }
  const version = match[1];
  const issues: string[] = [];
  for (const pkg of packages) {
    if (pkg.version !== version) {
      issues.push(`${pkg.name} is at ${pkg.version} but the tag says ${version}`);
    } else if (!pkg.changelog.includes(`## ${version}`)) {
      issues.push(`${pkg.name}'s CHANGELOG.md has no '## ${version}' entry`);
    }
  }
  return issues;
}

function loadPackage(dir: string): ReleasePackage {
  const manifest = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  return {
    name: manifest.name,
    version: manifest.version,
    changelog: readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'),
  };
}

function main(tag: string | undefined): void {
  if (!tag) {
    console.error('usage: node scripts/release-check.ts <tag>');
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const issues = findReleaseIssues(tag, [
    loadPackage(root),
    loadPackage(join(root, 'packages/drizzle-spanner-kit')),
  ]);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`release check: ${issue}`);
    process.exit(1);
  }
  console.log(`release check: ${tag} is consistent across both packages`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv[2]);
}
