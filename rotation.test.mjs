// Exercise the rotation queue and failure classification offline.
import { RouteCursor, isRotatableFailure } from './rotation.js'

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

const routes = [
  { provider: 'buddy', model: 'deepseek-v4.1-flash' },
  { provider: 'our-free-model', model: 'kimi-k3' },
  { provider: 'workbuddy', model: 'glm-5.3-flash' },
]
const logs = []
const cursor = new RouteCursor(routes, message => logs.push(message))

// A child starts on the first entry.
check('first child starts at head', cursor.current('a'), routes[0])

// Each child advances independently.
check('advance a', cursor.advance('a'), routes[1])
check('b still at head', cursor.current('b'), routes[0])
check('advance a again', cursor.advance('a'), routes[2])

// The queue is walked forward, never wrapped: no infinite rebound.
check('a exhausted returns undefined', cursor.advance('a'), undefined)
check('a stays on the last route', cursor.current('a'), routes[2])

// Advancing from a route the child is not on lands after *that* route, so an
// externally-observed failure is honoured.
cursor.forget('b')
check('advance from explicit failure', cursor.advance('b', routes[1]), routes[2])

// Replacement keeps valid places and drops stale ones.
cursor.replace([routes[0], routes[2]])
check('a re-anchored after shrink', cursor.current('a'), routes[2])
cursor.replace([routes[1]])
check('unknown route drops the cursor', cursor.current('a'), routes[1])

// Empty queue is inert.
const empty = new RouteCursor([], () => {})
check('empty current', empty.current('x'), undefined)
check('empty advance', empty.advance('x'), undefined)

// Failure classification.
for (const code of ['QUOTA_EXCEEDED', 'RATE_LIMIT', 'MISSING_CREDENTIAL', 'AUTH', 'QUEUE']) {
  check(`rotatable ${code}`, isRotatableFailure({ code }), true)
}
for (const status of [401, 402, 403, 429]) {
  check(`rotatable status ${status}`, isRotatableFailure({ code: 'SERVER', status }), true)
}
for (const code of ['SERVER', 'TIMEOUT', 'INVALID_REQUEST', 'UNSUPPORTED_CONTENT', 'EMPTY_RESPONSE']) {
  check(`not rotatable ${code}`, isRotatableFailure({ code }), false)
}
check('null failure', isRotatableFailure(null), false)
check('undefined failure', isRotatableFailure(undefined), false)

console.log(failures === 0 ? '\nall rotation checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
