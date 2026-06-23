"use client";

const storageKey = "vera_anonymous_id";

export function getAnonymousId() {
  const existing = window.localStorage.getItem(storageKey);

  if (existing) {
    return existing;
  }

  const next = crypto.randomUUID();
  window.localStorage.setItem(storageKey, next);
  return next;
}
