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
import { getInstructorAnalytics } from "./analyticsService";
import { createTeamPurchase } from "./purchaseService";
import { redeemCoupon } from "./couponService";

function enroll(userId: number, courseId: number, enrolledAt?: string) {
  testDb.insert(schema.enrollments).values({ userId, courseId, enrolledAt }).run();
}

const CUTOFF = new Date("2026-06-01T00:00:00.000Z");
const JUST_INSIDE = "2026-06-01T00:00:00.001Z";
const AT_CUTOFF = "2026-06-01T00:00:00.000Z";
const JUST_OUTSIDE = "2026-05-31T23:59:59.999Z";

function addCourse(
  instructorId: number,
  slug: string,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${slug}`,
      slug,
      description: "d",
      salesCopy: "s",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function addUser(name: string, role = schema.UserRole.Student) {
  return testDb
    .insert(schema.users)
    .values({ name, email: `${name}@example.com`, role })
    .returning()
    .get();
}

type Analytics = ReturnType<typeof getInstructorAnalytics>;

function rowOf(result: Analytics, courseId: number) {
  const row = result.courses.find((c) => c.courseId === courseId);
  if (!row) throw new Error(`No row for course ${courseId}`);
  return row;
}

const lessonCountOf = (r: Analytics, id: number) => rowOf(r, id).lessonCount;
const studentCountOf = (r: Analytics, id: number) => rowOf(r, id).studentCount;

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getInstructorAnalytics", () => {
    it("counts enrolled students for the instructor's course", () => {
      enroll(base.user.id, base.course.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.totals.students).toBe(1);
      expect(result.courses).toEqual([
        expect.objectContaining({
          courseId: base.course.id,
          title: "Test Course",
          status: schema.CourseStatus.Published,
          studentCount: 1,
        }),
      ]);
    });

    it("counts lessons across all modules of each course", () => {
      const m1 = testDb
        .insert(schema.modules)
        .values({ courseId: base.course.id, title: "M1", position: 1 })
        .returning()
        .get();
      const m2 = testDb
        .insert(schema.modules)
        .values({ courseId: base.course.id, title: "M2", position: 2 })
        .returning()
        .get();
      testDb
        .insert(schema.lessons)
        .values([
          { moduleId: m1.id, title: "L1", position: 1 },
          { moduleId: m1.id, title: "L2", position: 2 },
          { moduleId: m2.id, title: "L3", position: 1 },
        ])
        .run();
      const empty = addCourse(base.instructor.id, "empty");

      const result = getInstructorAnalytics(base.instructor.id);

      expect(lessonCountOf(result, base.course.id)).toBe(3);
      expect(lessonCountOf(result, empty.id)).toBe(0);
    });

    it("counts a student enrolled twice in the same course once", () => {
      enroll(base.user.id, base.course.id);
      enroll(base.user.id, base.course.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(studentCountOf(result, base.course.id)).toBe(1);
      expect(result.totals.students).toBe(1);
    });

    it("counts a student in several of the instructor's courses once in the total", () => {
      const second = addCourse(base.instructor.id, "second");
      const other = addUser("other");
      enroll(base.user.id, base.course.id);
      enroll(base.user.id, second.id);
      enroll(other.id, second.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(studentCountOf(result, base.course.id)).toBe(1);
      expect(studentCountOf(result, second.id)).toBe(2);
      expect(result.totals.students).toBe(2);
    });

    it("counts students enrolled through a team coupon without a purchase of their own", () => {
      const buyer = addUser("buyer");
      const { coupons } = createTeamPurchase(
        buyer.id,
        base.course.id,
        10000,
        null,
        1
      );
      const redeemed = redeemCoupon(coupons[0].code, base.user.id, "US");
      expect(redeemed.ok).toBe(true);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(studentCountOf(result, base.course.id)).toBe(1);
      expect(result.totals.students).toBe(1);
    });

    it("never includes another instructor's courses or enrollments", () => {
      const otherInstructor = addUser("other-instructor", schema.UserRole.Instructor);
      const foreign = addCourse(otherInstructor.id, "foreign");
      const otherStudent = addUser("other-student");
      enroll(otherStudent.id, foreign.id);
      enroll(base.user.id, base.course.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.courses.map((c) => c.courseId)).toEqual([base.course.id]);
      expect(result.totals.students).toBe(1);
    });

    it("includes courses of every status, with 0 students when nobody enrolled", () => {
      const draft = addCourse(base.instructor.id, "draft", schema.CourseStatus.Draft);
      const archived = addCourse(
        base.instructor.id,
        "archived",
        schema.CourseStatus.Archived
      );

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, draft.id)).toMatchObject({
        status: schema.CourseStatus.Draft,
        studentCount: 0,
        lessonCount: 0,
      });
      expect(rowOf(result, archived.id)).toMatchObject({
        status: schema.CourseStatus.Archived,
        studentCount: 0,
      });
      expect(studentCountOf(result, base.course.id)).toBe(0);
      expect(result.totals.students).toBe(0);
    });
  });

  describe("getInstructorAnalytics with a cutoff", () => {
    it("counts enrollments at or after the cutoff as new, alongside the all-time total", () => {
      const a = addUser("a");
      const b = addUser("b");
      const c = addUser("c");
      enroll(a.id, base.course.id, JUST_INSIDE);
      enroll(b.id, base.course.id, AT_CUTOFF);
      enroll(c.id, base.course.id, JUST_OUTSIDE);

      const result = getInstructorAnalytics(base.instructor.id, CUTOFF);

      expect(result.totals).toMatchObject({ students: 3, newEnrollments: 2 });
      expect(rowOf(result, base.course.id)).toMatchObject({
        studentCount: 3,
        newEnrollmentCount: 2,
      });
    });

    it("reports no new-enrollment figures without a cutoff", () => {
      enroll(base.user.id, base.course.id, JUST_INSIDE);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.totals.newEnrollments).toBeNull();
      expect(rowOf(result, base.course.id).newEnrollmentCount).toBeNull();
    });

    it("does not count a duplicate re-enrollment of an existing student as new", () => {
      enroll(base.user.id, base.course.id, JUST_OUTSIDE);
      enroll(base.user.id, base.course.id, JUST_INSIDE);

      const result = getInstructorAnalytics(base.instructor.id, CUTOFF);

      expect(result.totals).toMatchObject({ students: 1, newEnrollments: 0 });
      expect(rowOf(result, base.course.id).newEnrollmentCount).toBe(0);
    });

    it("counts new enrollments per course and sums them in the total", () => {
      const second = addCourse(base.instructor.id, "second");
      const empty = addCourse(base.instructor.id, "empty");
      const other = addUser("other");
      const veteran = addUser("veteran");
      // base.user enrolls newly in both courses: two new enrollments.
      enroll(base.user.id, base.course.id, JUST_INSIDE);
      enroll(base.user.id, second.id, JUST_INSIDE);
      enroll(other.id, second.id, JUST_INSIDE);
      // veteran's first enrollment in second is a new enrollment, even
      // though they took the base course long ago.
      enroll(veteran.id, base.course.id, JUST_OUTSIDE);
      enroll(veteran.id, second.id, JUST_INSIDE);
      // Another instructor's new enrollments never leak in.
      const otherInstructor = addUser("other-instructor", schema.UserRole.Instructor);
      const foreign = addCourse(otherInstructor.id, "foreign");
      enroll(other.id, foreign.id, JUST_INSIDE);

      const result = getInstructorAnalytics(base.instructor.id, CUTOFF);

      expect(rowOf(result, base.course.id)).toMatchObject({
        studentCount: 2,
        newEnrollmentCount: 1,
      });
      expect(rowOf(result, second.id)).toMatchObject({
        studentCount: 3,
        newEnrollmentCount: 3,
      });
      expect(rowOf(result, empty.id)).toMatchObject({
        studentCount: 0,
        newEnrollmentCount: 0,
      });
      expect(result.totals).toMatchObject({ students: 3, newEnrollments: 4 });
    });
  });
});
