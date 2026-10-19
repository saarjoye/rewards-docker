class AccountContextLock {
  constructor() {
    this.activeLocks = new Set();
  }

  acquire(accountId) {
    if (this.activeLocks.has(accountId)) {
      return false;
    }
    this.activeLocks.add(accountId);
    return true;
  }

  release(accountId) {
    this.activeLocks.delete(accountId);
  }

  isLocked(accountId) {
    return this.activeLocks.has(accountId);
  }
}

export const accountContextLock = new AccountContextLock();
export default accountContextLock;
