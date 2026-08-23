export function getUpstreamStatus(error) {
  return error?.response?.status || error?.status || error?.statusCode || 500;
}

async function readReadableStreamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

export async function readUpstreamErrorBody(error) {
  if (!error) return '';

  const data = error?.response?.data;

  // axios stream response
  if (data?.readable) {
    try {
      return await readReadableStreamToString(data);
    } catch {
      // fall through
    }
  }

  if (typeof data === 'object' && data !== null) {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  if (data !== undefined && data !== null) return String(data);
  if (error.message) return String(error.message);
  return String(error);
}

export function isCallerDoesNotHavePermission(errorBody) {
  try {
    return JSON.stringify(errorBody).includes('The caller does not');
  } catch {
    return String(errorBody).includes('The caller does not');
  }
}

/**
 * 判断错误是否为 Google 的地区限制（400 FAILED_PRECONDITION "User location is not supported"）
 * @param {Error} error - 上游错误对象
 * @returns {boolean}
 */
export function isGeoLocationRestrictedError(error) {
  if (!error) return false;
  const parts = [
    error?.message,
    typeof error?.rawBody === 'string' ? error.rawBody : '',
    error?.rawBody && typeof error.rawBody === 'object' ? JSON.stringify(error.rawBody) : '',
    error?.response?.data ? JSON.stringify(error.response.data) : ''
  ].join(' ');
  return /location is not supported/i.test(parts);
}
