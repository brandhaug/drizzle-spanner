/**
 * `true` only when `A` and `B` are the same type. Assigning `true` to it fails
 * to compile otherwise, so `bun run typecheck` checks inferred types. A plain
 * annotation would not: `never` is assignable to every type.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
