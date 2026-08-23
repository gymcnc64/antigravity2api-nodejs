export function getUpstreamStatus(error) {
  return error?.response?.status || error?.status || error?.statusCode || 500;
}

/**
 * 安全地序列化对象为字符串，防止循环引用导致异常（如 IncomingMessage/Stream）
 * @param {any} obj
 * @param {number} [space=0]
 * @returns {string}
 */
export function safeStringify(obj, space = 0) {
  if (obj === undefined || obj === null) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object') return String(obj);

  // 如果是 Readable 流或有 socket 属性的对象（如 IncomingMessage），直接跳过序列化
  if (obj.readable || obj.socket || obj._readableState) {
    return '';
  }

  try {
    return space > 0 ? JSON.stringify(obj, null, space) : JSON.stringify(obj);
  } catch {
    // 存在循环引用等异常时回退
    return String(obj.message || obj.statusText || '');
  }
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
    return safeStringify(data, 2);
  }

  if (data !== undefined && data !== null) return String(data);
  if (error.message) return String(error.message);
  return String(error);
}

export function isCallerDoesNotHavePermission(errorBody) {
  try {
    const text = safeStringify(errorBody);
    return text.includes('The caller does not');
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
    typeof error?.rawBody === 'string' ? error.rawBody : safeStringify(error?.rawBody),
    typeof error?.response?.data === 'string' ? error.response.data : safeStringify(error?.response?.data)
  ].join(' ');
  return /location is not supported/i.test(parts);
}
