const { isBlackboardAuthenticatedPage } = require('./blackboard-portal.cjs')

function createSuccessfulLoginGate(onSuccess) {
  let completed = false
  return {
    reportNavigation(url) {
      if (completed || !isBlackboardAuthenticatedPage(url)) return false
      completed = true
      onSuccess()
      return true
    },
  }
}

module.exports = { createSuccessfulLoginGate }
