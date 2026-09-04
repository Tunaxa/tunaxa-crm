export async function retryWithBackoff(fn, { attempts = 3, baseDelayMs = 250, maxDelayMs = 2500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * baseDelayMs;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
