export function compareFixture(expected, actual) {
  const mismatches = [];
  walk(expected, actual, '', mismatches);
  if (actual !== undefined) {
    collectExtras(expected, actual, '', mismatches);
  }
  return {
    match: mismatches.length === 0,
    mismatches,
    highSeverity: mismatches.filter((m) => m.severity === 'high'),
    lowSeverity: mismatches.filter((m) => m.severity === 'low'),
  };
}

function walk(expected, actual, path, mismatches) {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      mismatches.push(diff(path || '/', expected, actual));
      return;
    }
    for (const key of Object.keys(expected)) {
      walk(expected[key], actual[key], join(path, key), mismatches);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(diff(path || '/', expected, actual));
      return;
    }
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i += 1) {
      if (i >= expected.length) {
        mismatches.push(diff(join(path, String(i)), undefined, actual[i], 'unexpected'));
      } else if (i >= actual.length) {
        mismatches.push(diff(join(path, String(i)), expected[i], undefined, 'missing'));
      } else {
        walk(expected[i], actual[i], join(path, String(i)), mismatches);
      }
    }
    return;
  }
  if (!valuesEqual(expected, actual)) {
    mismatches.push(diff(path || '/', expected, actual));
  }
}

function collectExtras(expected, actual, path, mismatches) {
  if (!isPlainObject(expected) || !isPlainObject(actual)) return;
  for (const key of Object.keys(actual)) {
    const next = join(path, key);
    if (!Object.prototype.hasOwnProperty.call(expected, key)) {
      mismatches.push(diff(next, undefined, actual[key], 'unexpected'));
    } else {
      collectExtras(expected[key], actual[key], next, mismatches);
    }
  }
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return false;
}

function diff(path, expected, actual, kind = 'mismatch') {
  return {
    path: path || '/',
    kind,
    expected,
    actual,
    severity: severityFor(path),
  };
}

function severityFor(path) {
  const p = String(path).toLowerCase();
  if (p.endsWith('/notes') || p.endsWith('/reason')) return 'low';
  return 'high';
}

function join(path, key) {
  return `${path}/${key}`.replace(/\/+/g, '/');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
