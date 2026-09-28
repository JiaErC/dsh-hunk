/**
 * Pure note-anchoring logic, shared by the tab body and the tests.
 *
 * Hunk reports a note's hunk either as an index or as a line range; a note
 * whose anchor no longer resolves (the review was reloaded under it) must
 * still be shown, so it lands in the file's `loose` bucket rather than
 * disappearing.
 */
import type { HunkReviewFile, HunkReviewHunk, HunkReviewNote } from './wire'

/** One file's notes, split by the hunk they anchor to. */
export interface FileNotes {
  byHunk: Map<number, HunkReviewNote[]>
  /** Notes with no resolvable hunk anchor (including file-level notes). */
  loose: HunkReviewNote[]
}

/** Path comparison key: Hunk reports POSIX spelling, Windows may differ in case. */
export function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Whether two inclusive line ranges overlap. */
export function overlaps(
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined,
): boolean {
  if (a === undefined || b === undefined) return false
  return a[0] <= b[1] && b[0] <= a[1]
}

/**
 * Resolve the hunk one note belongs to.
 * @param file - the reviewed file.
 * @param note - one note.
 * @returns the hunk, by index first and by range overlap second.
 */
export function hunkOfNote(file: HunkReviewFile, note: HunkReviewNote): HunkReviewHunk | undefined {
  if (note.hunkIndex !== undefined) {
    const byIndex = file.hunks.find(hunk => hunk.index === note.hunkIndex)
    if (byIndex !== undefined) return byIndex
  }
  return file.hunks.find(hunk =>
    overlaps(note.oldRange, hunk.oldRange) || overlaps(note.newRange, hunk.newRange))
}

/**
 * Group one file's notes by hunk.
 * @param file - the reviewed file.
 * @param notes - every note of the review (notes of other files are ignored).
 * @returns the notes of this file, bucketed per hunk plus the unanchored rest.
 */
export function groupNotes(file: HunkReviewFile, notes: readonly HunkReviewNote[]): FileNotes {
  const byHunk = new Map<number, HunkReviewNote[]>()
  const loose: HunkReviewNote[] = []
  const key = pathKey(file.path)
  for (const note of notes) {
    if (pathKey(note.filePath) !== key) continue
    const hunk = hunkOfNote(file, note)
    if (hunk === undefined) {
      loose.push(note)
      continue
    }
    const bucket = byHunk.get(hunk.index)
    if (bucket === undefined) byHunk.set(hunk.index, [note])
    else bucket.push(note)
  }
  return { byHunk, loose }
}
