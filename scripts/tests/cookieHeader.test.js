const assert = require('node:assert/strict')
const BrowserFunc = require('../../dist/browser/BrowserFunc').default

function cookie(name, value, domain, path = '/', overrides = {}) {
    return {
        name,
        value,
        domain,
        path,
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
        ...overrides
    }
}

function legacyCookieHeader(cookies) {
    return [...new Map(cookies.map(item => [item.name, item])).values()]
        .map(item => `${item.name}=${item.value}`)
        .join('; ')
}

const func = new BrowserFunc({})
const rewardsApi = 'https://rewards.bing.com/api/getuserinfo?type=1'

const crossDomain = [
    cookie('MUID', 'synthetic-bing', '.bing.com'),
    cookie('MUID', 'synthetic-live', '.live.com'),
    cookie('MSCC', 'synthetic-rewards', 'rewards.bing.com'),
    cookie('MSCC', 'synthetic-www2', 'www2.bing.com'),
    cookie('ANON', 'synthetic-cn', 'cn.bing.com')
]
assert.equal(
    func.buildCookieHeaderForUrl(crossDomain, rewardsApi),
    'MUID=synthetic-bing; MSCC=synthetic-rewards'
)

const pathScoped = [
    cookie('ROOT', 'root', '.bing.com', '/'),
    cookie('AUTH', 'auth', '.bing.com', '/auth'),
    cookie('API', 'api', '.bing.com', '/api'),
    cookie('EXACT', 'exact', '.bing.com', '/api/getuserinfo')
]
assert.equal(
    func.buildCookieHeaderForUrl(pathScoped, rewardsApi),
    'EXACT=exact; API=api; ROOT=root'
)
assert.equal(func.buildCookieHeaderForUrl(pathScoped, 'https://rewards.bing.com/apiary'), 'ROOT=root')

const now = Math.floor(Date.now() / 1000)
const lifecycle = [
    cookie('SESSION', 'session', '.bing.com'),
    cookie('FUTURE', 'future', '.bing.com', '/', { expires: now + 3600 }),
    cookie('EXPIRED', 'expired', '.bing.com', '/', { expires: now - 60 }),
    cookie('SECURE', 'secure', '.bing.com', '/', { secure: true })
]
assert.equal(
    func.buildCookieHeaderForUrl(lifecycle, rewardsApi),
    'SESSION=session; FUTURE=future; SECURE=secure'
)
assert.equal(
    func.buildCookieHeaderForUrl(lifecycle, 'http://rewards.bing.com/api/getuserinfo'),
    'SESSION=session; FUTURE=future'
)

const duplicates = [
    cookie('MUID', 'root-first', '.bing.com', '/'),
    cookie('MUID', 'api-first', '.bing.com', '/api'),
    cookie('MUID', 'api-second', 'rewards.bing.com', '/api'),
    cookie('MUID', 'exact', 'rewards.bing.com', '/api/getuserinfo')
]
assert.equal(
    func.buildCookieHeaderForUrl(duplicates, rewardsApi),
    'MUID=exact; MUID=api-first; MUID=api-second; MUID=root-first'
)

assert.throws(() => func.buildCookieHeaderForUrl([], 'not-a-url'), TypeError)
assert.throws(() => func.buildCookieHeaderForUrl([], 'file:///tmp/cookies'), TypeError)

const abCookies = [
    cookie('MUID', 'synthetic-bing', '.bing.com'),
    cookie('MUID', 'synthetic-live', '.live.com')
]
const fakeDashboardEndpoint = header =>
    header === 'MUID=synthetic-bing'
        ? { status: 200, data: { dashboard: { userStatus: { availablePoints: 14202 } } } }
        : { status: 404, data: null }

assert.equal(fakeDashboardEndpoint(legacyCookieHeader(abCookies)).status, 404)
const fixedResponse = fakeDashboardEndpoint(func.buildCookieHeaderForUrl(abCookies, rewardsApi))
assert.equal(fixedResponse.status, 200)
assert.equal(fixedResponse.data.dashboard.userStatus.availablePoints, 14202)

console.log('cookieHeader.test.js passed')
