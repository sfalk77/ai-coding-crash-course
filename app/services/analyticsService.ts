import { count, countDistinct, eq, gte, min } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, lessons, modules } from "~/db/schema";

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

  return {
    totals: {
      students: totalStudents?.count ?? 0,
      newEnrollments: newInWindow?.total ?? null,
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
