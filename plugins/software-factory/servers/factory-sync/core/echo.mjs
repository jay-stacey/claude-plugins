// Echo suppression and dedupe keys (design C §8).
import { sha } from './normalize.mjs';

/** True when the remote value hash equals what we pushed (returned) or what we last pulled. */
export function isEcho(entry, field, remoteHash) {
  if (!entry) return false;
  const pushed = entry.pushed || {};
  const pulled = entry.pulled || {};
  return remoteHash === pushed[field] || remoteHash === pulled[field];
}

/** Fast skip: the remote item has not changed since our own last write. */
export function unchangedSincePush(entry, updatedAt) {
  const t = entry && entry.pushed && entry.pushed.remoteUpdatedAt;
  if (!t || !updatedAt) return false;
  return Date.parse(updatedAt) <= Date.parse(t);
}

export function isOurComment(entry, commentId) {
  return !!(entry && Array.isArray(entry.ourCommentIds) && entry.ourCommentIds.includes(String(commentId)));
}

export function dedupeKey(kind, remoteId, field, afterHash) {
  return sha(`${kind}\n${remoteId}\n${field}\n${afterHash}`).slice(0, 40);
}

/** Push op id: stable for the same local value at the same local revision. */
export function opId(localId, type, field, valueHash, localRev) {
  return sha(`${localId}\n${type}\n${field || ''}\n${valueHash || ''}\n${localRev ?? ''}`).slice(0, 24);
}
