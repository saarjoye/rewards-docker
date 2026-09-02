const assert = require('node:assert/strict')

const {
    abortableWait,
    calculateSearchRoundTimeoutMs,
    calculateSearchTimeoutBudget,
    runSearchStage,
    SearchOperationError
} = require('../../dist/util/SearchExecution')
const { Search } = require('../../dist/functions/activities/browser/Search')

;(async () => {
    const defaultBudget = calculateSearchTimeoutBudget({
        searchDelayMax: '1min',
        searchResultVisitTime: '5sec',
        scrollRandomResults: false,
        clickRandomResults: false
    })
    assert.equal(defaultBudget.stageTimeouts['search-delay'], 62000)
    assert.equal(defaultBudget.stageTimeouts.submit, 20000)
    assert.equal(defaultBudget.stageTimeouts['dashboard-refresh'], 60000)
    assert.ok(defaultBudget.queryTimeoutMs > 60000)
    assert.ok(calculateSearchRoundTimeoutMs(defaultBudget.queryTimeoutMs, 60, 60) >= 10 * 60000)

    const interactiveBudget = calculateSearchTimeoutBudget({
        searchDelayMax: '1min',
        searchResultVisitTime: '12sec',
        scrollRandomResults: true,
        clickRandomResults: true
    })
    assert.equal(interactiveBudget.stageTimeouts.scroll, 10000)
    assert.equal(interactiveBudget.stageTimeouts.click, 29000)
    assert.ok(interactiveBudget.queryTimeoutMs > defaultBudget.queryTimeoutMs)

    let closed = false
    let operationSettled = false
    let postAbortOperations = 0
    const controller = new AbortController()
    const page = {
        isClosed: () => closed,
        close: async () => {
            closed = true
        }
    }
    await assert.rejects(
        () =>
            runSearchStage({
                page,
                controller,
                stage: 'dashboard-refresh',
                timeoutMs: 20,
                operation: async signal => {
                    try {
                        await abortableWait(1000, signal)
                        postAbortOperations += 1
                    } finally {
                        operationSettled = true
                    }
                }
            }),
        error => {
            assert.ok(error instanceof SearchOperationError)
            assert.equal(error.operationStage, 'dashboard-refresh')
            assert.equal(error.timedOut, true)
            return true
        }
    )
    assert.equal(closed, true)
    assert.equal(operationSettled, true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(postAbortOperations, 0)

    const failingController = new AbortController()
    await assert.rejects(
        () =>
            runSearchStage({
                page: { isClosed: () => false, close: async () => {} },
                controller: failingController,
                stage: 'search-box',
                timeoutMs: 100,
                operation: async () => {
                    throw new Error('synthetic failure')
                }
            }),
        error =>
            error instanceof SearchOperationError && error.operationStage === 'search-box' && error.timedOut === false
    )

    let locatorClicks = 0
    let ghostClicks = 0
    const searchBox = {
        waitFor: async () => {},
        click: async options => {
            locatorClicks += 1
            assert.deepEqual(options, { clickCount: 3, timeout: 5000 })
        },
        fill: async () => {}
    }
    const searchPage = {
        isClosed: () => false,
        close: async () => {},
        evaluate: async () => {},
        locator: selector => {
            assert.equal(selector, '#sb_form_q')
            return searchBox
        },
        keyboard: {
            press: async () => {},
            type: async () => {}
        }
    }
    const counters = { pcSearch: [] }
    const search = new Search({
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        config: {
            searchSettings: {
                searchDelay: { min: 0, max: 0 },
                scrollRandomResults: false,
                clickRandomResults: false
            }
        },
        utils: { wait: async () => {}, randomDelay: () => 0 },
        browser: {
            utils: {
                ghostClick: async () => {
                    ghostClicks += 1
                    return true
                }
            },
            func: { getSearchPoints: async () => counters }
        }
    })
    const directClickBudget = calculateSearchTimeoutBudget({
        searchDelayMax: 0,
        searchResultVisitTime: 0,
        scrollRandomResults: false,
        clickRandomResults: false
    })
    const returnedCounters = await search.bingSearch(searchPage, 'synthetic query', false, directClickBudget)
    assert.equal(returnedCounters, counters)
    assert.equal(locatorClicks, 1)
    assert.equal(ghostClicks, 0)

    console.log('searchTimeoutBudget.test.js passed')
})().catch(error => {
    console.error(error)
    process.exit(1)
})
