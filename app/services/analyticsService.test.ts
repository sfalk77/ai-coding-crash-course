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
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .run();
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

function addLessons(courseId: number, n: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "M", position: 1 })
    .returning()
    .get();
  return Array.from({ length: n }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `L${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function recordProgress(
  userId: number,
  lessonId: number,
  status = schema.LessonProgressStatus.Completed
) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status,
      completedAt:
        status === schema.LessonProgressStatus.Completed
          ? "2020-01-01T00:00:00.000Z"
          : null,
    })
    .run();
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
      const otherInstructor = addUser(
        "other-instructor",
        schema.UserRole.Instructor
      );
      const foreign = addCourse(otherInstructor.id, "foreign");
      const otherStudent = addUser("other-student");
      enroll(otherStudent.id, foreign.id);
      enroll(base.user.id, base.course.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.courses.map((c) => c.courseId)).toEqual([base.course.id]);
      expect(result.totals.students).toBe(1);
    });

    it("includes courses of every status, with 0 students when nobody enrolled", () => {
      const draft = addCourse(
        base.instructor.id,
        "draft",
        schema.CourseStatus.Draft
      );
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
      const otherInstructor = addUser(
        "other-instructor",
        schema.UserRole.Instructor
      );
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

  describe("getInstructorAnalytics completion", () => {
    it("counts a student with every lesson completed as complete and a partial student towards progress only", () => {
      const [l1, l2, l3, l4] = addLessons(base.course.id, 4);
      const partial = addUser("partial");
      enroll(base.user.id, base.course.id);
      enroll(partial.id, base.course.id);
      for (const l of [l1, l2, l3, l4]) recordProgress(base.user.id, l.id);
      recordProgress(partial.id, l1.id);
      recordProgress(partial.id, l2.id, schema.LessonProgressStatus.InProgress);

      const result = getInstructorAnalytics(base.instructor.id);

      // full: 4/4, partial: 1/4 -> rate 1/2, progress (1 + 0.25) / 2
      expect(rowOf(result, base.course.id)).toMatchObject({
        completionRate: 0.5,
        averageProgress: 0.625,
      });
      expect(result.totals).toMatchObject({
        completionRate: 0.5,
        averageProgress: 0.625,
      });
    });

    it("reports null completion figures for courses with no lessons or no enrolled students", () => {
      const noLessons = addCourse(base.instructor.id, "no-lessons");
      enroll(base.user.id, noLessons.id);
      addLessons(base.course.id, 2); // lessons, but nobody enrolled

      const result = getInstructorAnalytics(base.instructor.id);

      for (const id of [noLessons.id, base.course.id]) {
        expect(rowOf(result, id)).toMatchObject({
          completionRate: null,
          averageProgress: null,
        });
      }
      expect(result.totals).toMatchObject({
        completionRate: null,
        averageProgress: null,
      });
    });

    it("recomputes totals over all enrolled students instead of averaging course figures", () => {
      // base course: 1 of 1 students complete (2/2 lessons).
      const [a1, a2] = addLessons(base.course.id, 2);
      enroll(base.user.id, base.course.id);
      recordProgress(base.user.id, a1.id);
      recordProgress(base.user.id, a2.id);
      // second course: 0 of 3 complete, progress 1/2, 0, 0.
      const second = addCourse(base.instructor.id, "second");
      const [b1] = addLessons(second.id, 2);
      const [x, y, z] = [addUser("x"), addUser("y"), addUser("z")];
      for (const u of [x, y, z]) enroll(u.id, second.id);
      recordProgress(x.id, b1.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, base.course.id)).toMatchObject({
        completionRate: 1,
        averageProgress: 1,
      });
      expect(rowOf(result, second.id).completionRate).toBe(0);
      expect(rowOf(result, second.id).averageProgress).toBeCloseTo(1 / 6);
      // Averaging course figures would give 0.5 and 7/12.
      expect(result.totals.completionRate).toBe(0.25);
      expect(result.totals.averageProgress).toBeCloseTo(1.5 / 4);
    });

    it("ignores the cutoff", () => {
      const [l1, l2] = addLessons(base.course.id, 2);
      const late = addUser("late");
      enroll(base.user.id, base.course.id, JUST_OUTSIDE);
      enroll(late.id, base.course.id, JUST_INSIDE);
      recordProgress(base.user.id, l1.id);
      recordProgress(base.user.id, l2.id);

      const allTime = getInstructorAnalytics(base.instructor.id);
      const windowed = getInstructorAnalytics(base.instructor.id, CUTOFF);

      for (const result of [allTime, windowed]) {
        expect(rowOf(result, base.course.id)).toMatchObject({
          completionRate: 0.5,
          averageProgress: 0.5,
        });
        expect(result.totals).toMatchObject({
          completionRate: 0.5,
          averageProgress: 0.5,
        });
      }
    });

    it("counts only enrolled students' completed lessons of the course itself, once each", () => {
      const [l1, l2] = addLessons(base.course.id, 2);
      const other = addCourse(base.instructor.id, "other");
      const [o1] = addLessons(other.id, 1);
      const bystander = addUser("bystander");
      enroll(base.user.id, base.course.id);
      enroll(base.user.id, base.course.id);
      // Duplicate progress rows for one lesson are still one lesson.
      recordProgress(base.user.id, l1.id);
      recordProgress(base.user.id, l1.id);
      // A lesson of another course doesn't count towards this one.
      recordProgress(base.user.id, o1.id);
      // Progress without an enrollment isn't part of the population.
      recordProgress(bystander.id, l1.id);
      recordProgress(bystander.id, l2.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, base.course.id)).toMatchObject({
        completionRate: 0,
        averageProgress: 0.5,
      });
      expect(rowOf(result, other.id)).toMatchObject({
        completionRate: null,
        averageProgress: null,
      });
      expect(result.totals).toMatchObject({
        completionRate: 0,
        averageProgress: 0.5,
      });
    });
  });
});
