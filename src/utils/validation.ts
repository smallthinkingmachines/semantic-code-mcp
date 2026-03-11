/**
 * Shared input validation utilities.
 *
 * Provides ID validation for defense-in-depth across modules that
 * handle user-supplied or externally-sourced identifiers.
 *
 * @module utils/validation
 */

import { InvalidIdError } from '../errors.js';

/** Pattern for safe IDs: alphanumeric, underscore, hyphen only */
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Maximum allowed ID length to prevent DoS via long strings */
const MAX_ID_LENGTH = 500;

/**
 * Validate that an ID matches the safe format.
 *
 * @param id - The ID to validate
 * @throws {InvalidIdError} If the ID is too long or contains disallowed characters
 */
export function validateId(id: string): void {
  if (id.length > MAX_ID_LENGTH) {
    throw new InvalidIdError(`ID too long: ${id.length} characters (max ${MAX_ID_LENGTH})`);
  }
  if (!VALID_ID_PATTERN.test(id)) {
    throw new InvalidIdError(`Invalid ID format: contains disallowed characters`);
  }
}

/**
 * Validate an array of IDs. Fails fast on the first invalid ID.
 *
 * @param ids - Array of IDs to validate
 * @throws {InvalidIdError} If any ID is invalid
 */
export function validateIds(ids: string[]): void {
  for (const id of ids) {
    validateId(id);
  }
}
