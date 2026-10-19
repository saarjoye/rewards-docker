import logger from '../logger.js';

export class SearchStagnationGuard {
  constructor(limit = 3, accountPrefix = '') {
    this.limit = limit;
    this.accountPrefix = accountPrefix;
    this.consecutiveStagnantCount = 0;
    this.lastObservedPoints = -1;
    this.tripped = false;
  }

  recordObservation(currentPoints) {
    if (this.lastObservedPoints === -1) {
      this.lastObservedPoints = currentPoints;
      return { tripped: false, stagnant: false, delta: 0 };
    }

    const delta = currentPoints - this.lastObservedPoints;
    if (delta > 0) {
      this.consecutiveStagnantCount = 0;
      this.lastObservedPoints = currentPoints;
      return { tripped: false, stagnant: false, delta };
    }

    this.consecutiveStagnantCount++;
    logger.log(
      '⚠️',
      `[停滞监控] 搜索后官网积分未增长 (+0 分)，已停滞 ${this.consecutiveStagnantCount}/${this.limit} 次`,
      '',
      this.accountPrefix
    );

    if (this.consecutiveStagnantCount >= this.limit) {
      this.tripped = true;
      logger.log(
        '🛑',
        `[停滞熔断] 连续 ${this.consecutiveStagnantCount} 次未产生积分增量，已达到上限或触发微软风控冷冻，立即熔断终止本轮搜索！`,
        '',
        this.accountPrefix
      );
      return { tripped: true, stagnant: true, delta: 0 };
    }

    return { tripped: false, stagnant: true, delta: 0 };
  }

  isTripped() {
    return this.tripped;
  }
}

export default SearchStagnationGuard;
