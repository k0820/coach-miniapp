const { canonicalize } = require('./cloud-migration')

const canonicalJson = value => JSON.stringify(canonicalize(value))
const sameSummary = (current, candidate) => canonicalJson(current) === canonicalJson(candidate)

function summaryDiff(current = {}, candidate = {}) {
  const diff = {}
  const keys = [...new Set([...Object.keys(current || {}), ...Object.keys(candidate || {})])].sort()
  keys.forEach(field => {
    const currentHas = Object.prototype.hasOwnProperty.call(current || {}, field)
    const candidateHas = Object.prototype.hasOwnProperty.call(candidate || {}, field)
    if (!currentHas || !candidateHas || canonicalJson(current[field]) !== canonicalJson(candidate[field])) {
      diff[field] = {
        current: currentHas ? current[field] : undefined,
        candidate: candidateHas ? candidate[field] : undefined
      }
    }
  })
  return diff
}

module.exports = { canonicalJson, sameSummary, summaryDiff }
