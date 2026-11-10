import {
  and,
  count,
  countDistinct,
  eq,
  gte,
  min,
  sql,
  sum,
} from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  LessonProgressStatus,
  lessons,
  modules,
  purchases,
} from "~/db/schema";

/**
 * Analytics across all of one instructor's courses (every status).
 * Each metric is a single grouped aggregate query — never one query per course.
 *
 * `since` restricts activity metrics to the window starting at that instant
 * (inclusive). Absent means all time; window-only fields are then `null`.
 */
export function getInstructorAnalytics(instructorId: number, since?: Date) {
  const ownCourse = eq(courses.instructorId, instructorId);

  const instructorCourses = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      description: courses.description,
      coverImageUrl: courses.coverImageUrl,
      status: courses.status,
    })
    .from(courses)
    .where(ownCourse)
    .orderBy(courses.title)
    .all();

  const studentCounts = db
    .select({
      courseId: enrollments.courseId,
      count: countDistinct(enrollments.userId),
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(ownCourse)
    .groupBy(enrollments.courseId)
    .all();

  const lessonCounts = db
    .select({ courseId: modules.courseId, count: count(lessons.id) })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(ownCourse)
    .groupBy(modules.courseId)
    .all();

  // Distinct across all courses: a student in two courses counts once.
  const totalStudents = db
    .select({ count: countDistinct(enrollments.userId) })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(ownCourse)
    .get();

  const studentsByCourse = byCourse(studentCounts);
  const lessonsByCourse = byCourse(lessonCounts);
  const newInWindow = since ? newEnrollmentCounts(instructorId, since) : null;
  // Completion is always all time: `since` is deliberately not passed.
  const completion = completionFigures(instructorId);
  const revenue = revenueFigures(instructorId, since);

  return {
    totals: {
      students: totalStudents?.count ?? 0,
      newEnrollments: newInWindow?.total ?? null,
      revenue: revenue.total,
      ...completion.total,
    },
    courses: instructorCourses.map((course) => ({
      courseId: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      coverImageUrl: course.coverImageUrl,
      status: course.status,
      lessonCount: lessonsByCourse.get(course.id) ?? 0,
      studentCount: studentsByCourse.get(course.id) ?? 0,
      newEnrollmentCount: newInWindow
        ? (newInWindow.byCourse.get(course.id) ?? 0)
        : null,
      revenue: revenue.byCourse.get(course.id) ?? 0,
      ...(completion.byCourse.get(course.id) ?? NO_COMPLETION_DATA),
    })),
  };
}

export type InstructorAnalytics = ReturnType<typeof getInstructorAnalytics>;

function byCourse(rows: { courseId: number; count: number }[]) {
  return new Map(rows.map((r) => [r.courseId, r.count]));
}

/**
 * New enrollments: (student, course) pairs whose first enrollment falls
 * inside the window. Using the first enrollment means a duplicate
 * re-enrollment of an existing student is not counted as new. The total is
 * the sum over courses, so it matches the per-course rows.
 */
function newEnrollmentCounts(instructorId: number, since: Date) {
  const firstEnrollments = db
    .select({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
      firstEnrolledAt: min(enrollments.enrolledAt).as("first_enrolled_at"),
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(enrollments.userId, enrollments.courseId)
    .as("first_enrollments");

  // Timestamps are ISO-8601 UTC strings, so string order is time order.
  const inWindow = gte(firstEnrollments.firstEnrolledAt, since.toISOString());

  const perCourse = db
    .select({
      courseId: firstEnrollments.courseId,
      count: count(),
    })
    .from(firstEnrollments)
    .where(inWindow)
    .groupBy(firstEnrollments.courseId)
    .all();

  const total = db
    .select({ count: count() })
    .from(firstEnrollments)
    .where(inWindow)
    .get();

  return { byCourse: byCourse(perCourse), total: total?.count ?? 0 };
}

/**
 * Gross revenue in cents: the sum of `amountPaid` (after regional pricing) on
 * purchases of the instructor's courses. A team purchase is one row holding
 * the full amount, dated when it was bought; coupon redemptions create no
 * purchase and so add nothing. With `since`, only purchases made at or after
 * it count.
 */
function revenueFigures(instructorId: number, since?: Date) {
  const scope = and(
    eq(courses.instructorId, instructorId),
    // Timestamps are ISO-8601 UTC strings, so string order is time order.
    since ? gte(purchases.createdAt, since.toISOString()) : undefined
  );

  const perCourse = db
    .select({
      courseId: purchases.courseId,
      revenue: sum(purchases.amountPaid).mapWith(Number),
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(scope)
    .groupBy(purchases.courseId)
    .all();

  return {
    byCourse: new Map(perCourse.map((r) => [r.courseId, r.revenue])),
    // Every purchase belongs to exactly one course, so totals are the sum.
    total: perCourse.reduce((acc, r) => acc + r.revenue, 0),
  };
}

type CompletionFigures = {
  completionRate: number | null;
  averageProgress: number | null;
};

const NO_COMPLETION_DATA: CompletionFigures = {
  completionRate: null,
  averageProgress: null,
};

/**
 * Completion rate and average progress, as fractions in [0, 1].
 *
 * The unit is an enrolled (student, course) pair. Each pair's progress is the
 * share of the course's current lessons the student has completed; a pair is
 * complete when that share is 1. Courses without lessons or without enrolled
 * students have no pairs, so their figures are `null`. The totals aggregate
 * over every pair of every course rather than averaging per-course figures.
 */
function completionFigures(instructorId: number): {
  byCourse: Map<number, CompletionFigures>;
  total: CompletionFigures;
} {
  const ownCourse = eq(courses.instructorId, instructorId);

  // Enrollments carry no uniqueness constraint, so collapse duplicates.
  const enrolled = db
    .selectDistinct({
      userId: enrollments.userId,
      courseId: enrollments.courseId,
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(ownCourse)
    .as("enrolled");

  const lessonTotals = db
    .select({
      courseId: modules.courseId,
      lessonCount: count(lessons.id).as("lesson_count"),
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(ownCourse)
    .groupBy(modules.courseId)
    .as("lesson_totals");

  // Distinct lessons, in case a lesson has several progress rows.
  const completedLessons = db
    .select({
      userId: lessonProgress.userId,
      courseId: modules.courseId,
      completed: countDistinct(lessonProgress.lessonId).as("completed"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(
      and(ownCourse, eq(lessonProgress.status, LessonProgressStatus.Completed))
    )
    .groupBy(lessonProgress.userId, modules.courseId)
    .as("completed_lessons");

  // One row per enrolled pair in a course that has lessons.
  const pairs = db
    .select({
      courseId: enrolled.courseId,
      share:
        sql<number>`1.0 * coalesce(${completedLessons.completed}, 0) / ${lessonTotals.lessonCount}`.as(
          "share"
        ),
    })
    .from(enrolled)
    .innerJoin(lessonTotals, eq(lessonTotals.courseId, enrolled.courseId))
    .leftJoin(
      completedLessons,
      and(
        eq(completedLessons.userId, enrolled.userId),
        eq(completedLessons.courseId, enrolled.courseId)
      )
    )
    .as("pairs");

  const figures = {
    completionRate: sql<
      number | null
    >`avg(case when ${pairs.share} >= 1 then 1.0 else 0.0 end)`,
    averageProgress: sql<number | null>`avg(${pairs.share})`,
  };

  const perCourse = db
    .select({ courseId: pairs.courseId, ...figures })
    .from(pairs)
    .groupBy(pairs.courseId)
    .all();

  const total = db.select(figures).from(pairs).get();

  return {
    byCourse: new Map(
      perCourse.map(({ courseId, ...courseFigures }) => [
        courseId,
        courseFigures,
      ])
    ),
    total: total ?? NO_COMPLETION_DATA,
  };
}
