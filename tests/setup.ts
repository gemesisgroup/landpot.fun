// Add global mocks or configuration here if needed
import "vitest-canvas-mock";
// Landpot formats in en-US whatever the machine locale (src/client/EnglishOnly.ts).
import "../src/client/EnglishOnly";
// Registers the per-test DOM teardown. Imported here, and not from individual
// test files, so its hooks are registered before any test file's own -- see the
// hook-order note in that file.
import "./domTeardown";

// ServerEnv.gitCommit() throws when unset; the dev server sets GIT_COMMIT=DEV,
// so tests exercising server code (e.g. the lobby feed) mirror that.
process.env.GIT_COMMIT ??= "DEV";
