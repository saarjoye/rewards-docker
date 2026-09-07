import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityForPromotion, normalizePromotion } from '../../dist/util/TaskCapabilityRegistry.js'
import { planPromotion } from '../../dist/util/TaskPlanner.js'

const config = {
    activities: { urlReward: true, searchOnBing: true },
    workers: { doVisualSearch: true },
    autoClaimPunchcardRewards: false
}

test('unknown promotion types remain visible as unsupported and preserve the raw type', () => {
    const promotion = normalizePromotion({ offerId: 'offer-unknown', promotionType: 'quiz-v9', title: '合成任务' }, 'rsc')
    const capability = capabilityForPromotion(promotion)
    assert.equal(capability.state, 'unsupported')
    assert.equal(capability.adapter, 'promotion:quiz-v9')
    const plan = planPromotion({ offerId: 'offer-unknown', promotionType: 'quiz-v9', title: '合成任务' }, config, {
        source: 'rsc',
        platform: 'desktop'
    })
    assert.equal(plan.taskType, 'quiz-v9')
    assert.equal(plan.execution.planned, false)
    assert.equal(plan.capability.state, 'unsupported')
})

test('locked, manual claim and missing metadata are distinct plan states', () => {
    const locked = planPromotion({ offerId: 'locked', promotionType: 'urlreward', isLocked: true }, config, {
        source: 'rsc',
        platform: 'desktop'
    })
    assert.equal(locked.eligibility.state, 'locked')
    assert.equal(locked.execution.planned, false)

    const manual = planPromotion({ offerId: 'claim', promotionType: 'claim' }, config, {
        source: 'rsc',
        platform: 'desktop'
    })
    assert.equal(manual.eligibility.state, 'manual-required')
    assert.equal(manual.capability.state, 'supported')

    const missing = planPromotion({ title: '没有标识' }, config, { source: 'rsc', platform: 'desktop' })
    assert.equal(missing.capability.state, 'unknown')
    assert.equal(missing.eligibility.state, 'data-missing')
})
