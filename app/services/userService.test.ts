import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { getInstructorOptions } from "./userService";

function insertUser(name: string, email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name, email, role })
    .returning()
    .get();
}

describe("userService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorOptions", () => {
    it("returns only instructors, as id and name", () => {
      insertUser("Ada Admin", "admin@example.com", schema.UserRole.Admin);

      expect(getInstructorOptions()).toEqual([
        { id: base.instructor.id, name: base.instructor.name },
      ]);
    });

    it("orders instructors alphabetically by name", () => {
      const zoe = insertUser("Zoe", "zoe@example.com", schema.UserRole.Instructor);
      const alice = insertUser("Alice", "alice@example.com", schema.UserRole.Instructor);

      expect(getInstructorOptions().map((i) => i.id)).toEqual([
        alice.id,
        base.instructor.id, // "Test Instructor"
        zoe.id,
      ]);
    });

    it("breaks name ties by id", () => {
      const first = insertUser("Sam", "sam1@example.com", schema.UserRole.Instructor);
      const second = insertUser("Sam", "sam2@example.com", schema.UserRole.Instructor);

      const sams = getInstructorOptions().filter((i) => i.name === "Sam");
      expect(sams.map((i) => i.id)).toEqual([first.id, second.id]);
    });

    it("returns an empty list when there are no instructors", () => {
      testDb = createTestDb();

      expect(getInstructorOptions()).toEqual([]);
    });
  });
});
