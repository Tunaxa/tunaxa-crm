import {
  cacheFlush,
  cacheGet,
  cacheSet,
  hashParams,
} from "../../services/cache.js";

export async function cachedList(resource, params, load) {
  const key = `${resource}:list:${hashParams(params)}`;
  const cached = await cacheGet(key);
  if (cached !== null) return cached;

  const result = await load();
  await cacheSet(key, result, 60);
  return result;
}

export async function invalidateListCache(resource) {
  await cacheFlush(`${resource}:list:*`);
}
