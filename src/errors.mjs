/**
 * Provider-neutral failure wording shared by the command settlement and the
 * per-attempt report lines.
 *
 * The LLM service already classifies failures into stable codes; translating
 * here keeps every surface (red command card, report line) using one phrase for
 * the same condition.
 *
 * @module dsh-cache-probe/errors
 */

/** Failure code to short Chinese label. */
export const ERROR_LABELS = Object.freeze({
  NO_ADAPTER: '渠道未注册或未启用',
  MISSING_CREDENTIAL: '渠道凭据缺失',
  INVALID_CREDENTIAL: '渠道凭据无效',
  AUTH: '渠道认证失败',
  RATE_LIMIT: '渠道限流',
  QUOTA: '渠道额度不足',
  ACCOUNT_QUOTA: '账号额度不足',
  CONTEXT_WINDOW_EXCEEDED: '载荷超过上下文窗口',
  TIMEOUT: '请求超时',
  INVALID_REQUEST: '请求被渠道拒绝',
  SERVER: '渠道服务异常',
  TRANSPORT: '网络传输异常',
  ABORTED: '探测已取消',
  PROBE_FAILED: '探测失败',
  LLM_ERROR: '渠道请求失败',
  UNSUPPORTED_REASONING_EFFORT: '模型不支持所选思考等级',
})

/**
 * Render one failure as a single human-facing sentence.
 * @param code - stable provider or probe code.
 * @param message - underlying detail; may repeat the label or be empty.
 * @returns `label（code）` or `label（code）：detail`.
 */
export function describeFailure(code, message) {
  const label = ERROR_LABELS[code] ?? '探测失败'
  if (typeof message !== 'string' || message.length === 0 || message === label) return `${label}（${code}）`
  return `${label}（${code}）：${message}`
}