# Security Policy

## Supported versions

Only the latest published `0.x` release of `drizzle-spanner` and
`drizzle-spanner-kit` receives security fixes.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/brandhaug/drizzle-spanner/security/advisories/new)
— do not open a public issue. You can expect an acknowledgement within a
week.

## Scope notes

- The adapter never logs or embeds query **parameter values** in error
  messages; errors carry parameter names only. A message that leaks a value
  is a bug — report it.
- `drizzle-spanner-kit` executes the schema/config modules named in
  `drizzle-spanner.config.ts` with the privileges of the invoking user, like
  any build tool. Running it against untrusted config or schema files is out
  of scope.
- Credentials are handled entirely by `@google-cloud/spanner`; this package
  neither reads nor stores them.
