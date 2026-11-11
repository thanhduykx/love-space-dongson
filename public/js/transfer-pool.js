async function runTransfers(items, limit, transfer) {
  const iterator = items[Symbol.iterator]();
  let failed = false;
  async function worker() {
    while (!failed) {
      const { value, done } = iterator.next();
      if (done) return;
      try {
        await transfer(value);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const results = await Promise.allSettled(Array.from({ length: limit }, worker));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

if (typeof module !== 'undefined') module.exports = runTransfers;
