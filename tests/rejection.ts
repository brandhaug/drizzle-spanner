/**
 * The reason a promise rejects with. Integration tests await it instead of
 * `expect(pending).rejects`: in Bun's runner that blocks on the pending promise
 * without servicing the gRPC client's socket, so a Spanner call stalls ~140 s.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject, but it resolved')
}
