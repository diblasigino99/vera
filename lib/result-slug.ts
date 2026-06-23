import { slugify } from "@/lib/utils";

const separator = "--";

export function buildResultSlug(name: string, searchId: string, resultId: string) {
  return [slugify(name) || "result", encodeURIComponent(searchId), encodeURIComponent(resultId)].join(separator);
}

export function parseResultSlug(slug: string) {
  const parts = slug.split(separator);

  if (parts.length < 3) {
    return null;
  }

  const resultId = parts.pop();
  const searchId = parts.pop();

  if (!searchId || !resultId) {
    return null;
  }

  return {
    searchId: decodeURIComponent(searchId),
    resultId: decodeURIComponent(resultId)
  };
}
