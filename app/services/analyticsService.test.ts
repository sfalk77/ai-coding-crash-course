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
import { createPurchase, createTeamPurchase } from "./purchaseService";
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

function purchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt?: string
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country: "US", createdAt })
    .returning()
    .get();
}

function addQuiz(lessonId: number, passingScore = 0.7) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Q", passingScore })
    .returning()
    .get();
}

function attempt(
  userId: number,
  quizId: number,
  score: number,
  passed: boolean,
  attemptedAt?: string
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed, attemptedAt })
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

  describe("getInstructorAnalytics revenue", () => {
    it("sums the amount actually paid per course and in total", () => {
      const second = addCourse(base.instructor.id, "second");
      const buyer = addUser("buyer");
      // Regional pricing: the discounted amount paid is what counts.
      createPurchase(base.user.id, base.course.id, 4999, "US");
      createPurchase(buyer.id, base.course.id, 2500, "IN");
      createPurchase(buyer.id, second.id, 1000, "DE");

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, base.course.id).revenue).toBe(7499);
      expect(rowOf(result, second.id).revenue).toBe(1000);
      expect(result.totals.revenue).toBe(8499);
    });

    it("reports 0 for a course with no purchases", () => {
      const empty = addCourse(base.instructor.id, "empty");

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, empty.id).revenue).toBe(0);
      expect(rowOf(result, base.course.id).revenue).toBe(0);
      expect(result.totals.revenue).toBe(0);
    });

    it("counts a team purchase in full, and coupon redemptions add nothing", () => {
      const buyer = addUser("buyer");
      const { coupons } = createTeamPurchase(
        buyer.id,
        base.course.id,
        30000,
        "US",
        3
      );
      const redeemed = redeemCoupon(coupons[0].code, base.user.id, "US");
      expect(redeemed.ok).toBe(true);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, base.course.id).revenue).toBe(30000);
      expect(result.totals.revenue).toBe(30000);
    });

    it("never counts another instructor's purchases", () => {
      const otherInstructor = addUser(
        "other-instructor",
        schema.UserRole.Instructor
      );
      const foreign = addCourse(otherInstructor.id, "foreign");
      createPurchase(base.user.id, foreign.id, 9999, "US");
      createPurchase(base.user.id, base.course.id, 100, "US");

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.courses.map((c) => c.courseId)).toEqual([base.course.id]);
      expect(result.totals.revenue).toBe(100);
    });

    it("with a cutoff counts only purchases made at or after it", () => {
      const second = addCourse(base.instructor.id, "second");
      const [a, b, c] = [addUser("a"), addUser("b"), addUser("c")];
      purchase(a.id, base.course.id, 100, JUST_INSIDE);
      purchase(b.id, base.course.id, 200, AT_CUTOFF);
      purchase(c.id, base.course.id, 400, JUST_OUTSIDE);
      purchase(a.id, second.id, 800, JUST_OUTSIDE);

      const windowed = getInstructorAnalytics(base.instructor.id, CUTOFF);
      const allTime = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(windowed, base.course.id).revenue).toBe(300);
      expect(rowOf(windowed, second.id).revenue).toBe(0);
      expect(windowed.totals.revenue).toBe(300);
      expect(rowOf(allTime, base.course.id).revenue).toBe(700);
      expect(allTime.totals.revenue).toBe(1500);
    });

    it("dates a team purchase by when it was bought, not when coupons are redeemed", () => {
      const buyer = addUser("buyer");
      const bought = purchase(buyer.id, base.course.id, 30000, JUST_OUTSIDE);
      const team = testDb.insert(schema.teams).values({}).returning().get();
      testDb
        .insert(schema.coupons)
        .values({
          code: "LATE",
          teamId: team.id,
          courseId: base.course.id,
          purchaseId: bought.id,
          redeemedByUserId: base.user.id,
          redeemedAt: JUST_INSIDE,
        })
        .run();

      const result = getInstructorAnalytics(base.instructor.id, CUTOFF);

      expect(result.totals.revenue).toBe(0);
    });
  });

  describe("getInstructorAnalytics quizzes", () => {
    it("counts each student's highest score, and as passed if any attempt passed", () => {
      const [l1] = addLessons(base.course.id, 1);
      const quiz = addQuiz(l1.id);
      const retrier = addUser("retrier");
      const struggler = addUser("struggler");
      // retrier fails, then passes: best is 0.9, passed.
      attempt(retrier.id, quiz.id, 0.4, false);
      attempt(retrier.id, quiz.id, 0.9, true);
      // struggler's later, worse attempt doesn't drag the best down.
      attempt(struggler.id, quiz.id, 0.6, false);
      attempt(struggler.id, quiz.id, 0.2, false);

      const result = getInstructorAnalytics(base.instructor.id);

      // best scores 0.9 and 0.6 -> 0.75; 1 of 2 students passed.
      expect(rowOf(result, base.course.id).quizScore).toBeCloseTo(0.75);
      expect(rowOf(result, base.course.id).quizPassRate).toBe(0.5);
      expect(result.totals.quizScore).toBeCloseTo(0.75);
      expect(result.totals.quizPassRate).toBe(0.5);
    });

    it("weights every quiz equally, per course and across all quizzes in the total", () => {
      // base course: quiz A with three students, quiz B with one.
      const [a1, a2] = addLessons(base.course.id, 2);
      const quizA = addQuiz(a1.id);
      const quizB = addQuiz(a2.id);
      const [x, y, z] = [addUser("x"), addUser("y"), addUser("z")];
      attempt(x.id, quizA.id, 1, true);
      attempt(y.id, quizA.id, 1, true);
      attempt(z.id, quizA.id, 1, true);
      attempt(x.id, quizB.id, 0.2, false);
      // second course: one quiz, one student.
      const second = addCourse(base.instructor.id, "second");
      const [b1] = addLessons(second.id, 1);
      const quizC = addQuiz(b1.id);
      attempt(x.id, quizC.id, 0.6, false);

      const result = getInstructorAnalytics(base.instructor.id);

      // Per quiz: A = 1 / 1, B = 0.2 / 0, C = 0.6 / 0.
      // Weighting by student would give base 0.8 / 0.75.
      expect(rowOf(result, base.course.id).quizScore).toBeCloseTo(0.6);
      expect(rowOf(result, base.course.id).quizPassRate).toBe(0.5);
      expect(rowOf(result, second.id).quizScore).toBeCloseTo(0.6);
      expect(rowOf(result, second.id).quizPassRate).toBe(0);
      // Mean over the three quizzes; averaging the course figures would give
      // a pass rate of 0.25.
      expect(result.totals.quizScore).toBeCloseTo(0.6);
      expect(result.totals.quizPassRate).toBeCloseTo(1 / 3);
    });

    it("reports null quiz figures for courses with no quizzes or no attempts, and leaves unattempted quizzes out", () => {
      const [l1, l2] = addLessons(base.course.id, 2);
      const attempted = addQuiz(l1.id);
      addQuiz(l2.id); // never attempted: not a 0
      attempt(base.user.id, attempted.id, 0.8, true);
      const noAttempts = addCourse(base.instructor.id, "no-attempts");
      const [n1] = addLessons(noAttempts.id, 1);
      addQuiz(n1.id);
      const noQuizzes = addCourse(base.instructor.id, "no-quizzes");
      addLessons(noQuizzes.id, 1);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(rowOf(result, base.course.id)).toMatchObject({
        quizCount: 2,
        quizPassRate: 1,
      });
      expect(rowOf(result, base.course.id).quizScore).toBeCloseTo(0.8);
      expect(rowOf(result, noAttempts.id)).toMatchObject({
        quizCount: 1,
        quizScore: null,
        quizPassRate: null,
      });
      expect(rowOf(result, noQuizzes.id)).toMatchObject({
        quizCount: 0,
        quizScore: null,
        quizPassRate: null,
      });
      expect(result.totals.quizScore).toBeCloseTo(0.8);
      expect(result.totals.quizPassRate).toBe(1);
    });

    it("reports null quiz totals when nothing was attempted", () => {
      const [l1] = addLessons(base.course.id, 1);
      addQuiz(l1.id);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.totals).toMatchObject({
        quizScore: null,
        quizPassRate: null,
      });
    });

    it("never includes another instructor's quizzes or attempts", () => {
      const otherInstructor = addUser(
        "other-instructor",
        schema.UserRole.Instructor
      );
      const foreign = addCourse(otherInstructor.id, "foreign");
      const [f1] = addLessons(foreign.id, 1);
      attempt(base.user.id, addQuiz(f1.id).id, 0, false);
      const [l1] = addLessons(base.course.id, 1);
      attempt(base.user.id, addQuiz(l1.id).id, 1, true);

      const result = getInstructorAnalytics(base.instructor.id);

      expect(result.totals).toMatchObject({ quizScore: 1, quizPassRate: 1 });
    });

    it("with a cutoff considers only attempts made at or after it", () => {
      const [l1] = addLessons(base.course.id, 1);
      const quiz = addQuiz(l1.id);
      const [a, b, c] = [addUser("a"), addUser("b"), addUser("c")];
      attempt(a.id, quiz.id, 0.5, false, JUST_INSIDE);
      attempt(b.id, quiz.id, 0.8, true, AT_CUTOFF);
      attempt(c.id, quiz.id, 1, true, JUST_OUTSIDE);
      // a's best attempt overall is outside the window, so it doesn't count.
      attempt(a.id, quiz.id, 1, true, JUST_OUTSIDE);

      const windowed = getInstructorAnalytics(base.instructor.id, CUTOFF);
      const allTime = getInstructorAnalytics(base.instructor.id);

      // In window: a 0.5 (failed), b 0.8 (passed).
      expect(rowOf(windowed, base.course.id).quizScore).toBeCloseTo(0.65);
      expect(rowOf(windowed, base.course.id).quizPassRate).toBe(0.5);
      expect(windowed.totals.quizScore).toBeCloseTo(0.65);
      expect(windowed.totals.quizPassRate).toBe(0.5);
      // All time: a 1, b 0.8, c 1, all passed.
      expect(rowOf(allTime, base.course.id).quizScore).toBeCloseTo(2.8 / 3);
      expect(rowOf(allTime, base.course.id).quizPassRate).toBe(1);
    });

    it("with a cutoff reports null for a course whose attempts all predate it", () => {
      const [l1] = addLessons(base.course.id, 1);
      attempt(base.user.id, addQuiz(l1.id).id, 1, true, JUST_OUTSIDE);

      const result = getInstructorAnalytics(base.instructor.id, CUTOFF);

      expect(rowOf(result, base.course.id)).toMatchObject({
        quizCount: 1,
        quizScore: null,
        quizPassRate: null,
      });
      expect(result.totals).toMatchObject({
        quizScore: null,
        quizPassRate: null,
      });
    });
  });
});
