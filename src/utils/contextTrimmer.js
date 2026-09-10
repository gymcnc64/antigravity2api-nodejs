import logger from './logger.js';
import { safeStringify } from '../api/upstreamError.js';

/**
 * 上游输入 Token 上限保护
 *
 * Google Antigravity 上游对单次请求的输入 token 有硬限制（1048576）。
 * 客户端（如 IDE / ZCode 等）自行统计的上下文长度不一定包含服务端追加的
 * 系统提示词与工具定义，因此请求可能在服务端侧越界并被上游以
 * 400 INVALID_ARGUMENT "The input token count exceeds the maximum number of
 * tokens allowed 1048576." 拒绝。
 *
 * 本模块在发送前估算输入规模，超过安全阈值时从最旧对话开始裁剪，
 * 保证请求能够正常完成（并在日志中记录裁剪行为）。
 */

// Google 上游对输入 token 的硬限制
export const MODEL_INPUT_TOKEN_LIMIT = 1048576;

// 发送前主动裁剪阈值：仅在估算明显越界时裁剪，避免误伤正常请求
// （估算函数为保守偏高估计，低于此值时不主动裁剪；被上游拒绝时仍有反应式裁剪兜底）
export const SAFE_INPUT_TOKEN_TARGET = Number(process.env.CONTEXT_TOKEN_TARGET) > 0
  ? Number(process.env.CONTEXT_TOKEN_TARGET)
  : MODEL_INPUT_TOKEN_LIMIT;

/**
 * 文本 token 估算（分语言，偏保守）
 * 中日韩字符约 1 token/字；其余（拉丁字母/符号）约 4 字符 = 1 token。
 * 英文内容估算偏高约 10%，中文接近实际，整体宁可高估不可低估。
 */
function estimateTextTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0x2E80) cjk++; else other++;
  }
  return Math.ceil(cjk * 1.05 + other / 4);
}

/**
 * parts 数组 token 估算
 * inlineData（图片）按固定值估算，避免 base64 长度造成数量级高估
 */
function estimatePartsTokens(parts) {
  if (!Array.isArray(parts)) return 0;
  let tokens = 0;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      tokens += estimateTextTokens(part.text);
    } else if (part.inlineData?.data || part.fileData) {
      tokens += 1200;
    } else {
      tokens += estimateTextTokens(safeStringify(part));
    }
  }
  return tokens;
}

/**
 * 估算整个请求体的输入 token（含系统提示词与工具定义）
 */
export function estimateRequestTokens(requestBody) {
  const req = requestBody?.request;
  if (!req) return 0;
  let tokens = 0;

  if (Array.isArray(req.contents)) {
    for (const content of req.contents) {
      tokens += estimatePartsTokens(content?.parts) + 8;
    }
  }
  if (req.systemInstruction) {
    tokens += estimatePartsTokens(req.systemInstruction.parts) + 8;
  }
  if (req.generationConfig) {
    tokens += estimateTextTokens(safeStringify(req.generationConfig));
  }
  if (req.tools) {
    tokens += estimateTextTokens(safeStringify(req.tools));
  }
  return tokens;
}

/**
 * 是否为「输入 token 超过上游上限」错误
 */
export function isInputTooLongError(error) {
  if (!error) return false;
  const text = [
    error.message,
    typeof error.rawBody === 'string' ? error.rawBody : safeStringify(error.rawBody),
    safeStringify(error.response?.data)
  ].join(' ');
  return /input token count exceeds the maximum number of tokens allowed/i.test(text);
}

/**
 * 裁剪点是否为安全边界：
 * 必须是普通 user 消息（不携带 functionResponse），
 * 否则 functionResponse 会失去配对的 functionCall 导致上游报错。
 */
function isSafeCutPoint(content) {
  if (!content || content.role !== 'user') return false;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return !parts.some(p => p && p.functionResponse);
}

/**
 * 将 request.contents 裁剪到目标 token 以内（保留最新对话，丢弃最旧部分）
 * @returns {Object|null} 裁剪后的请求体；无需裁剪或无法裁剪时返回 null
 */
export function trimContentsToFit(requestBody, targetTokens = SAFE_INPUT_TOKEN_TARGET) {
  const req = requestBody?.request;
  const contents = req?.contents;
  if (!Array.isArray(contents) || contents.length <= 1) return null;

  // 固定开销（系统提示词、工具定义、生成配置）
  const fixedTokens = estimateRequestTokens({ request: { ...req, contents: [] } });
  const budget = Math.max(targetTokens - fixedTokens, 2000);

  const msgTokens = contents.map(c => estimatePartsTokens(c?.parts) + 8);

  // 从尾部向前累加，求满足预算的最短后缀（至少包含最后一条消息）
  let start = contents.length;
  let acc = 0;
  for (let i = contents.length - 1; i >= 0; i--) {
    if (start < contents.length && acc + msgTokens[i] > budget) break;
    acc += msgTokens[i];
    start = i;
  }
  if (start === 0) return null; // 无需裁剪

  // 起点必须是安全 user 消息，否则继续向后裁剪
  let cut = start;
  while (cut < contents.length - 1 && !isSafeCutPoint(contents[cut])) cut++;
  if (cut >= contents.length) cut = contents.length - 1;
  if (cut === 0) return null;

  return {
    ...requestBody,
    request: { ...req, contents: contents.slice(cut) }
  };
}

/**
 * 发送前预处理：估算超阈值时主动裁剪
 * @returns {Object} 处理后的请求体（可能为原对象）
 */
export function prepareRequestBody(requestBody, targetTokens = SAFE_INPUT_TOKEN_TARGET) {
  const estimated = estimateRequestTokens(requestBody);
  if (estimated <= targetTokens) return requestBody;

  const trimmed = trimContentsToFit(requestBody, targetTokens);
  if (!trimmed) return requestBody;

  logger.warn(
    `[ContextTrim] 输入估算 ${estimated} tokens 超过安全阈值 ${targetTokens}，` +
    `已裁剪最旧对话，估算降至 ${estimateRequestTokens(trimmed)} tokens`
  );
  return trimmed;
}
