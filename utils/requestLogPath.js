'use strict';

/**
 * Return only the path portion of a request target for logs.
 * Query strings can contain one-time verification, recovery, or SSE tickets.
 */
function requestLogPath(requestTarget) {
  if (typeof requestTarget !== 'string' || !requestTarget) return '/';
  const path = requestTarget.split(/[?#]/, 1)[0];
  // Encode control characters and whitespace so request targets cannot forge
  // or inject additional access-log lines.
  return (path || '/')
    .slice(0, 2048)
    .replace(/[\s\x00-\x1f\x7f\u2028\u2029]+/g, '_');
}

module.exports = { requestLogPath };
