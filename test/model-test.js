// Exercises Model.js outside QML: node test/model-test.js
const fs = require('fs')
const src = fs.readFileSync(__dirname + '/../Model.js', 'utf8')
const M = {}
new Function('exports', src + '\nObject.assign(exports,{buildQuery,forbiddenOptional,rate,padRate,curlScript,expandHome,graphqlError,normalize,render,renderError,renderApiError,humanKb,netProblem});')(M)

let failures = 0
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + what + ' -> ' + JSON.stringify(got)
    + (ok ? '' : '  (expected ' + JSON.stringify(want) + ')'))
}

const cfg = { host: 'http://tower.local', apiKeyFile: '~/.config/omarchy/unraid-api-key',
  tempWarn: 45, tempCrit: 55, ssdTempWarn: 60, ssdTempCrit: 70,
  showNetwork: true, showNetworkInBar: false, capacityWarn: 85, capacityCrit: 95,
  showCapacity: true, showTemp: true, label: '', vertical: false }

const disk = (name, temp, status, size, used, errors) =>
  ({ name, device: 'sd?', temp, status: status || 'DISK_OK', rotational: name !== 'cache',
     numErrors: errors || 0, fsSize: size, fsFree: size - used, fsUsed: used })

const payload = (over) => ({ data: Object.assign({
  array: {
    state: 'STARTED',
    capacity: { kilobytes: { total: 21474836480, used: 8804682956, free: 12670153524 }, disks: { total: '10', used: '8', free: '2' } },
    parityCheckStatus: { status: 'COMPLETED', progress: 100, running: false, paused: false, correcting: false, errors: 0, speed: null },
    parities: [ disk('parity', 38, 'DISK_OK', 0, 0) ],
    disks: [ disk('disk1', 41, 'DISK_OK', 7814026584, 6000000000),
             disk('disk2', null, 'DISK_OK', 7814026584, 2000000000),
             disk('disk3', 36, 'DISK_OK', 5860522584, 804682956) ],
    caches: [ disk('cache', 44, 'DISK_OK', 976762584, 300000000) ]
  },
  parityHistory: [ { date: new Date(Date.now() - 3 * 86400000).toISOString(), duration: 41230, status: 'COMPLETED', errors: 0 } ],
  vars: { name: 'Tower' }
}, over) })

function show(title, p, c) {
  const r = M.render(M.normalize(p), Object.assign({}, cfg, c || {}))
  console.log('=== ' + title + '  [level ' + r.level + ']  bar: ' + JSON.stringify(r.text))
  console.log(r.tooltip)
  console.log()
}

show('healthy', payload())

show('parity running', payload({ array: Object.assign({}, payload().data.array, {
  parityCheckStatus: { status: 'RUNNING', progress: 34, running: true, paused: false, correcting: true, errors: 0, speed: '142 MB/s' } }) }))

const hot = payload()
hot.data.array.disks[0].temp = 58
hot.data.array.disks[2].numErrors = 12
show('hot disk + read errors', hot)

const dead = payload()
dead.data.array.disks[1].status = 'DISK_DSBL'
show('disabled disk', dead)

const stopped = payload()
stopped.data.array.state = 'STOPPED'
show('array stopped', stopped)

const full = payload()
full.data.array.capacity.kilobytes.used = 20690000000
full.data.array.capacity.kilobytes.free = 784836480
show('nearly full', full)

console.log('=== unconfigured'); console.log(JSON.stringify(M.renderError(90, '', Object.assign({}, cfg, { host: '' })), null, 1))
console.log('=== no key');       console.log(JSON.stringify(M.renderError(90, 'no-key', cfg), null, 1))
console.log('=== unreachable');  console.log(JSON.stringify(M.renderError(7, 'curl: (7) Failed to connect', cfg), null, 1))
console.log('=== graphql err');  console.log(M.graphqlError({ errors: [{ message: 'Forbidden resource' }] }))
console.log('=== vertical');     console.log(JSON.stringify(M.render(M.normalize(payload()), Object.assign({}, cfg, { vertical: true })).text))

// A key scoped to ARRAY only: `array` resolves, `vars` is denied. The widget
// must still render, falling back to the host for the tooltip's first line.
const arrayOnly = payload()
delete arrayOnly.data.vars
arrayOnly.errors = [{ message: 'Forbidden resource', path: ['vars'] }]
console.log('=== array-only key, vars denied')
console.log('graphqlError:', JSON.stringify(M.graphqlError(arrayOnly)))
show('array-only key', arrayOnly)

// A key with neither: nothing usable comes back, so this must still hard-fail.
console.log('=== fully denied ->', JSON.stringify(M.graphqlError({ errors: [{ message: 'Forbidden resource' }] })))

// --- optional-field capability handling -------------------------------------
console.log('=== query with all caps:\n' + M.buildQuery({ vars: true, metrics: true }))
console.log('=== query with metrics dropped:\n' + M.buildQuery({ vars: true, metrics: false }))
console.log('=== forbiddenOptional(metrics denied) ->',
  JSON.stringify(M.forbiddenOptional({ data: null, errors: [{ message: 'Forbidden resource', path: ['metrics'] }] })))
console.log('=== forbiddenOptional(array denied) ->',
  JSON.stringify(M.forbiddenOptional({ data: null, errors: [{ message: 'Forbidden resource', path: ['array'] }] })))

// --- network rate -----------------------------------------------------------
const withNet = (rx, tx, extra) => {
  const p = payload()
  p.data.metrics = { network: (extra || []).concat([
    { name: 'br0', operstate: 'up', rxSec: rx, txSec: tx, utilizationPercent: (rx + tx) / 1e9 * 100 }]) }
  return p
}
show('idle network', withNet(2000, 800))
show('busy, rate opted into the bar', withNet(112000000, 3400000), { showNetworkInBar: true })
show('idle, rate opted into the bar (same width)', withNet(0, 0), { showNetworkInBar: true })
show('busy network', withNet(112000000, 3400000))
show('busy, virtual interfaces present', withNet(112000000, 3400000, [
  { name: 'docker0', operstate: 'up', rxSec: 9e9, txSec: 9e9, utilizationPercent: 99 },
  { name: 'lo', operstate: 'up', rxSec: 9e9, txSec: 9e9, utilizationPercent: 99 }]))
console.log('=== rate formatting:', ['0','999','1000','1536000','112000000','2.5e9']
  .map(v => Number(v) + ' -> ' + M.rate(Number(v))).join('  |  '))

// --- the key must never land in curl's argv ---------------------------------
// A header written as `-H "x-api-key: $key"` is expanded by the shell before
// exec, which puts the secret in /proc/<pid>/cmdline for anyone to read. The
// script must hand it to curl over stdin instead.
const script = M.curlScript('http://tower.local', '/home/u/.config/omarchy/unraid-api-key',
  false, 10, { vars: true, metrics: true })
const curlLine = script.split('\n').find(l => l.startsWith('curl '))
console.log('\n=== poll script')
check('curl argv carries no key', /\$key|x-api-key/.test(curlLine), false)
check('header goes in over stdin', /-K - <<CURLCFG$/.test(curlLine), true)
check('config body sets the header', script.includes('header = "x-api-key: $key"'), true)
check('host is shell-quoted', curlLine.includes("'http://tower.local/graphql'"), true)
check('insecure adds -k', M.curlScript('h', 'f', true, 10, {}).includes(' -k '), true)

// --- rate() must never exceed the 4 columns padRate() reserves --------------
// Rounding used to push 999500 back up to "1000K": wrong magnitude, and one
// character too wide, so the bar resized at every megabyte boundary.
console.log('\n=== rate width')
check('rate(999500)', M.rate(999500), '1.0M')
check('rate(999.5)', M.rate(999.5), '1.0K')
check('rate(999499)', M.rate(999499), '999K')
check('rate(2.5e12)', M.rate(2.5e12), '2.5T')
for (const v of [0, 1, 999, 999.5, 1000, 999499, 999500, 1e6, 112e6, 2.5e9, 9.99e11, 2.5e12])
  check('padRate(' + v + ') is 4 wide', M.padRate(v).length, 4)

// --- the bar must point at the disk that raised the alarm -------------------
// Thresholds are per disk type, so the globally hottest disk is often a cache
// SSD well inside its own limit while a cooler spinning disk is the problem.
console.log('\n=== which temperature the bar shows')
const mixed = payload()
mixed.data.array.disks[0].temp = 46   // HDD, warn 45 -> over
mixed.data.array.caches[0].temp = 52  // SSD, warn 60 -> fine, but hotter
const mixedView = M.render(M.normalize(mixed), cfg)
check('shows the over-threshold HDD, not the hotter happy SSD', mixedView.text.includes('46'), true)
check('level is warning', mixedView.level, 1)
const calm = payload()
check('falls back to hottest when nothing is over', M.render(M.normalize(calm), cfg).text.includes('44'), true)

// --- an empty Network row has to say why ------------------------------------
console.log('\n=== netProblem')
const pinned = withNet(1000, 1000)
pinned.__netInterface = 'eth9'
check('pinned name absent', M.netProblem(M.normalize(pinned)), 'no interface named eth9')
const noneUp = payload()
noneUp.data.metrics = { network: [{ name: 'eth0', operstate: 'down', rxSec: 0, txSec: 0 }] }
check('nothing up', M.netProblem(M.normalize(noneUp)), 'no active interface')
check('matched interface is not a problem', M.netProblem(M.normalize(withNet(10, 10))), '')
check('metrics denied is netDenied, not netProblem', M.netProblem(M.normalize(payload())), '')

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all assertions passed'))
process.exit(failures ? 1 : 0)
