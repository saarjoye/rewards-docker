const assert = require('assert')
const { parseGiftCardItems } = require('../../dist/util/GiftCardMonitor')

const html = `
  <a href="/redeem/sku/000899036009?fallback=%2Fredeem%3Fnotfound%3D1">盒马礼品卡19,105分19,305还差 10,513</a>
  <a href="/redeem/sku/000899036014?fallback=%2Fredeem%3Fnotfound%3D1">天猫超市礼品卡17,715分17,915还差 9,123</a>
  <a href="/redeem/sku/000499036003">Overwatch 金币数字码1,800分2,000</a>
  <a href="/redeem/sku/000799036093?fallback=%2Fredeem%2Fwin%3Fnotfound%3D1">抽奖： XBOX Series X0分100</a>
  <a href="/redeem/sku/000999036002?causeId=840-060726487">SAVE THE CHILDREN FEDERATION INC100分</a>
`

const all = parseGiftCardItems(html, ['礼品卡', 'Overwatch'], 8592)
assert.strictEqual(all.length, 3)

const hema = all.find(item => item.title.includes('盒马'))
assert(hema)
assert.strictEqual(hema.available, true)
assert.strictEqual(hema.affordable, false)
assert.strictEqual(hema.shortfall, 10513)

const overwatch = all.find(item => item.title.includes('Overwatch'))
assert(overwatch)
assert.strictEqual(overwatch.available, true)
assert.strictEqual(overwatch.affordable, true)

const skuList = all.map(item => item.sku)
assert(!skuList.includes('000799036093'))
assert(!skuList.includes('000999036002'))

console.log('giftCardMonitorParser.test passed')
